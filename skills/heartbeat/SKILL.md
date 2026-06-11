---
name: heartbeat
description: Run agent heartbeat — periodic checks, memory consolidation, proactive work. Triggers on /agent:heartbeat, "heartbeat", "heartbeat check", "periodic check", "consolidar memoria".
user-invocable: true
---

# Heartbeat

Run the agent's periodic checks. Triggered every 30 minutes by a local cron, or manually.

## How it works

1. **Cron health (ALWAYS — even outside active hours).** This is infrastructure, not a user-facing check; it is what heals orphaned reminders in long-running sessions (see issue #32). This step manages its own state: it reads AND writes the `cronAudit` field of `memory/heartbeat-state.json` itself, here, regardless of whether the later steps run. Every heartbeat:
   - Load the tools once per session if needed: `ToolSearch(query="select:CronList,CronCreate")`.
   - Retire fired one-shots FIRST so the repair below cannot resurrect them:
     `bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" prune-expired`
   - Call `CronList` and pipe its FULL output to:
     `bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" audit`
     (mechanical diff: refreshes `lastSeenAlive`, relinks survivors, prints `orphan key=…` / `blocked key=…` lines and an `audit: alive=K/N …` summary; exit 4 = format drift — stop, surface it, do not create anything).
   - If `orphaned=0` and `blocked=0`: clear `cronAudit.pending` in `memory/heartbeat-state.json` if set — done, say nothing.
   - If `orphaned>0`: repair `orphan key=` lines ONLY (NEVER `blocked key=` lines — those have ambiguous live duplicates; recreating them would add a third copy). `touch "$CLAUDE_PROJECT_DIR/memory/.reconciling"` (the registry's crons are replayed verbatim, so the cron-from.sh stamp gate must be bypassed), then for each orphan key: `CronCreate` with that entry's cron/prompt/recurring from `memory/crons.json` + `writeback.sh set-alive --key <key> --harness-task-id <new id>`; continue past individual failures. Then `rm -f "$CLAUDE_PROJECT_DIR/memory/.reconciling"` immediately and re-run `CronList` → `audit`.
   - **Notification throttle:** write the keys still orphaned-after-repair or blocked into `cronAudit.pending` (with a timestamp) in `memory/heartbeat-state.json`. Notify the user ONLY when the same key(s) were already in `cronAudit.pending` from the previous beat — one notice (orphans: "couldn't re-create X, run /agent:crons reconcile"; blocked: "X has duplicate live reminders, review with /agent:crons list"), then record it as notified so it doesn't repeat every beat.

2. **Check active hours** — read `agent-config.json` for `heartbeat.activeHours`. If outside the window, skip the remaining steps silently (the cron-health step above already ran).

3. **Load state** — read `memory/heartbeat-state.json` (if exists) to know when each check last ran. Avoid repeating checks done less than 30 min ago.

4. **Read HEARTBEAT.md** — this is the checklist. Follow it strictly. Do not infer or repeat old tasks from prior conversations. If nothing in the checklist needs attention, skip to step 7.

5. **Execute checks** — rotate through the items in HEARTBEAT.md, doing 2-4 per heartbeat (not all every time). For each:
   - Memory consolidation: review last 3 daily logs → distill insights → update MEMORY.md
   - Dream review: `dream(action='status')` → note high-recall items not yet promoted
   - Custom checks: whatever the user added to HEARTBEAT.md (emails, health, projects, etc.)

6. **Proactive work** (do without asking):
   - Organize memory files
   - Remove outdated entries from MEMORY.md
   - Check `IMPORT_BACKLOG.md` if it exists — remind user about pending items
   - Verify installed skills are accessible

7. **Update state** — write `memory/heartbeat-state.json` with timestamps for each check performed.

8. **Notify or stay quiet:**
   - If something needs the user's attention → notify (via reply tool if on a messaging channel, or print if CLI)
   - If nothing noteworthy → do nothing. No "heartbeat completed" messages.

## Self-managing the checklist

The agent should **edit HEARTBEAT.md during normal conversations** when something needs periodic attention:

- User says "revísame los emails cada rato" → agent adds `- **Email inbox** — check for urgent unread` to HEARTBEAT.md
- User installs a new skill with periodic needs → agent adds a check for it
- A reminder is due daily → agent adds it to HEARTBEAT.md instead of creating a separate cron
- When a check is no longer needed → agent removes it from HEARTBEAT.md

**Rule:** batch similar checks into HEARTBEAT.md instead of creating multiple cron jobs. Heartbeats are cheaper (one turn, multiple checks) than separate crons (one turn each).

## Active hours

```json
{
  "heartbeat": {
    "activeHours": {
      "start": "08:00",
      "end": "23:00",
      "timezone": "America/Santiago"
    }
  }
}
```

Outside this window, heartbeats skip silently. Configure via `/agent:settings`.

## Scheduling

Created automatically on first session (SessionStart hook):
- Default: `*/30 * * * *` (every 30 minutes)
- Only fires while Claude Code is open and REPL is idle
- For 24/7 heartbeats, use `/agent:service install`
