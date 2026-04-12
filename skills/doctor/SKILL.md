---
name: doctor
description: Run diagnostic checks on the agent workspace. Triggers on /agent:doctor, "diagnóstico", "diagnostico", "doctor", "health check", "agent health", "checkup", "revisar agente", "agent broken", "fix agent", "revisa el agente".
user-invocable: true
argument-hint: [--fix]
---

# Doctor

Health check for this agent. Inspects config, identity, memory, SQLite index, QMD, crons, hooks, HTTP bridge, messaging plugins, and dreaming. When invoked with `--fix`, applies safe auto-repairs (create memory dir, sync index, delete stale BOOTSTRAP.md) before re-running checks.

This is a CORE feature — always available. See `docs/doctor.md` for the full list of checks and auto-fixes.

## When to use

- Right after `/agent:create` or `/agent:import` — verify setup is clean
- When memory search returns nothing or feels wrong — check SQLite integrity
- When heartbeats don't seem to fire — verify crons and active hours
- When you enabled the HTTP bridge but the browser can't connect — probe it
- Anytime something feels off

## How it works

1. Call the MCP tool `agent_doctor` with `action='check'` (or `action='fix'` when the user passes `--fix`)
2. The tool returns a structured report; pass it through as-is (the tool already formats a card)
3. Supplement with cron status from `CronList` — the MCP server cannot see Claude Code's cron state, so include that here

## Steps

### Step 1 — Detect mode

- If the user's message contains `--fix` or `/agent:doctor fix` or says "arreglar" / "auto-fix" / "repara" → mode is `fix`
- Otherwise → mode is `check`

### Step 2 — Run the MCP tool

Call:

```
agent_doctor(action='<mode>')
```

Print the returned card verbatim.

### Step 3 — Add cron status

`agent_doctor` cannot read Claude Code's cron list (MCP servers don't have access to Claude Code's runtime). Append a cron section by calling the `CronList` tool.

Remember: `CronList` is a deferred tool. Load it first:

```
ToolSearch(query='select:CronList')
```

Then call `CronList()` and render:

- **Heartbeat cron**: look for a job whose `prompt` contains `/agent:heartbeat` → report schedule
- **Dreaming cron**: look for a job whose `prompt` contains `dream` → report schedule
- If either is missing, show `⚠️` and suggest: "Missing cron — run the default crons flow (see AGENTS.md)"

Format:

```
Crons:
  ✅ Heartbeat: */30 * * * *
  ✅ Dreaming:  0 3 * * *
```

### Step 4 — Surface hints

If the diagnostic card includes any `→ hint:` lines, those are already rendered. Do not repeat them; the user has what they need.

### Step 5 — If in `fix` mode, remind the user to reload

After a fix run, if any fix was applied or any hook-related issue remains, recommend `/mcp` to reload the MCP server. Example:

```
Some changes take effect only after reloading the MCP server. Run `/mcp` to apply.
```

## Response style

- Terse. No preamble. Just the card + cron section + optional reload hint.
- On messaging channels (WhatsApp, Telegram, Discord), collapse the card to one line per check: `✅ Config · ✅ Identity · ⏸️ HTTP · ℹ️ Dreaming · ...` — full card is too wide for mobile.
- On CLI or WebChat, keep the full multi-line card.

## Never

- Do NOT run auto-fixes without the user asking. If they say `/agent:doctor`, only check. Only apply fixes on `--fix` or when the user explicitly asks to repair.
- Do NOT invent diagnostic categories not implemented in `lib/doctor.ts`. If they ask about something not covered (e.g. "check my OpenAI API key"), say the doctor doesn't cover that yet — or consult `docs/doctor.md` for the current check list.

## References

- `docs/doctor.md` — full feature documentation
- `lib/doctor.ts` — implementation (checks + fixes)
- `docs/INDEX.md` — master feature index
