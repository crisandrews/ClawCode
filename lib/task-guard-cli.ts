/**
 * Task Completion Guard CLI — invoked by hooks/stop-guard.sh on Stop.
 *
 * Reads stdin (Claude Code Stop-hook payload), inspects the task ledger,
 * and emits one of:
 *   - empty stdout + exit 0  → allow the agent to stop.
 *   - JSON {"decision":"block","reason":"..."} → re-prompt the agent.
 *
 * A counter at memory/.tasks/stop-counter.json caps consecutive blocks at
 * `taskGuard.maxStopBlocks` (default 5) so the agent can never be trapped.
 */

import fs from "fs";
import path from "path";
import { TaskLedger, type ActiveTask } from "./task-ledger.ts";
import { loadConfig } from "./config.ts";

interface GuardConfig {
  enabled: boolean;
  maxStopBlocks: number;
}

function readGuardConfig(workspace: string): GuardConfig {
  try {
    const cfg = loadConfig(workspace) as { taskGuard?: Partial<GuardConfig> };
    const tg = cfg.taskGuard || {};
    return {
      enabled: tg.enabled !== false,
      maxStopBlocks: Number.isFinite(tg.maxStopBlocks)
        ? Math.max(1, Number(tg.maxStopBlocks))
        : 5,
    };
  } catch {
    return { enabled: true, maxStopBlocks: 5 };
  }
}

function readCounter(file: string): number {
  try {
    return Number(JSON.parse(fs.readFileSync(file, "utf-8")).count) || 0;
  } catch {
    return 0;
  }
}

function writeCounter(file: string, count: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ count, updatedAt: new Date().toISOString() }) + "\n"
  );
}

function formatActive(active: ActiveTask[]): string {
  const lines: string[] = [];
  for (const t of active) {
    lines.push(`- Task ${t.id}: ${t.goal}`);
    for (const c of t.criteria) {
      const mark = t.evidence[c] ? "[x]" : "[ ]";
      lines.push(`    ${mark} ${c}`);
    }
  }
  return lines.join("\n");
}

function emitBlock(reason: string): void {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

function main() {
  const workspace = process.env.CLAWCODE_WORKSPACE || process.cwd();

  const cfg = readGuardConfig(workspace);
  if (!cfg.enabled) return; // exit 0, allow stop

  const ledger = new TaskLedger(workspace);
  let active: ActiveTask[] = [];
  try {
    active = ledger.activeTasks();
  } catch {
    return;
  }

  const counterFile = path.join(workspace, "memory", ".tasks", "stop-counter.json");

  if (active.length === 0) {
    // Reset counter when everything is closed.
    try { fs.unlinkSync(counterFile); } catch {}
    return;
  }

  const prev = readCounter(counterFile);
  if (prev >= cfg.maxStopBlocks) {
    // Surrender — let the agent stop. Tasks remain in the ledger for the next
    // session (or a watchdog) to pick up. Reset so the next stop is fresh.
    try { fs.unlinkSync(counterFile); } catch {}
    return;
  }
  const next = prev + 1;
  writeCounter(counterFile, next);

  const reason =
    `[clawcode/task-guard] You still have open tasks with unmet acceptance criteria. ` +
    `Continue working until each criterion has evidence, then call task_check ` +
    `(criterion + evidence) and finally task_close. If a task is genuinely impossible ` +
    `or no longer relevant, call task_close with force=true and explain why in the summary. ` +
    `Block ${next}/${cfg.maxStopBlocks}.\n\nOpen tasks:\n${formatActive(active)}`;

  emitBlock(reason);
}

try {
  main();
} catch {
  // Never break the Stop hook — silent exit means "allow stop".
}
