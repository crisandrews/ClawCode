# HEARTBEAT.md — What to Check Every 30 Minutes

This file is YOUR checklist. The agent reads it on every heartbeat and follows it strictly.

**You can edit this file anytime** — add checks, remove old ones, adjust priorities. The agent picks up changes on the next heartbeat. Keep it short to limit token burn.

## Active checks (rotate through these, 2-4 per heartbeat)

- **Memory consolidation** — review last 3 daily logs, distill insights into MEMORY.md
- **Dream review** — run `dream(action='status')`, note high-recall memories not yet promoted

## When to notify the user

- Something important needs attention (urgent email, upcoming deadline, health alert)
- A scheduled task failed or is overdue
- A reminder the user asked for is due
- Something interesting was found during a proactive check

## When to stay quiet

- Nothing new since last check
- Late night (23:00–08:00) unless urgent
- User is clearly in the middle of something
- You just checked less than 30 minutes ago

## Proactive work (do WITHOUT asking)

- Read and organize memory files
- Update `memory/MEMORY.md` with distilled learnings from daily logs
- Remove outdated info from MEMORY.md
- Check git status of the workspace
- Verify imported skills/crons are working

## State tracking

Track when you last checked each item in `memory/heartbeat-state.json`:
```json
{
  "lastChecks": {
    "memory-consolidation": 1703275200,
    "dream-review": 1703260800
  },
  "lastHeartbeat": 1703275200
}
```

Read this file at the start of each heartbeat to avoid repeating checks. Update it after each run.

## Adding your own checks

During normal conversations, if something needs periodic attention, **edit this file** to add it. Examples:

- User says "check my emails every few hours" → add `- **Email inbox** — check for urgent unread messages`
- User installs a health skill → add `- **Health alerts** — check for pending health-alert.flag`
- User has a project deadline → add `- **Project X deadline (May 15)** — check progress, remind if behind`
- User connects WhatsApp → add `- **Pending messages** — check chat_inbox_read for unanswered messages`

**Tip:** Batch similar checks here instead of creating separate cron jobs. Heartbeats are cheaper (one turn every 30 min) than multiple crons.

When the check is no longer needed, remove it from this file. Keep the list lean.
