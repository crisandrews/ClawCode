# Cron persistence

ClawCode maintains a workspace-level **cron registry** at `memory/crons.json`. It is the source of truth for every scheduled task the user wants alive across sessions.

## Why this exists

Claude Code's `CronCreate` tool creates in-memory scheduled tasks that **die when the session ends**. The tool description itself says so:

> Jobs live only in this Claude session — nothing is written to disk, and the job is gone when Claude exits.

The `durable: true` parameter promises `.claude/scheduled_tasks.json` persistence, but in practice it's a no-op — only a stale `.lock` file is left behind. This meant that heartbeat, dreaming, imported OpenClaw reminders, and ad-hoc "remind me in 2h" crons all silently disappeared between sessions.

The registry + reconcile pattern solves this: every cron the user creates is tracked in `memory/crons.json`; at the start of every session, a hook calls `CronList` against the harness, sees what's missing, and recreates it.

## User commands

All via `/agent:crons` — but the skill **also auto-loads on natural-language requests** for any future-time commitment, in any conversation language and on any channel (CLI, WhatsApp, Telegram, etc.):

- "recordame en 5 minutos comprar pan" / "remind me in 5 minutes to buy bread"
- "avísame mañana a las 9" / "wake me up tomorrow at 9"
- "todos los lunes a las 8 hazme acordar X" / "every Monday at 8 remind me X"
- "cada 30 minutos chequeá Y" / "every 30 minutes check Y"

| Command | What it does |
|---|---|
| `/agent:crons list` | Show all reminders with status (✅ alive, ⚠️ missing, ⏸ paused). |
| `/agent:crons add` (or natural language) | Create a reminder. Persists across sessions. The agent calls `bin/cron-from.sh` for time math; never invents the cron expression. |
| `/agent:crons delete <key|N>` | Remove with `AskUserQuestion` confirmation. |
| `/agent:crons pause <key>` | Stop without deleting (registry entry kept). |
| `/agent:crons resume <key>` | Re-enable a paused reminder. |
| `/agent:crons reconcile` | Force a manual sync (same as SessionStart does automatically). |
| `/agent:crons import` | Import OpenClaw crons from `~/.openclaw/cron/jobs.json`. |

## Time arithmetic — `bin/cron-from.sh`

Reminders coming from natural language ("in 3 minutes", "tomorrow at 9am", "every Monday") need to be turned into a 5-field cron expression. **The agent never does this math itself.** LLMs miscompute timezones inconsistently (sometimes UTC, sometimes local), and the cron daemon interprets expressions in the host's LOCAL time — a mismatch silently fires reminders 4+ hours late or never.

The `bin/cron-from.sh` helper is the single source of truth. It:
- Reads the host clock as epoch seconds (timezone-independent)
- Reformats into cron fields using the host's local timezone
- Returns single-line JSON: `{"cron": "...", "human_local": "...", "iso_local": "...", "epoch": ..., "recurring": ..., "kind": "..."}`

| User intent | Helper call | Example output cron |
|---|---|---|
| "in 3 minutes" | `cron-from.sh relative 3 minutes` | `25 13 19 4 *` |
| "in 2 hours" | `cron-from.sh relative 2 hours` | `25 15 19 4 *` |
| "at 14:30" today | `cron-from.sh absolute "14:30"` | `30 14 19 4 *` (rolls to tomorrow if past) |
| "tomorrow at 9am" | `cron-from.sh absolute "09:00" tomorrow` | `0 9 20 4 *` |
| "every day at 8am" | `cron-from.sh recurring daily "08:00"` | `0 8 * * *` |
| "every Monday at 9am" | `cron-from.sh recurring weekly mon "09:00"` | `0 9 * * 1` |
| "every 30 minutes" | `cron-from.sh recurring every 30 minutes` | `*/30 * * * *` |
| "every 2 hours" | `cron-from.sh recurring every 2 hours` | `0 */2 * * *` |

The skill (`skills/crons/SKILL.md`) instructs the agent to map user intent to one of these calls and pass the helper's `.cron` output verbatim to `CronCreate`. The `.human_local` field is used for the user-facing confirmation, so the time the agent shows always matches what the daemon will actually fire.

The helper supports BSD `date` (macOS) and GNU `date` (Linux) — detected at runtime. DST transitions are handled by the system tzdata.

## Registry schema

`memory/crons.json`:

```jsonc
{
  "version": 1,
  "updatedAt": "2026-04-13T15:00:00Z",
  "migration": { "openclawOffered": false, "openclawAnsweredAt": null },
  "entries": [
    {
      "key": "heartbeat-default",
      "cron": "*/30 * * * *",
      "prompt": "Run /agent:heartbeat",
      "recurring": true,
      "source": "default-heartbeat",
      "note": "Default 30-min heartbeat",
      "createdAt": "2026-04-13T15:00:00Z",
      "lastSeenAlive": "2026-04-13T15:00:00Z",
      "harnessTaskId": "abc12345",
      "paused": false,
      "tombstone": null,
      "adoptedAt": null
    }
  ]
}
```

### Field reference

| Field | Meaning |
|---|---|
| `key` | Stable logical ID. Defaults use fixed keys; OpenClaw uses `openclaw-<uuid>`; ad-hoc uses `harness-<taskId>`. |
| `cron` | 5-field cron expression in local time. |
| `prompt` | The prompt the cron will enqueue when it fires. |
| `recurring` | `true` = fires every match; `false` = one-shot. |
| `source` | Enum: `default-heartbeat`, `default-dreaming`, `openclaw-import`, `agent-onboarding`, `backlog-reminder`, `ad-hoc`, `user-manual`. |
| `harnessTaskId` | The 8-hex ID assigned by Claude Code when the cron was created. Changes every reconcile. |
| `lastSeenAlive` | Last time the reconcile flow confirmed this cron was alive in `CronList`. |
| `paused` | `true` → skipped by reconcile until resumed. |
| `tombstone` | ISO timestamp if user deleted. Non-null entries are skipped by reconcile (resurrection-proof). Purged after 30 days. |
| `adoptedAt` | Non-null if the entry came from `adopt-unknown` (a cron that existed in harness but not in registry — e.g., hook crashed). |

## How it works

### Components

- **`bin/cron-from.sh`** — deterministic cron expression generator (see "Time arithmetic" above). Pure bash + jq; no LLM math. Single source of truth for converting natural-language times into cron expressions in host-local TZ.
- **`skills/crons/writeback.sh`** — the sole writer to the registry. Subcommands: `seed-defaults`, `upsert`, `tombstone`, `set-alive`, `adopt-unknown`, `pause`, `resume`, `migration-mark`. Atomic write (tmp-file + mv), lockfile-protected (`memory/.crons-lock/`).
- **`hooks/reconcile-crons.sh`** — SessionStart. Seeds defaults, cleans legacy `.crons-created`, detects migration need, emits a reconcile envelope for the agent to execute.
- **`hooks/cron-posttool.sh`** — PostToolUse. Captures ad-hoc `CronCreate` (as `source: ad-hoc`) and tombstones on `CronDelete`. Tolerant of v2.1.114 and legacy harness response formats. Suppressed when `memory/.reconciling` marker is present (prevents duplicates during reconcile / import batches).
- **`skills/crons/SKILL.md`** — agent-facing dispatcher. Routes subcommand phrasings (and natural-language requests) to the right flow, calls `bin/cron-from.sh` for time math, then `CronCreate` / `CronDelete` as needed.

### Session-start flow

```
1. hooks/reconcile-crons.sh (SessionStart)
   a. Inject identity (SOUL/IDENTITY/USER)
   b. writeback.sh seed-defaults  (idempotent if valid; quarantines+rebuilds if corrupt)
   c. Remove legacy .crons-created marker
   d. Detect migration (IMPORT_BACKLOG.md + ~/.openclaw/cron/jobs.json + unanswered)
   e. touch memory/.reconciling  (recursion guard for PostToolUse)
   f. Build reconcile envelope with EXPECTED entries; emit atomically

2. Agent executes the envelope
   - ToolSearch → CronList → CronCreate missing → writeback.sh set-alive → adopt-unknown → print summary → rm .reconciling
   - If migration STEP 7 is present, agent calls AskUserQuestion and handles answer
```

### Ad-hoc capture flow

```
User: "remind me in 4 hours to exercise"
  → Agent calls CronCreate(cron="...", prompt="...", durable=true)
  → PostToolUse hook fires → cron-posttool.sh
    - If memory/.reconciling is fresh (<10 min): skip (we're reconciling)
    - Else: parse task_id from response → upsert into registry as source=ad-hoc
```

### Failure modes (all non-blocking)

| Failure | Behavior |
|---|---|
| `memory/crons.json` corrupt | Writeback quarantines to `.corrupt-<ts>` and rebuilds from defaults. |
| `jq` not installed | Reconcile emits a degraded envelope with only the two defaults. |
| CronCreate fails for one entry | Logged to `memory/crons-errors.jsonl`. Next reconcile retries. |
| Hook itself errors | Exit 0 with a warning. Session start is never blocked. |
| `CronList` format changes upstream | Regex parser aborts loudly (`harness shape drift`). |
| Two sessions on same workspace | Lock (`memory/.crons-lock/`) prevents race; second session skips its reconcile. |

## Harness assumptions (verified empirically 2026-04-13)

Probed `CronCreate` / `CronList` / `CronDelete` schemas + live calls:

1. **Full Cron\* tool surface:** exactly three tools exist — `CronCreate`, `CronList`, `CronDelete`.
2. **`CronCreate` main description contradicts its `durable` parameter.** Main text says *"nothing is written to disk"*; the flag claims to persist. Empirical check confirms the main description is authoritative.
3. **`CronCreate` response format:** `Scheduled <recurring|one-shot> job <8hex-id> (<cron-expr>). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner.`
4. **`CronList` response format (text, one line per job):** `<8hex-id> — <cron-expr> (recurring|one-shot) [session-only|durable]: <prompt>`. Empty = the literal string `No scheduled jobs.`.
5. **Task IDs are 8 hex chars** (~4B namespace).
6. **`CronList` includes the full `prompt`** → adoption is lossless.
7. **Recurring tasks auto-expire after 7 days** in the harness. Reconcile recreates them.

## What the fix does NOT do

- **Does not revive crons created before the fix was installed.** Pre-fix ad-hoc crons were never persisted anywhere — they can't be recovered. Users need to recreate them.
- **Does not run crons while Claude Code is closed.** For 24/7, use `/agent:service install` (launchd/systemd wrapper).
- **Does not bypass the 7-day harness auto-expiration.** Each session's reconcile recreates them, so effectively they always appear alive — but if a workspace goes untouched >7 days, the harness forgets them; the next session resurrects.

## User-facing management

### Doctor check

`/agent:doctor` now reports on the registry:

```
Cron registry · 5 active · 1 paused · 2 tombstoned
jq · jq available in PATH
```

If stale tombstones (>30 days) are found, doctor flags as warn and suggests `/agent:crons reconcile` to prune.

### Audit trail

- `memory/crons-pending.jsonl` — one line per captured PostToolUse event (for debugging).
- `memory/crons-errors.jsonl` — any writeback failures during reconcile.
- `memory/crons.json.corrupt-<ts>` — quarantined bad registries (manual cleanup when safe).

## Relation to other features

- **Service / 24/7:** `/agent:service install` wraps Claude Code in launchd/systemd. With it, the REPL is always running, so crons fire on schedule. Without it, crons only fire while a REPL is open (as documented). Registry persistence solves a different problem (reminders surviving restarts) — the service is orthogonal.
- **Heartbeat / dreaming:** the two built-in recurring tasks (`heartbeat-default` every 30 min, `dreaming-default` at 3 AM) are seeded automatically. User can pause/resume/delete them like any other reminder.
- **Import flow (`/agent:import`):** Step B uses `writeback.sh seed-defaults`. Step D.5 and E.3 use `writeback.sh upsert` with explicit `--source openclaw-import` / `--source backlog-reminder` keys, and suppress PostToolUse via the `.reconciling` marker to avoid duplicate capture.
