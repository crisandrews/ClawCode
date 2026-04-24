#!/usr/bin/env python3
"""
Learning Engine — behavioral pattern extraction for the assistant system.

Runs inside the 3am dream cycle (zero LLM tokens). Reads SIGNAL tags from
memory .md files, updates priors.json via EMA, and persists raw events in
engagement.sqlite.

Usage:
  python3 learning-engine.py [--memory-dir <path>] [--dry-run]

Signal format in .md files:
  <!-- SIGNAL: type=CI_failure urgency=HIGH notified=true ts=2026-04-18T09:00 -->
  <!-- SIGNAL: type=CI_failure pablo_responded=true response_delay_min=12 ts=2026-04-18T09:12 -->
"""

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DEFAULT_MEMORY_DIR = Path.home() / "Documents/colabs/memory"
PRIORS_FILE = "learning/priors.json"
SQLITE_FILE = "learning/engagement.sqlite"
INSIGHTS_FILE = "learning/weekly-insights.md"

# ---------------------------------------------------------------------------
# Signal extraction
# ---------------------------------------------------------------------------

SIGNAL_RE = re.compile(
    r"<!--\s*SIGNAL:\s*(.*?)\s*-->",
    re.IGNORECASE,
)

ATTR_RE = re.compile(r'(\w+)=([^\s"]+|"[^"]*")')


def parse_signal_tag(raw: str) -> dict:
    """Parse key=value pairs from a SIGNAL comment body."""
    attrs = {}
    for m in ATTR_RE.finditer(raw):
        key = m.group(1)
        val = m.group(2).strip('"')
        # coerce booleans and numbers
        if val.lower() == "true":
            val = True
        elif val.lower() == "false":
            val = False
        else:
            try:
                val = int(val)
            except ValueError:
                try:
                    val = float(val)
                except ValueError:
                    pass
        attrs[key] = val
    return attrs


def extract_signals_from_file(path: Path) -> list[dict]:
    """Extract all SIGNAL tags from a single .md file."""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    signals = []
    for m in SIGNAL_RE.finditer(text):
        attrs = parse_signal_tag(m.group(1))
        if "type" not in attrs:
            continue
        attrs["_source_file"] = str(path.name)
        signals.append(attrs)
    return signals


def collect_signals(memory_dir: Path, since_days: int = 7) -> list[dict]:
    """Collect signals from .md files modified in the last N days."""
    now = datetime.now().timestamp()
    cutoff = now - since_days * 86400
    signals = []
    for p in sorted(memory_dir.glob("*.md")):
        if p.stat().st_mtime < cutoff:
            continue
        signals.extend(extract_signals_from_file(p))
    return signals


# ---------------------------------------------------------------------------
# SQLite engagement log
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    urgency     TEXT,
    notified    INTEGER,
    responded   INTEGER,
    delay_min   INTEGER,
    source_file TEXT,
    raw_attrs   TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_type ON signals(event_type);
CREATE INDEX IF NOT EXISTS idx_ts ON signals(ts);
"""


def open_db(memory_dir: Path) -> sqlite3.Connection:
    db_path = memory_dir / SQLITE_FILE
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def insert_signal(conn: sqlite3.Connection, sig: dict) -> None:
    ts = sig.get("ts") or datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO signals
           (ts, event_type, urgency, notified, responded, delay_min, source_file, raw_attrs)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            ts,
            sig.get("type", "unknown"),
            sig.get("urgency"),
            1 if sig.get("notified") else 0,
            1 if sig.get("pablo_responded") else 0,
            sig.get("response_delay_min"),
            sig.get("_source_file"),
            json.dumps({k: v for k, v in sig.items() if not k.startswith("_")}),
        ),
    )


def already_logged(conn: sqlite3.Connection, sig: dict) -> bool:
    """Skip duplicate signals (same type + ts + source_file)."""
    ts = sig.get("ts", "")
    if not ts:
        return False
    row = conn.execute(
        "SELECT 1 FROM signals WHERE event_type=? AND ts=? AND source_file=? LIMIT 1",
        (sig.get("type", "unknown"), ts, sig.get("_source_file", "")),
    ).fetchone()
    return row is not None


# ---------------------------------------------------------------------------
# Prior computation
# ---------------------------------------------------------------------------

EMA_ALPHA = 0.30  # 30% new data, 70% historical


def load_priors(memory_dir: Path) -> dict:
    p = memory_dir / PRIORS_FILE
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            pass
    return {}


def save_priors(memory_dir: Path, priors: dict) -> None:
    p = memory_dir / PRIORS_FILE
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(priors, indent=2, ensure_ascii=False))


def compute_event_stats(conn: sqlite3.Connection, event_type: str, lookback_days: int = 30) -> dict:
    """Compute response_rate and avg_delay_min for a given event type."""
    cutoff = datetime.now(timezone.utc).isoformat()[:10]  # YYYY-MM-DD
    rows = conn.execute(
        """SELECT notified, responded, delay_min
           FROM signals
           WHERE event_type=?
             AND ts >= date('now', ?)
        """,
        (event_type, f"-{lookback_days} days"),
    ).fetchall()

    if not rows:
        return {}

    notified_count = sum(1 for r in rows if r[0])
    responded_count = sum(1 for r in rows if r[1])
    delays = [r[2] for r in rows if r[2] is not None]

    response_rate = responded_count / notified_count if notified_count else 0.0
    avg_delay = sum(delays) / len(delays) if delays else None
    total_occurrences = len(rows)

    return {
        "response_rate": round(response_rate, 3),
        "avg_response_delay_min": round(avg_delay, 1) if avg_delay is not None else None,
        "total_occurrences_30d": total_occurrences,
        "notified_count_30d": notified_count,
    }


def update_priors(memory_dir: Path, conn: sqlite3.Connection) -> dict:
    """Recompute priors for all known event types using EMA."""
    priors = load_priors(memory_dir)

    event_types = [
        r[0]
        for r in conn.execute("SELECT DISTINCT event_type FROM signals").fetchall()
    ]

    updated = 0
    for etype in event_types:
        stats = compute_event_stats(conn, etype)
        if not stats:
            continue

        existing = priors.get(etype, {})

        # EMA blend for response_rate
        old_rate = existing.get("response_rate", stats["response_rate"])
        new_rate = EMA_ALPHA * stats["response_rate"] + (1 - EMA_ALPHA) * old_rate

        priors[etype] = {
            **existing,
            **stats,
            "response_rate": round(new_rate, 3),
            "updated_at": datetime.now(timezone.utc).isoformat()[:16],
        }
        updated += 1

    return priors, updated


# ---------------------------------------------------------------------------
# Notify scoring (used by heartbeat at runtime)
# ---------------------------------------------------------------------------

# Time-of-day engagement weights (hour → weight)
TIME_WEIGHTS: dict[int, float] = {
    6: 1.4, 7: 1.3,                      # morning briefing
    8: 1.0, 9: 1.5, 10: 1.5, 11: 1.4,   # execution block
    12: 0.9, 13: 0.8,                     # post-lunch
    14: 1.0, 15: 1.0, 16: 1.0, 17: 0.9, # afternoon
    18: 0.7, 19: 0.5,                     # wind-down
    20: 0.2, 21: 0.3, 22: 0.1,           # gym / ops
    23: 0.1, 0: 0.0, 1: 0.0, 2: 0.0,
    3: 0.0, 4: 0.0, 5: 0.2,
}

URGENCY_BASE: dict[str, float] = {
    "HIGH": 1.0,
    "MEDIUM": 0.6,
    "LOW": 0.3,
}

NOTIFY_THRESHOLD = 0.55


def should_notify(event_type: str, urgency: str, priors: dict, hour: Optional[int] = None) -> dict:
    """
    Score an event and return whether to notify Pablo.
    Used by heartbeat agents at runtime.
    """
    if hour is None:
        hour = datetime.now().hour

    base = URGENCY_BASE.get(urgency.upper(), 0.5)
    time_w = TIME_WEIGHTS.get(hour, 0.5)
    event_priors = priors.get(event_type, {})
    response_rate = event_priors.get("response_rate", 0.5)  # default: neutral

    score = base * time_w * (0.5 + 0.5 * response_rate)

    return {
        "notify": score >= NOTIFY_THRESHOLD,
        "score": round(score, 3),
        "base_urgency": base,
        "time_weight": time_w,
        "response_rate": response_rate,
        "threshold": NOTIFY_THRESHOLD,
    }


# ---------------------------------------------------------------------------
# Main dream cycle runner
# ---------------------------------------------------------------------------

def run_dream(memory_dir: Path, dry_run: bool = False) -> dict:
    """Full learning cycle — called from 3am dream cron."""
    print(f"[learning-engine] Starting dream cycle — {datetime.now().isoformat()[:16]}")
    print(f"[learning-engine] Memory dir: {memory_dir}")

    # 1. Collect signals from last 7 days of .md files
    signals = collect_signals(memory_dir, since_days=7)
    print(f"[learning-engine] Found {len(signals)} raw signals")

    if dry_run:
        print("[learning-engine] DRY RUN — no writes")
        for s in signals[:10]:
            print(f"  {s}")
        return {"dry_run": True, "signals_found": len(signals)}

    # 2. Persist new signals to SQLite
    conn = open_db(memory_dir)
    new_count = 0
    for sig in signals:
        if not already_logged(conn, sig):
            insert_signal(conn, sig)
            new_count += 1
    conn.commit()
    print(f"[learning-engine] Persisted {new_count} new signals to engagement.sqlite")

    # 3. Update priors via EMA
    priors, updated_count = update_priors(memory_dir, conn)
    save_priors(memory_dir, priors)
    print(f"[learning-engine] Updated {updated_count} event type priors")

    conn.close()

    # 4. Append run summary to weekly-insights.md
    summary_path = memory_dir / INSIGHTS_FILE
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    with open(summary_path, "a") as f:
        f.write(f"\n## Dream Run — {datetime.now().isoformat()[:16]}\n")
        f.write(f"- Signals collected: {len(signals)} ({new_count} new)\n")
        f.write(f"- Event types updated: {updated_count}\n")
        for etype, p in priors.items():
            f.write(f"- `{etype}`: response_rate={p.get('response_rate', '?')} "
                    f"occurrences={p.get('total_occurrences_30d', '?')}\n")

    return {
        "signals_collected": len(signals),
        "new_signals": new_count,
        "priors_updated": updated_count,
        "priors": priors,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="ClawCode Learning Engine")
    parser.add_argument("--memory-dir", default=str(DEFAULT_MEMORY_DIR),
                        help="Path to memory/ directory")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse signals without writing anything")
    parser.add_argument("--score", nargs=3, metavar=("EVENT_TYPE", "URGENCY", "HOUR"),
                        help="Score a hypothetical event: --score CI_failure HIGH 9")
    args = parser.parse_args()

    memory_dir = Path(args.memory_dir)

    if args.score:
        etype, urgency, hour = args.score
        priors = load_priors(memory_dir)
        result = should_notify(etype, urgency, priors, int(hour))
        print(json.dumps(result, indent=2))
        return

    result = run_dream(memory_dir, dry_run=args.dry_run)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
