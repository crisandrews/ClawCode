---
name: heartbeat
description: Run agent heartbeat — periodic checks, memory consolidation, proactive work. Triggers on /agent:heartbeat, "heartbeat", "heartbeat check", "periodic check", "consolidar memoria".
user-invocable: true
---

# Heartbeat

Run the agent's periodic checks. Triggered every 30 minutes by a local cron, or manually.

## How it works

1. **Check active hours** — read `agent-config.json` for `heartbeat.activeHours`. If outside the window, skip silently.

2. **Load state** — read `memory/heartbeat-state.json` (if exists) to know when each check last ran. Avoid repeating checks done less than 30 min ago.

3. **Read HEARTBEAT.md** — this is the checklist. Follow it strictly. Do not infer or repeat old tasks from prior conversations. If nothing in the checklist needs attention, skip to step 6.

4. **Execute checks** — rotate through the items in HEARTBEAT.md, doing 2-4 per heartbeat (not all every time). For each:
   - Memory consolidation: review last 3 daily logs → distill insights → update MEMORY.md
   - Dream review: `dream(action='status')` → note high-recall items not yet promoted
   - Custom checks: whatever the user added to HEARTBEAT.md (emails, health, projects, etc.)

5. **Proactive work** (do without asking):
   - Organize memory files
   - Remove outdated entries from MEMORY.md
   - Check `IMPORT_BACKLOG.md` if it exists — remind user about pending items
   - Verify installed skills are accessible

6. **Update state** — write `memory/heartbeat-state.json` with timestamps for each check performed.

7. **Notify or stay quiet:**
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
