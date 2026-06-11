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

1. Refresh the cron audit FIRST — `CronList` → `writeback.sh audit` — so the registry's `.audit` state is current
2. Call the MCP tool `agent_doctor` with `action='check'` (or `action='fix'` when the user passes `--fix`); its cron-registry check reads the `.audit` you just refreshed
3. The tool returns a structured report; pass it through as-is (the tool already formats a card)
4. Supplement with cron status rendered from the same `CronList` output — the MCP server cannot see Claude Code's cron state

## Steps

### Step 1 — Detect mode

- If the user's message contains `--fix` or `/agent:doctor fix` or says "arreglar" / "auto-fix" / "repara" → mode is `fix`
- Otherwise → mode is `check`

### Step 2 — Refresh the cron audit (BEFORE the card)

The `agent_doctor` card reads the registry's persisted `.audit` offline. Refresh it first, or the card may render stale/contradictory cron state.

`CronList` is a deferred tool. Load it first:

```
ToolSearch(query='select:CronList')
```

Call `CronList()` and pipe its FULL output (verbatim, including a literal `No scheduled jobs.`) to the mechanical auditor:

```bash
printf '%s\n' "<full CronList output>" | bash "$CLAUDE_PLUGIN_ROOT/skills/crons/writeback.sh" audit
```

(Exit 4 = CronList format drift — remember it and report it as its own ⚠️ line in Step 4.) Keep the CronList output for Step 4.

### Step 3 — Run the MCP tool

Call:

```
agent_doctor(action='<mode>')
```

Print the returned card verbatim.

### Step 4 — Add cron status

Append a cron section rendered from the Step 2 `CronList` output (do not call it again):

- **Heartbeat cron**: look for a job whose `prompt` contains `/agent:heartbeat` → report schedule
- **Dreaming cron**: look for a job whose `prompt` contains `dream` → report schedule
- If either is missing, show `⚠️` and suggest: "Missing cron — run the default crons flow (see AGENTS.md)"
- If the audit line reported `orphaned>0`, add: `⚠️ <N> registry reminder(s) not firing — run /agent:crons reconcile`
- If the audit printed `blocked key=` lines, add: `⚠️ <B> reminder(s) with ambiguous live duplicates — review with /agent:crons list`

Format:

```
Crons:
  ✅ Heartbeat: */30 * * * *
  ✅ Dreaming:  0 3 * * *
  ✅ Registry audit: alive=5/5
```

### Step 5 — Surface hints

If the diagnostic card includes any `→ hint:` lines, those are already rendered. Do not repeat them; the user has what they need.

### Step 6 — If in `fix` mode, remind the user to reload

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
