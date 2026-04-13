# Hooks — Agent Lifecycle Events

ClawCode hooks into Claude Code's lifecycle events to inject identity, flush memory, and track sessions. These run automatically — the user doesn't invoke them.

## SessionStart

**When:** Every time a Claude Code session begins.

**What it does:**
1. Checks for `BOOTSTRAP.md` — if present, this is a first-run; triggers the bootstrap ritual
2. Injects identity by reading `SOUL.md`, `IDENTITY.md`, and `USER.md` into the conversation context
3. Checks if default crons exist (`.crons-created` marker) — if not, instructs the agent to create heartbeat (*/30 min) and dreaming (3 AM) crons

This is how the agent "wakes up as itself" every session. Without this hook, Claude would start as a generic assistant with no personality.

## PreCompact

**When:** Claude Code is about to compress the conversation context (context window getting full).

**What it does:**
- Reminds the agent to save important information from the current conversation to `memory/YYYY-MM-DD.md` before it gets compacted
- Append-only — never overwrites existing entries

This prevents memory loss during long sessions. Without it, context compression could silently discard facts the user shared.

## Stop

**When:** The agent is about to stop (user closing the session).

**What it does:**
- Reminds the agent to write a brief session summary to `memory/YYYY-MM-DD.md`
- Includes: what was discussed, decisions made, open items

This ensures the next session has context about what happened, even if the user doesn't explicitly save anything.

## SessionEnd

**When:** The Claude Code session closes.

**What it does:**
- Appends a `session.end` event to `memory/.dreams/events.jsonl` with a UTC timestamp
- Used by the dreaming system to track session boundaries

## Configuration

Hooks are defined in `hooks/hooks.json` inside the plugin. They run as shell commands — no Node.js or MCP server needed. Claude Code executes them directly.

## Troubleshooting

- **Agent has no personality** — SessionStart hook may not have fired. Run `/mcp` to reconnect, or check that SOUL.md and IDENTITY.md exist.
- **Memory not saved before compaction** — PreCompact hook may have been skipped if compaction happened too fast. Check `memory/YYYY-MM-DD.md` for today's entries.
- **No session.end events** — Check `memory/.dreams/events.jsonl`. If empty, the SessionEnd hook isn't firing — may need `/mcp` reconnect.
