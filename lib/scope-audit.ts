/**
 * Scope audit — Phase 0 of channel-scope compatibility plan.
 *
 * Read-only inspection of where channel-derived content has surfaced
 * in the workspace ahead of any enforcement. Surfaces six signals so
 * the user can decide what to quarantine before opting into scope
 * enforcement via `/agent:scope wizard`.
 *
 * No mutations. No network. No global config required. Safe to call
 * repeatedly.
 *
 * Signals:
 *  1. extraPathChunks — chunks in `memory/.memory.sqlite` whose path
 *     uses the `extra:` prefix (i.e., came from `memory.extraPaths`).
 *  2. promotedFromExtra — lines in MEMORY.md / DREAMS.md that were
 *     promoted by the dream cycle and cite `source: extra:...`.
 *  3. recallStateLeaks — entries in `.dreams/short-term-recall.json`
 *     whose path is `extra:`. These feed future dream promotion.
 *  4. hotPathLogStatements — `console.*` / `logger.*` calls in hot
 *     paths that may emit memory snippets to logs (manual review).
 *  5. mcpResources — MCP `Resource` declarations (vs tools) which
 *     bypass the planned tool-level chokepoint.
 *  6. exportCommands — skills mentioning export / backup / dump of
 *     memory or chat content.
 *
 * Channel-hint derivation reuses CHANNEL_REGISTRY.cacheMarkers from
 * channel-detector.ts so the audit stays in sync with the canonical
 * list of channels.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ChannelName } from "./channel-detector.ts";
import { deriveChannelHint } from "./scope/channel-hint.ts";

export interface ScopeAuditExtraChunk {
  path: string;
  channelHint: ChannelName | null;
  sample: string;
}

export interface ScopeAuditPromotedLine {
  file: string;
  line: number;
  preview: string;
  channelHint: ChannelName | null;
}

export interface ScopeAuditRecallEntry {
  entryPath: string;
  channelHint: ChannelName | null;
}

export interface ScopeAuditLogStatement {
  file: string;
  line: number;
  preview: string;
}

export interface ScopeAuditMcpResource {
  symbol: string;
  declaration: string;
}

export interface ScopeAuditExportCommand {
  skill: string;
  file: string;
  line: number;
  preview: string;
}

export interface ScopeAuditReport {
  workspace: string;
  scannedAt: string;
  extraPathChunks: ScopeAuditExtraChunk[];
  promotedFromExtra: ScopeAuditPromotedLine[];
  recallStateLeaks: ScopeAuditRecallEntry[];
  hotPathLogStatements: ScopeAuditLogStatement[];
  mcpResources: ScopeAuditMcpResource[];
  exportCommands: ScopeAuditExportCommand[];
  summary: {
    extraPathChunkCount: number;
    promotedLineCount: number;
    recallEntryCount: number;
    hotPathLogCount: number;
    mcpResourceCount: number;
    exportCommandCount: number;
    /** True when channel-derived content has actually surfaced in
     * shared memory (signals 1-3). Content-level leak. */
    anySignals: boolean;
    /** True when implementation-level concerns exist that *could*
     * surface content in the future (signals 4-6). Code-level hint. */
    anyImplementationHints: boolean;
  };
}

const HOT_PATH_FILES = [
  "lib/dreaming.ts",
  "lib/memory-db.ts",
  "lib/memory-context.ts",
  "lib/qmd-manager.ts",
  "lib/voice.ts",
  "lib/http-bridge.ts",
  "server.ts",
];

const LOG_PATTERN =
  /\b(console\.(log|info|warn|error|debug)|logger\.(info|warn|error|debug))\s*\(/;

const PROMOTE_PATTERN = /source:\s*extra:/i;

const RESOURCE_RE = /\b(ListResourcesRequestSchema|ReadResourceRequestSchema)\b/;

const EXPORT_RE = /\b(export|backup|dump)\b[^\n]*\b(memor|chat|chunk|history|conversation)\w*/i;

const MAX_CHUNKS = 200;
const MAX_LINE_PREVIEW = 200;

/**
 * Map a path-like string to a known channel name, using the registry
 * markers as substring hints. Returns null when nothing matches.
 *
 * Re-exported from `lib/scope/channel-hint.ts` (split out so the
 * exec-gate hook bundle doesn't drag better-sqlite3 in just to call
 * this pure function).
 */
export { deriveChannelHint };

function auditExtraPathChunks(workspace: string): ScopeAuditExtraChunk[] {
  const dbPath = path.join(workspace, "memory", ".memory.sqlite");
  if (!fs.existsSync(dbPath)) return [];
  const out: ScopeAuditExtraChunk[] = [];
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT path, substr(text, 1, 200) AS sample FROM chunks WHERE path LIKE 'extra:%' LIMIT ?"
        )
        .all(MAX_CHUNKS) as Array<{ path: string; sample: string }>;
      for (const r of rows) {
        out.push({
          path: r.path,
          channelHint: deriveChannelHint(r.path),
          sample: r.sample ?? "",
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // Locked / corrupt / wrong schema — skip silently. The audit is a
    // best-effort signal, not a guarantee.
  }
  return out;
}

function auditPromotedFromExtra(workspace: string): ScopeAuditPromotedLine[] {
  const out: ScopeAuditPromotedLine[] = [];
  const candidates = [
    path.join(workspace, "memory", "MEMORY.md"),
    path.join(workspace, "MEMORY.md"),
    path.join(workspace, "DREAMS.md"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf-8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (PROMOTE_PATTERN.test(lines[i])) {
        out.push({
          file: path.relative(workspace, file),
          line: i + 1,
          preview: lines[i].slice(0, MAX_LINE_PREVIEW),
          channelHint: deriveChannelHint(lines[i]),
        });
      }
    }
  }
  return out;
}

function auditRecallStateLeaks(workspace: string): ScopeAuditRecallEntry[] {
  const recallPath = path.join(
    workspace,
    "memory",
    ".dreams",
    "short-term-recall.json"
  );
  if (!fs.existsSync(recallPath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(recallPath, "utf-8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object") return [];
  // The recall file produced by `dreaming.ts` wraps entries under an
  // `entries` key (see dreaming.ts:412 — `Object.keys(raw.entries || {})`).
  // Tolerate the legacy/minimal flat shape too in case a fixture or older
  // build wrote entries at the root.
  const wrapped = (raw as { entries?: unknown }).entries;
  const entriesObj =
    wrapped && typeof wrapped === "object" ? wrapped : raw;
  const out: ScopeAuditRecallEntry[] = [];
  for (const entry of Object.values(entriesObj as Record<string, unknown>)) {
    const e = entry as { path?: unknown };
    if (
      e &&
      typeof e === "object" &&
      typeof e.path === "string" &&
      e.path.startsWith("extra:")
    ) {
      out.push({ entryPath: e.path, channelHint: deriveChannelHint(e.path) });
    }
  }
  return out;
}

function auditHotPathLogStatements(workspace: string): ScopeAuditLogStatement[] {
  const out: ScopeAuditLogStatement[] = [];
  for (const rel of HOT_PATH_FILES) {
    const file = path.join(workspace, rel);
    if (!fs.existsSync(file)) continue;
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf-8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (LOG_PATTERN.test(lines[i])) {
        out.push({
          file: rel,
          line: i + 1,
          preview: lines[i].trim().slice(0, MAX_LINE_PREVIEW),
        });
      }
    }
  }
  return out;
}

function auditMcpResources(workspace: string): ScopeAuditMcpResource[] {
  const file = path.join(workspace, "server.ts");
  if (!fs.existsSync(file)) return [];
  let lines: string[];
  try {
    lines = fs.readFileSync(file, "utf-8").split("\n");
  } catch {
    return [];
  }
  const out: ScopeAuditMcpResource[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (RESOURCE_RE.test(lines[i])) {
      const symbol = lines[i].match(/\w+RequestSchema/)?.[0] ?? "unknown";
      out.push({ symbol, declaration: `server.ts:${i + 1}` });
    }
  }
  return out;
}

function auditExportCommands(workspace: string): ScopeAuditExportCommand[] {
  const out: ScopeAuditExportCommand[] = [];
  const skillsDir = path.join(workspace, "skills");
  if (!fs.existsSync(skillsDir)) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    let lines: string[];
    try {
      lines = fs.readFileSync(skillFile, "utf-8").split("\n");
    } catch {
      continue;
    }
    for (let i = 0; i < lines.length; i++) {
      if (EXPORT_RE.test(lines[i])) {
        out.push({
          skill: entry.name,
          file: path.join("skills", entry.name, "SKILL.md"),
          line: i + 1,
          preview: lines[i].trim().slice(0, MAX_LINE_PREVIEW),
        });
      }
    }
  }
  return out;
}

export function runScopeAudit(workspace: string): ScopeAuditReport {
  const extraPathChunks = auditExtraPathChunks(workspace);
  const promotedFromExtra = auditPromotedFromExtra(workspace);
  const recallStateLeaks = auditRecallStateLeaks(workspace);
  const hotPathLogStatements = auditHotPathLogStatements(workspace);
  const mcpResources = auditMcpResources(workspace);
  const exportCommands = auditExportCommands(workspace);

  return {
    workspace,
    scannedAt: new Date().toISOString(),
    extraPathChunks,
    promotedFromExtra,
    recallStateLeaks,
    hotPathLogStatements,
    mcpResources,
    exportCommands,
    summary: {
      extraPathChunkCount: extraPathChunks.length,
      promotedLineCount: promotedFromExtra.length,
      recallEntryCount: recallStateLeaks.length,
      hotPathLogCount: hotPathLogStatements.length,
      mcpResourceCount: mcpResources.length,
      exportCommandCount: exportCommands.length,
      anySignals:
        extraPathChunks.length > 0 ||
        promotedFromExtra.length > 0 ||
        recallStateLeaks.length > 0,
      anyImplementationHints:
        hotPathLogStatements.length > 0 ||
        mcpResources.length > 0 ||
        exportCommands.length > 0,
    },
  };
}
