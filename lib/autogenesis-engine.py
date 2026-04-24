#!/usr/bin/env python3
"""
Autogenesis Engine — SEPL Reflect/Select/Improve cycle for ClawCode.

Runs inside the 3am dream cycle with ZERO LLM tokens.
Reads priors.json from the learning engine, identifies underperforming
event types, maps them to skills, and generates improvement proposals
stored in memory/autogenesis/pending.json for Claude to review and apply.

Usage:
  python3 autogenesis-engine.py --memory-dir <path> --skill-dir <path>
  python3 autogenesis-engine.py --memory-dir <path> --skill-dir <path> --dry-run
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

PRIORS_FILE = "learning/priors.json"
PENDING_FILE = "autogenesis/pending.json"
REPORTS_DIR = "autogenesis/reports"

RESPONSE_RATE_THRESHOLD = 0.40   # below this → candidate for improvement
MIN_OCCURRENCES = 2               # minimum observed events to consider
MIN_NOTIFIED = 1                  # must have been notified at least once

# Maps event types (from learning engine) → skill names to improve
EVENT_SKILL_MAP: dict[str, list[str]] = {
    "CI_failure":       ["heartbeat"],
    "domain_expiry":    ["heartbeat"],
    "service_down":     ["heartbeat"],
    "payment_overdue":  ["heartbeat"],
}

# ---------------------------------------------------------------------------
# Phase 1: Reflect — identify underperforming event types
# ---------------------------------------------------------------------------

def load_priors(memory_dir: Path) -> dict:
    p = memory_dir / PRIORS_FILE
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def reflect(priors: dict) -> list[dict]:
    """Read priors, return hypothesis list for underperforming event types."""
    hypotheses = []
    for event_type, stats in priors.items():
        occurrences = stats.get("total_occurrences_30d", 0)
        notified = stats.get("notified_count_30d", 0)
        rate = stats.get("response_rate", 1.0)

        if occurrences < MIN_OCCURRENCES:
            continue
        if notified < MIN_NOTIFIED:
            continue
        if rate >= RESPONSE_RATE_THRESHOLD:
            continue

        severity = "HIGH" if rate < 0.10 else "MEDIUM"
        hypotheses.append({
            "event_type":    event_type,
            "response_rate": round(rate, 3),
            "occurrences":   occurrences,
            "notified":      notified,
            "target_skills": EVENT_SKILL_MAP.get(event_type, ["heartbeat"]),
            "hypothesis":    _build_hypothesis(event_type, rate, stats),
            "severity":      severity,
        })
    return hypotheses


def _build_hypothesis(event_type: str, rate: float, stats: dict) -> str:
    pct = f"{rate:.0%}"
    n = stats.get("notified_count_30d", 0)
    templates = {
        "CI_failure": (
            f"CI failures are notified but the user responds only {pct} of the time "
            f"({n} notifications). The alert may lack enough context "
            f"(which repo, which job, how to fix) or the urgency score "
            f"is not high enough during typical CI failure hours."
        ),
        "domain_expiry": (
            f"Domain expiry alerts have a {pct} response rate ({n} notifications). "
            f"Alerts may arrive too early to feel urgent, or lack specific "
            f"actionable steps (transfer registrar, renew URL, deadline countdown)."
        ),
        "service_down": (
            f"Service down events have {pct} response rate ({n} notifications). "
            f"The alert may be missing key context: which service, HTTP status, "
            f"how to restart, or a direct incident ticket link."
        ),
        "payment_overdue": (
            f"Payment overdue alerts have {pct} response rate ({n} notifications). "
            f"These may get lost in briefing noise. Consider elevating to a "
            f"high-priority channel with a direct payment link and daily re-alerts."
        ),
    }
    return templates.get(event_type, (
        f"Event type '{event_type}' has {pct} response rate across "
        f"{n} notifications. The corresponding skill may need clearer "
        f"action items or better urgency framing."
    ))


# ---------------------------------------------------------------------------
# Phase 2: Select — map hypotheses to concrete skill proposals
# ---------------------------------------------------------------------------

def select(hypotheses: list[dict], skill_dir: Path) -> list[dict]:
    """Translate hypotheses into skill improvement proposals."""
    proposals = []
    today = datetime.now(timezone.utc).isoformat()[:10]

    for hyp in hypotheses:
        for skill_name in hyp["target_skills"]:
            skill_path = skill_dir / skill_name / "SKILL.md"
            if not skill_path.exists():
                continue

            current_content = skill_path.read_text(encoding="utf-8", errors="ignore")
            addition = _build_improvement(hyp["event_type"], hyp)

            # Skip if this exact addition already exists in the skill
            marker = f"## {hyp['event_type'].replace('_', ' ').title()} Response Protocol (Autogenesis"
            if marker in current_content:
                continue

            proposal_id = f"{hyp['event_type']}-{skill_name}-{today}"
            proposals.append({
                "id":              proposal_id,
                "hypothesis":      hyp,
                "skill_name":      skill_name,
                "skill_path":      str(skill_path),
                "proposed_addition": addition,
                "apply_mode":      "append",   # append | replace
                "current_chars":   len(current_content),
                "status":          "pending",
                "created_at":      datetime.now(timezone.utc).isoformat()[:16],
                "applied_at":      None,
                "applied_version": None,
            })
    return proposals


def _build_improvement(event_type: str, hyp: dict) -> str:
    """
    Template-based improvement text to append to the skill file.
    These are concrete, actionable protocol sections that the agent will
    follow when handling the event type.
    """
    title = event_type.replace("_", " ").title()
    improvements: dict[str, str] = {
        "CI_failure": (
            f"\n\n## {title} Response Protocol (Autogenesis v1 — auto-generated)\n"
            f"**Trigger:** When a CI_failure event is detected.\n\n"
            f"**Required context in every notification:**\n"
            f"- Repository name and branch\n"
            f"- Failing job name(s) and duration\n"
            f"- Commit hash and author of the breaking change\n"
            f"- Last passing run (for comparison)\n\n"
            f"**Urgency escalation rules:**\n"
            f"- ≥3 consecutive failures on `main` → notify via high-priority channel immediately\n"
            f"- Failures persisting >2h → create incident ticket and mention in next briefing\n\n"
            f"**Suggested fixes to include:**\n"
            f"- Dependency update? Check lock file diff\n"
            f"- Formatting failure? Include `cargo fmt` / `prettier` command\n"
            f"- Test isolation? Flag flaky test pattern\n"
        ),
        "domain_expiry": (
            f"\n\n## {title} Response Protocol (Autogenesis v1 — auto-generated)\n"
            f"**Trigger:** When a domain_expiry event is detected.\n\n"
            f"**Required context in every notification:**\n"
            f"- Exact expiry date and days remaining (countdown)\n"
            f"- Current registrar name and direct renewal URL\n"
            f"- Transfer steps if switching registrar (nameservers, auth code)\n\n"
            f"**Urgency escalation rules:**\n"
            f"- ≤10 days → include in daily briefing AND high-priority channel\n"
            f"- ≤5 days  → re-alert every 24h until resolved\n"
            f"- ≤2 days  → escalate to highest-priority notification channel\n\n"
            f"**Do not notify only once** — re-alert every 24h if no action taken.\n"
        ),
        "service_down": (
            f"\n\n## {title} Response Protocol (Autogenesis v1 — auto-generated)\n"
            f"**Trigger:** When a service_down event is detected.\n\n"
            f"**Required context in every notification:**\n"
            f"- Service name, URL, and HTTP status code\n"
            f"- Duration of downtime (time since last successful health check)\n"
            f"- Last known healthy timestamp\n"
            f"- Restart command or runbook link\n\n"
            f"**Urgency escalation rules:**\n"
            f"- Any service_down → notify via high-priority channel (never just log)\n"
            f"- Down >1h → create incident ticket\n"
            f"- Down >4h → escalate to highest-priority notification channel\n\n"
            f"**Do not mark as resolved** until the health check confirms HTTP 200.\n"
        ),
        "payment_overdue": (
            f"\n\n## {title} Response Protocol (Autogenesis v1 — auto-generated)\n"
            f"**Trigger:** When a payment_overdue event is detected.\n\n"
            f"**Required context in every notification:**\n"
            f"- Vendor name, amount owed, currency, and days overdue\n"
            f"- Service at risk and consequence of non-payment (cutoff date)\n"
            f"- Direct payment URL or account login\n\n"
            f"**Urgency escalation rules:**\n"
            f"- Large amounts → notify via high-priority channel immediately\n"
            f"- Overdue >7 days  → include in EVERY daily briefing until paid\n"
            f"- Overdue >14 days → escalate to highest-priority notification channel\n\n"
            f"**Re-alert daily** (not weekly) until payment is confirmed.\n"
        ),
    }
    return improvements.get(event_type, (
        f"\n\n## {title} Response Protocol (Autogenesis v1 — auto-generated)\n"
        f"**Trigger:** When a {event_type} event is detected.\n\n"
        f"Response rate for this event type is low. Improvements:\n"
        f"- Include specific action items (not just descriptions)\n"
        f"- Add direct links to resolve the underlying issue\n"
        f"- Use high-priority channel for HIGH urgency events (do not queue)\n"
        f"- Re-alert every 24h if no action is taken\n"
    ))


# ---------------------------------------------------------------------------
# Phase 3: Persist proposals
# ---------------------------------------------------------------------------

def save_pending(memory_dir: Path, proposals: list[dict]) -> int:
    """Merge new proposals into pending.json. Returns count of new proposals added."""
    pending_path = memory_dir / PENDING_FILE
    pending_path.parent.mkdir(parents=True, exist_ok=True)

    existing: list[dict] = []
    if pending_path.exists():
        try:
            existing = json.loads(pending_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = []

    existing_ids = {e["id"] for e in existing}
    new_proposals = [p for p in proposals if p["id"] not in existing_ids]
    pending_path.write_text(
        json.dumps(existing + new_proposals, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    return len(new_proposals)


def write_report(memory_dir: Path, hypotheses: list[dict], proposals: list[dict]) -> None:
    reports_dir = memory_dir / REPORTS_DIR
    reports_dir.mkdir(parents=True, exist_ok=True)
    report_path = reports_dir / f"{datetime.now().isoformat()[:10]}.md"

    with open(report_path, "a", encoding="utf-8") as f:
        f.write(f"\n## Autogenesis Reflect Cycle — {datetime.now().isoformat()[:16]}\n\n")
        f.write(f"- Hypotheses generated: {len(hypotheses)}\n")
        f.write(f"- Proposals queued: {len(proposals)}\n\n")
        for h in hypotheses:
            f.write(f"### {h['event_type']} (rate={h['response_rate']:.0%}, {h['severity']})\n")
            f.write(f"{h['hypothesis']}\n\n")
            skills = ", ".join(f"`{s}`" for s in h["target_skills"])
            f.write(f"Target skills: {skills}\n\n")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="ClawCode Autogenesis Engine")
    parser.add_argument("--memory-dir", required=True, help="Path to memory/ directory")
    parser.add_argument("--skill-dir",  required=True, help="Path to skills/ directory")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    args = parser.parse_args()

    memory_dir = Path(args.memory_dir)
    skill_dir  = Path(args.skill_dir)

    priors = load_priors(memory_dir)
    if not priors:
        print(json.dumps({"status": "no_priors", "hypotheses": 0, "proposals_new": 0}))
        return

    hypotheses = reflect(priors)
    proposals  = select(hypotheses, skill_dir)

    if args.dry_run:
        print(json.dumps({
            "dry_run":    True,
            "hypotheses": len(hypotheses),
            "proposals":  len(proposals),
            "details":    proposals,
        }, indent=2, ensure_ascii=False))
        return

    new_count = save_pending(memory_dir, proposals)
    write_report(memory_dir, hypotheses, proposals)

    print(json.dumps({
        "status":           "ok",
        "hypotheses":       len(hypotheses),
        "proposals_new":    new_count,
        "proposals_total":  len(proposals),
    }, indent=2))


if __name__ == "__main__":
    main()
