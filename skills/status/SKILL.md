---
name: status
description: Show agent runtime status — identity, model, context, memory, crons, voice. Works from CLI or messaging. Triggers on /status, /agent:status, "status del agente", "cómo estás técnicamente".
user-invocable: true
---

# /status — Runtime Status

Show a compact status card with everything the user needs at a glance. Works from CLI and messaging channels.

## Output format

```
👽 <Name> <emoji>
🧠 Model: <model name> (e.g. Opus 4.6)
📊 Context: <used%> · Memory: <N> files, <M> chunks · <backend>
🕐 Crons: heartbeat <schedule>, dreaming <schedule>
🔊 Voice: <tts backend> (<enabled|disabled>)
📡 Channels: <active channels or "none">
```

## Steps

1. **Call `agent_status` MCP tool** — gives identity, memory stats, dream data.

2. **Call `agent_config` MCP tool** (action='get') — gives backend, voice, http config.

3. **Get model name** — you know your own model. Use the display name (e.g. "Opus 4.6"), not the internal ID.

4. **Get context usage** — you know approximately how much context you've used in this conversation. Report it as a percentage or "low/medium/high" if exact number isn't available.

5. **Get cron info** — Bash: `ls .crons-created 2>/dev/null` to check if defaults are set up.

6. **Get channel info** — if `channels_detect` MCP tool is available, call it. Otherwise check `ls ~/.claude/plugins/cache/ 2>/dev/null` for installed plugins.

7. **Build the card** using REAL data. Never fabricate numbers.

## Format per surface

### CLI
```
👽 **Wally** 👽
🧠 Model: Opus 4.6 (1M context)
📊 Context: ~35% · Memory: 42 files, 120 chunks · builtin
🕐 Crons: heartbeat */30, dreaming 3am
🔊 Voice: say (disabled)
📡 Channels: whatsapp (installed, not authenticated)
```

### WhatsApp
Same content, `*bold*` instead of `**bold**`. No markdown headers.

### Telegram
Same content, `**bold**` is fine.

## Important

- PURELY informational — does not modify state.
- Get REAL data from MCP tools and filesystem. Never fabricate.
- For detailed cost/token info, tell the user to run native `/cost` or `/usage`.
- For MCP server details, tell the user to run native `/mcp`.
- Keep it compact — one line per category, no paragraphs.
