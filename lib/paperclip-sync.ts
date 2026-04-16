/**
 * Paperclip ↔ Task Ledger sync.
 *
 * When ClawCode is invoked by a Paperclip heartbeat:
 *   1. Reads the heartbeat context (issue title, acceptance criteria from description)
 *   2. Auto-opens a task_ledger entry so the Task Completion Guard enforces completion
 *   3. On task_close, posts a comment back to the Paperclip issue with the summary
 *
 * This bridges Paperclip's issue lifecycle with ClawCode's completion enforcement.
 */

import { PaperclipClient, type PaperclipConfig } from "./paperclip-bridge.ts";
import { TaskLedger, type ActiveTask } from "./task-ledger.ts";

export interface SyncResult {
  synced: boolean;
  taskId?: string;
  issueId?: string;
  reason?: string;
}

/**
 * Called at session start when Paperclip env vars are present.
 * Reads the heartbeat context and opens a task ledger entry.
 */
export async function syncFromHeartbeat(
  client: PaperclipClient,
  ledger: TaskLedger
): Promise<SyncResult> {
  const cfg = client.getConfig();
  if (!cfg.runId) {
    return { synced: false, reason: "no runId — not a heartbeat invocation" };
  }

  // Check if there's already an open task for this run
  const active = ledger.activeTasks();
  const existing = active.find(
    (t) => t.source === `paperclip:${cfg.runId}`
  );
  if (existing) {
    return {
      synced: true,
      taskId: existing.id,
      issueId: existing.goal,
      reason: "already synced",
    };
  }

  try {
    const run = await client.heartbeatContext();
    if (!run) {
      return { synced: false, reason: "could not fetch heartbeat context" };
    }

    // Extract issue context from the run
    const context = run.contextSnapshot || run;
    const issueTitle = context.issueTitle || context.title || run.triggerDetail || "Paperclip task";
    const issueId = context.issueId || context.issue?.id;

    // Build criteria from issue description or use defaults
    const criteria = extractCriteria(context.issueDescription || context.description || "");
    if (criteria.length === 0) {
      criteria.push("Task completed as described in the issue");
    }

    const event = ledger.open(
      `[${issueTitle}]${issueId ? ` (${issueId})` : ""}`,
      criteria,
      `paperclip:${cfg.runId}`
    );

    return {
      synced: true,
      taskId: event.id,
      issueId: issueId || undefined,
    };
  } catch (e: any) {
    return {
      synced: false,
      reason: `heartbeat context error: ${e.message}`,
    };
  }
}

/**
 * Called when task_close fires for a Paperclip-sourced task.
 * Posts a summary comment back to the issue.
 */
export async function syncOnClose(
  client: PaperclipClient,
  issueId: string,
  summary: string,
  force: boolean
): Promise<void> {
  try {
    const prefix = force ? "⚠️ Task force-closed" : "✅ Task completed";
    await client.addComment(
      issueId,
      `${prefix} by ClawCode agent:\n\n${summary}`
    );
  } catch {
    // Best-effort — don't break the close flow
  }
}

/**
 * Extract acceptance criteria from an issue description.
 * Looks for markdown checklists (- [ ] ...) or numbered lists.
 */
function extractCriteria(description: string): string[] {
  const criteria: string[] = [];
  const lines = description.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Markdown checklist: - [ ] criterion or - [x] criterion
    const checkMatch = trimmed.match(/^[-*]\s*\[[ x]?\]\s*(.+)/i);
    if (checkMatch) {
      criteria.push(checkMatch[1].trim());
      continue;
    }
    // Numbered list: 1. criterion or 1) criterion
    const numMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (numMatch && criteria.length > 0) {
      // Only capture numbered items after we've found at least one checklist item
      // to avoid treating random paragraphs as criteria
      criteria.push(numMatch[1].trim());
    }
  }

  return criteria.slice(0, 10); // Cap at 10 criteria
}
