# Codex Runtime Notes

This workspace is using ClawCode through OpenAI Codex.

## Identity

Use `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, and `HEARTBEAT.md`
as the agent's local identity and operating context.

Never claim that Claude-specific features are available in Codex unless they
have been installed and verified in this workspace.

## Memory

Use the ClawCode MCP memory tools when available:

- `memory_search` for searching agent memory
- `memory_get` for reading cited memory lines
- `memory_context` for turn-start context
- `dream` for manual consolidation

Save durable agent memory under `memory/` in this workspace.

## Codex Compatibility

The Codex compatibility layer supports the MCP server, memory, identity files,
registry-backed reminders, the Codex service runner, voice tooling, WebChat,
doctor, and skill management.

These Claude Code features are intentionally treated as Claude-only under
Codex:

- Claude Code channel launch flags
- `CronCreate`, `CronList`, `CronDelete`
- Claude Code service mode using `claude --continue`
- Claude-specific messaging plugins such as `claude-whatsapp`

Use `/agent:service install` to install the Codex runner before claiming that
reminders or automatic dreaming are active in this workspace.
