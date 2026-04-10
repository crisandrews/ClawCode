---
name: status
description: Show agent status — identity, memory stats, dream tracking, and native Claude Code session info. Triggers on /agent:status, "status del agente", "agent status", "cómo estás".
user-invocable: true
---

# Agent Status

Show a comprehensive status dashboard combining agent-specific info and native Claude Code session state.

## Steps

1. **Call the `agent_status` MCP tool** to get:
   - Your identity (name, emoji, vibe)
   - Workspace path
   - Memory backend (builtin / QMD) and features active
   - Files and chunks indexed in memory
   - Dream tracking stats (unique memories recalled)

2. **Read `agent-config.json`** (if exists) to show:
   - Memory backend configuration
   - Heartbeat schedule and active hours
   - Dreaming schedule

3. **Check current date/time and cron status** via Bash:
   ```bash
   date
   cat .claude/scheduled_tasks.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{len(d)} crons configured')" 2>/dev/null || echo "No crons"
   ```

4. **Format the output** as a clean status dashboard:

```
🤖 <Agent Name> <emoji>

Identity: <vibe description>
Workspace: <path>

Memory:
  Backend: <backend> (<features>)
  Indexed: <N> files, <M> chunks
  Dreams: <X> unique memories recalled

Schedule:
  Heartbeat: <schedule> (active hours: <start>-<end>)
  Dreaming: <schedule>
  Crons running: <N>

For native session info (tokens, cost, model), run: /status
```

5. **Remind the user** about native Claude Code commands:
   - `/status` — native session status dialog
   - `/usage` or `/cost` — token usage
   - `/model` — current model
   - `/mcp` — MCP server connections

## Notes

- This does NOT replace `/status` (native). It complements it with agent-specific info.
- For token usage / model / cost, the user runs the native commands.
- If `agent-config.json` doesn't exist, just show defaults.
