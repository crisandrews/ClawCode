/**
 * Task ledger — append-only JSONL store of agent tasks with acceptance criteria.
 *
 * Backs the Task Completion Guard: the Stop hook reads `activeTasks()` and
 * blocks the agent from terminating while any task remains open.
 *
 * File: memory/.tasks/active.jsonl
 * Each line is one event:
 *   { type: "open",  id, goal, criteria, createdAt, source? }
 *   { type: "check", id, criterion, evidence, ts }
 *   { type: "close", id, summary, closedAt, force? }
 *
 * Active task = an "open" event with no later "close" event for the same id.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

export interface TaskOpenEvent {
  type: "open";
  id: string;
  goal: string;
  criteria: string[];
  createdAt: string;
  source?: string;
}

export interface TaskCheckEvent {
  type: "check";
  id: string;
  criterion: string;
  evidence: string;
  ts: string;
}

export interface TaskCloseEvent {
  type: "close";
  id: string;
  summary: string;
  closedAt: string;
  force?: boolean;
}

export type TaskEvent = TaskOpenEvent | TaskCheckEvent | TaskCloseEvent;

export interface ActiveTask {
  id: string;
  goal: string;
  criteria: string[];
  createdAt: string;
  source?: string;
  satisfied: string[];
  remaining: string[];
  evidence: Record<string, string>;
}

export class TaskLedger {
  private workspace: string;
  private dir: string;
  private file: string;

  constructor(workspace: string) {
    this.workspace = workspace;
    this.dir = path.join(workspace, "memory", ".tasks");
    this.file = path.join(this.dir, "active.jsonl");
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private readEvents(): TaskEvent[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, "utf-8");
    const out: TaskEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as TaskEvent);
      } catch {
        // Skip malformed lines — ledger remains forward-readable.
      }
    }
    return out;
  }

  private append(event: TaskEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
  }

  open(goal: string, criteria: string[], source?: string): TaskOpenEvent {
    const cleanGoal = goal.trim();
    if (!cleanGoal) throw new Error("goal is required");
    const cleanCriteria = (criteria || [])
      .map((c) => String(c || "").trim())
      .filter((c) => c.length > 0);
    if (cleanCriteria.length === 0) {
      throw new Error("at least one acceptance criterion is required");
    }
    const id = "t-" + crypto.randomBytes(4).toString("hex");
    const event: TaskOpenEvent = {
      type: "open",
      id,
      goal: cleanGoal,
      criteria: cleanCriteria,
      createdAt: new Date().toISOString(),
      source,
    };
    this.append(event);
    return event;
  }

  check(id: string, criterion: string, evidence: string): TaskCheckEvent {
    const cleanId = String(id || "").trim();
    const cleanCriterion = String(criterion || "").trim();
    const cleanEvidence = String(evidence || "").trim();
    if (!cleanId || !cleanCriterion || !cleanEvidence) {
      throw new Error("id, criterion, and evidence are all required");
    }
    const active = this.activeTasks().find((t) => t.id === cleanId);
    if (!active) throw new Error(`no active task with id ${cleanId}`);
    if (!active.criteria.includes(cleanCriterion)) {
      throw new Error(
        `criterion "${cleanCriterion}" is not part of task ${cleanId}`
      );
    }
    const event: TaskCheckEvent = {
      type: "check",
      id: cleanId,
      criterion: cleanCriterion,
      evidence: cleanEvidence,
      ts: new Date().toISOString(),
    };
    this.append(event);
    return event;
  }

  close(id: string, summary: string, force = false): TaskCloseEvent {
    const cleanId = String(id || "").trim();
    const cleanSummary = String(summary || "").trim();
    if (!cleanId) throw new Error("id is required");
    if (!cleanSummary) throw new Error("summary is required to close a task");

    const active = this.activeTasks().find((t) => t.id === cleanId);
    if (!active) throw new Error(`no active task with id ${cleanId}`);
    if (!force && active.remaining.length > 0) {
      throw new Error(
        `cannot close ${cleanId}: ${active.remaining.length} criteria lack evidence — pass force=true to override or call task_check first`
      );
    }
    const event: TaskCloseEvent = {
      type: "close",
      id: cleanId,
      summary: cleanSummary,
      closedAt: new Date().toISOString(),
      force: force || undefined,
    };
    this.append(event);
    return event;
  }

  activeTasks(): ActiveTask[] {
    const events = this.readEvents();
    const opens = new Map<string, TaskOpenEvent>();
    const closed = new Set<string>();
    const evidenceById = new Map<string, Record<string, string>>();

    for (const e of events) {
      if (e.type === "open") opens.set(e.id, e);
      else if (e.type === "close") closed.add(e.id);
      else if (e.type === "check") {
        const ev = evidenceById.get(e.id) || {};
        ev[e.criterion] = e.evidence;
        evidenceById.set(e.id, ev);
      }
    }

    const active: ActiveTask[] = [];
    for (const [id, open] of opens) {
      if (closed.has(id)) continue;
      const ev = evidenceById.get(id) || {};
      const satisfied = open.criteria.filter((c) => ev[c]);
      const remaining = open.criteria.filter((c) => !ev[c]);
      active.push({
        id,
        goal: open.goal,
        criteria: open.criteria,
        createdAt: open.createdAt,
        source: open.source,
        satisfied,
        remaining,
        evidence: ev,
      });
    }
    return active;
  }
}
