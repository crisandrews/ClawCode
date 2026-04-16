# Task Completion Guard

Persistent task ledger plus a Stop hook that re-prompts the agent while any task still has unmet acceptance criteria. Designed to fix the common frustration that AI assistants stop early on multi-step work.

## How it works

```
                ┌──────────────────────────┐
   user asks ──▶│  task_open(goal, [...])  │── writes "open" event
                └──────────────────────────┘
                           │
   agent works  ──▶ task_check(id, c, ev) ── writes "check" event
                           │
                  agent tries to stop
                           │
                ┌──────────────────────────┐
                │  Stop hook (TS)          │
                │  ─ active tasks?         │
                │     yes → block + reason │   ── re-prompts agent
                │     no  → allow stop     │
                └──────────────────────────┘
                           │
                  agent finishes
                           │
                ┌──────────────────────────┐
                │  task_close(id, sum)     │── writes "close" event
                └──────────────────────────┘
```

## Files

- `lib/task-ledger.ts` — append-only JSONL store + active-task computation.
- `lib/task-guard-cli.ts` — CLI invoked by the Stop hook, emits the block JSON.
- `hooks/stop-guard.sh` — thin bash wrapper, reads `CLAUDE_PROJECT_DIR`.
- `hooks/hooks.json` — wires the guard into the `Stop` event.
- `server.ts` — exposes `task_open`, `task_check`, `task_close`, `task_list`.
- `skills/task/SKILL.md` — user-invocable skill describing the workflow.

## Storage

`memory/.tasks/active.jsonl` — append-only JSONL. One event per line:

```json
{"type":"open","id":"t-a1b2c3d4","goal":"...","criteria":["..."],"createdAt":"2026-04-15T..."}
{"type":"check","id":"t-a1b2c3d4","criterion":"...","evidence":"...","ts":"2026-04-15T..."}
{"type":"close","id":"t-a1b2c3d4","summary":"...","closedAt":"2026-04-15T..."}
```

A task is **active** if its `open` event has no matching `close` event.

## Loop safety

`memory/.tasks/stop-counter.json` tracks consecutive Stop blocks. Once it reaches `taskGuard.maxStopBlocks` (default 5), the guard releases the agent so the session can end. The counter is reset whenever the ledger has zero active tasks. This prevents an agent from being trapped if a task is genuinely impossible.

## Configuration

In `agent-config.json`:

```json
{
  "taskGuard": {
    "enabled": true,
    "maxStopBlocks": 5
  }
}
```

Set `enabled: false` to disable the Stop block while keeping the ledger tools usable for tracking.

## Failure modes

| Situation | Behaviour |
|---|---|
| `agent-config.json` missing or unreadable | Defaults: enabled=true, maxStopBlocks=5. |
| `tsx`/`node_modules` missing in plugin root | Hook exits 0 — Stop is allowed, no break. |
| `memory/.tasks/active.jsonl` missing | Guard exits 0 — nothing to enforce. |
| Malformed JSONL line | Skipped, ledger keeps reading. |
| Counter cap reached | Guard releases; tasks remain for next session. |

## Why a Stop hook (and not PreToolUse)

The Stop hook is the only lifecycle event triggered by the agent declaring it is done. Re-prompting there is the lightest-touch way to enforce completion — it doesn't interfere with any tool call, doesn't inflate context mid-task, and surrenders cleanly via the counter.
