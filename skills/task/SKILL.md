---
name: task
description: Open, inspect, and close tracked tasks guarded by the Stop hook. Use when the user assigns work that must actually be finished — the guard re-prompts you each time you try to stop while criteria are unmet. Triggers "/task open", "/task list", "/task close", "/task check", "track this", "make sure you finish".
---

# Task Completion Guard

You have an MCP-backed task ledger plus a Stop hook that **refuses to let you stop** while any task in `memory/.tasks/active.jsonl` has unmet acceptance criteria.

## When to open a task

Open a task whenever the user assigns something that:
- has more than one verifiable step,
- you might forget about across compactions, or
- you historically would "stop early" on.

If the user says "track this" / "make sure you finish" / "don't stop until done", **always** open one.

## The four MCP tools

- `task_open(goal, criteria[], source?)` — returns a task id.
- `task_check(id, criterion, evidence)` — record proof that a criterion is met. `criterion` must match one passed to `task_open` exactly.
- `task_close(id, summary, force?)` — refuses unless every criterion has evidence. Pass `force: true` only when you're abandoning the task and explain why in `summary`.
- `task_list()` — shows open tasks with satisfied/remaining criteria.

## Workflow

1. Receive the user request → call `task_open` with crisp criteria.
2. Do the work. After each meaningful step, call `task_check` with concrete evidence (file path, test output, URL, command).
3. When all criteria check out, call `task_close` with a one-line summary.
4. If you genuinely cannot finish (blocked, out of scope, contradicted), call `task_close` with `force: true` and explain — the guard releases.

## Writing good criteria

- ✅ "tests/foo.test.ts passes when run with `npm test`"
- ✅ "POST /api/users returns 201 with valid body"
- ✅ "memory/2026-04-15.md contains the deployment summary"
- ❌ "code looks good" (not verifiable)
- ❌ "user is happy" (not verifiable by you)

## Stop loop budget

The guard caps consecutive Stop blocks at `taskGuard.maxStopBlocks` (default 5) — after that it surrenders and lets the session end. The unfinished task stays in the ledger; the next session can pick it up via `task_list`.

## Configuration

```json
{
  "taskGuard": {
    "enabled": true,
    "maxStopBlocks": 5
  }
}
```

Set `enabled: false` in `agent-config.json` to disable the Stop block while keeping the ledger tools available for tracking.
