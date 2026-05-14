/**
 * Doctor — diagnostic checks for a ClawCode agent workspace.
 *
 * Each check is a small function that inspects one aspect of the workspace
 * and returns a DiagnosticCheck result (status + message + optional hint).
 * The runDoctor() function runs them all and returns a DiagnosticReport.
 *
 * Fixes are separated into runDoctorFix() — only safe, idempotent repairs
 * that can be applied without human judgment. Risky or ambiguous fixes
 * (malformed config, missing identity) are left as advisories.
 */

import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { execSync } from "child_process";
import { loadConfig, collectScopeConfigWarnings } from "./config.ts";
import { MemoryDB } from "./memory-db.ts";
import { QmdManager } from "./qmd-manager.ts";
import { runScopeAudit } from "./scope-audit.ts";
import { detectScopeRuntime } from "./scope/runtime.ts";
import { detectChannels } from "./channel-detector.ts";

export type CheckStatus = "ok" | "warn" | "error" | "info" | "off";

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  hint?: string;
}

export interface DiagnosticReport {
  workspace: string;
  ranAt: string;
  checks: DiagnosticCheck[];
  summary: {
    ok: number;
    warn: number;
    error: number;
    info: number;
    off: number;
  };
}

export interface FixResult {
  id: string;
  applied: boolean;
  message: string;
}

export interface FixReport {
  workspace: string;
  ranAt: string;
  fixes: FixResult[];
  postCheck: DiagnosticReport;
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

export function checkConfig(workspace: string): DiagnosticCheck {
  const configPath = path.join(workspace, "agent-config.json");
  if (!fs.existsSync(configPath)) {
    return {
      id: "config",
      label: "Config",
      status: "info",
      message: "agent-config.json not found — using defaults",
      hint: "Run /agent:settings to customize",
    };
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    JSON.parse(raw);
    return {
      id: "config",
      label: "Config",
      status: "ok",
      message: "agent-config.json valid",
    };
  } catch (err) {
    return {
      id: "config",
      label: "Config",
      status: "error",
      message: `agent-config.json is malformed: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Fix the JSON manually or delete and run /agent:settings",
    };
  }
}

const IDENTITY_FILES = ["SOUL.md", "IDENTITY.md", "USER.md"] as const;

export function checkIdentity(workspace: string): DiagnosticCheck {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const f of IDENTITY_FILES) {
    const p = path.join(workspace, f);
    if (!fs.existsSync(p)) {
      missing.push(f);
      continue;
    }
    try {
      const content = fs.readFileSync(p, "utf-8").trim();
      if (!content) empty.push(f);
    } catch {
      missing.push(f);
    }
  }
  if (missing.length > 0) {
    return {
      id: "identity",
      label: "Identity",
      status: "error",
      message: `Missing: ${missing.join(", ")}`,
      hint: "Run /agent:create for a fresh agent or /agent:import to bring an existing one",
    };
  }
  if (empty.length > 0) {
    return {
      id: "identity",
      label: "Identity",
      status: "warn",
      message: `Empty: ${empty.join(", ")}`,
      hint: "Fill in your personality before the agent feels generic",
    };
  }
  return {
    id: "identity",
    label: "Identity",
    status: "ok",
    message: "SOUL, IDENTITY, USER all present",
  };
}

export function checkMemoryDir(workspace: string): DiagnosticCheck {
  const memoryDir = path.join(workspace, "memory");
  if (!fs.existsSync(memoryDir)) {
    return {
      id: "memory-dir",
      label: "Memory dir",
      status: "warn",
      message: "memory/ does not exist",
      hint: "Run /agent:doctor --fix or create manually",
    };
  }
  try {
    // Writable test
    const testFile = path.join(memoryDir, `.doctor-write-test-${Date.now()}`);
    fs.writeFileSync(testFile, "x");
    fs.unlinkSync(testFile);
  } catch {
    return {
      id: "memory-dir",
      label: "Memory dir",
      status: "error",
      message: "memory/ exists but is not writable",
      hint: "Check permissions: chmod +w memory",
    };
  }

  // Count files + total size
  let files = 0;
  let totalSize = 0;
  try {
    for (const entry of fs.readdirSync(memoryDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files++;
        try {
          totalSize += fs.statSync(path.join(memoryDir, entry.name)).size;
        } catch {}
      }
    }
  } catch {}

  const kb = (totalSize / 1024).toFixed(1);
  return {
    id: "memory-dir",
    label: "Memory dir",
    status: "ok",
    message: `writable · ${files} md files · ${kb} KB`,
  };
}

export function checkSqlite(workspace: string): DiagnosticCheck {
  let db: MemoryDB | null = null;
  try {
    db = new MemoryDB(workspace);
    const stats = db.stats();
    return {
      id: "sqlite",
      label: "SQLite",
      status: "ok",
      message: `integrity OK · ${stats.files} files, ${stats.chunks} chunks indexed`,
    };
  } catch (err) {
    return {
      id: "sqlite",
      label: "SQLite",
      status: "error",
      message: `failed to open: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Delete memory/.memory.sqlite and reload — it will rebuild",
    };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function checkQmd(workspace: string): DiagnosticCheck {
  let backend: string = "builtin";
  let qmdCommand: string = "qmd";
  try {
    const cfg = loadConfig(workspace);
    backend = cfg.memory.backend;
    qmdCommand = cfg.memory.qmd?.command ?? "qmd";
  } catch {
    // config error already reported by checkConfig
  }

  if (backend !== "qmd") {
    return {
      id: "qmd",
      label: "QMD",
      status: "off",
      message: "not configured (using builtin)",
    };
  }

  if (!QmdManager.isAvailable(qmdCommand)) {
    return {
      id: "qmd",
      label: "QMD",
      status: "error",
      message: `backend=qmd but binary "${qmdCommand}" not found in PATH`,
      hint: "Install with `bun install -g qmd` or set memory.qmd.command",
    };
  }

  return {
    id: "qmd",
    label: "QMD",
    status: "ok",
    message: `binary "${qmdCommand}" available`,
  };
}

export function checkBootstrap(workspace: string): DiagnosticCheck {
  const bootstrapPath = path.join(workspace, "BOOTSTRAP.md");
  if (!fs.existsSync(bootstrapPath)) {
    return {
      id: "bootstrap",
      label: "Bootstrap",
      status: "ok",
      message: "complete",
    };
  }
  // BOOTSTRAP.md exists — is the agent already set up?
  const identityPath = path.join(workspace, "IDENTITY.md");
  let identityFilled = false;
  try {
    const content = fs.readFileSync(identityPath, "utf-8");
    // Heuristic: filled identity has a Name that's not the placeholder
    identityFilled =
      !!content.match(/\*\*Name:\*\*\s*([^\s<][^\n]+)/) &&
      !content.includes("Replace this with");
  } catch {}

  if (identityFilled) {
    return {
      id: "bootstrap",
      label: "Bootstrap",
      status: "warn",
      message: "BOOTSTRAP.md still present despite identity being filled",
      hint: "Run /agent:doctor --fix to clean it up",
    };
  }

  return {
    id: "bootstrap",
    label: "Bootstrap",
    status: "info",
    message: "BOOTSTRAP.md present — first-run ritual pending",
    hint: "Chat with the agent to complete bootstrap",
  };
}

/** Ping the HTTP bridge if config says it's enabled. */
export async function checkHttpBridge(
  workspace: string
): Promise<DiagnosticCheck> {
  let enabled = false;
  let port = 18790;
  let host = "127.0.0.1";
  try {
    const cfg = loadConfig(workspace);
    enabled = cfg.http?.enabled ?? false;
    port = cfg.http?.port ?? 18790;
    host = cfg.http?.host ?? "127.0.0.1";
  } catch {}

  if (!enabled) {
    return {
      id: "http",
      label: "HTTP bridge",
      status: "off",
      message: "disabled",
      hint: "Enable via /agent:settings to get WebChat + webhooks",
    };
  }

  // Probe /health with a 1-second timeout
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const req = http.request(
        { host, port, path: "/health", method: "GET", timeout: 1000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        }
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });

    if (ok) {
      return {
        id: "http",
        label: "HTTP bridge",
        status: "ok",
        message: `listening on http://${host}:${port}`,
      };
    }
    return {
      id: "http",
      label: "HTTP bridge",
      status: "error",
      message: `enabled but not reachable on ${host}:${port}`,
      hint: "Run /mcp to restart the MCP server",
    };
  } catch {
    return {
      id: "http",
      label: "HTTP bridge",
      status: "error",
      message: `probe failed on ${host}:${port}`,
    };
  }
}

/** Detect which messaging plugins are installed (advisory). */
export function checkMessaging(workspace: string): DiagnosticCheck {
  const home = process.env.HOME || "";
  const pluginCache = path.join(home, ".claude", "plugins", "cache");
  const known = [
    "whatsapp",
    "telegram",
    "discord",
    "imessage",
    "slack",
    "fakechat",
  ];
  const found: string[] = [];

  try {
    if (fs.existsSync(pluginCache)) {
      const entries = fs.readdirSync(pluginCache);
      for (const name of known) {
        if (entries.some((e) => e.includes(name))) found.push(name);
      }
    }
  } catch {}

  if (found.length === 0) {
    return {
      id: "messaging",
      label: "Messaging",
      status: "off",
      message: "no channel plugins detected",
      hint: "Run /agent:messaging to set up WhatsApp/Telegram/etc.",
    };
  }

  return {
    id: "messaging",
    label: "Messaging",
    status: "info",
    message: `detected: ${found.join(", ")}`,
  };
}

export function checkDreaming(workspace: string): DiagnosticCheck {
  const recallPath = path.join(
    workspace,
    "memory",
    ".dreams",
    "short-term-recall.json"
  );
  const dreamsMd = path.join(workspace, "DREAMS.md");

  let uniqueMemories = 0;
  let lastUpdate = "";

  try {
    const raw = JSON.parse(fs.readFileSync(recallPath, "utf-8"));
    uniqueMemories = Object.keys(raw.entries || {}).length;
    lastUpdate = raw.updatedAt || "";
  } catch {
    return {
      id: "dreaming",
      label: "Dreaming",
      status: "off",
      message: "no recall data yet",
    };
  }

  const dreamed = fs.existsSync(dreamsMd);
  const parts: string[] = [];
  parts.push(`${uniqueMemories} memories tracked`);
  if (dreamed) parts.push("DREAMS.md exists");
  if (lastUpdate) parts.push(`last update ${lastUpdate.slice(0, 10)}`);

  return {
    id: "dreaming",
    label: "Dreaming",
    status: "info",
    message: parts.join(" · "),
  };
}

export function checkCronRegistry(workspace: string): DiagnosticCheck {
  const registryPath = path.join(workspace, "memory", "crons.json");

  if (!fs.existsSync(registryPath)) {
    return {
      id: "cron-registry",
      label: "Cron registry",
      status: "info",
      message: "memory/crons.json not yet created",
      hint: "will be seeded on first SessionStart reconcile",
    };
  }

  let parsed: { version?: number; entries?: unknown[]; migration?: unknown };
  try {
    parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
  } catch (err) {
    return {
      id: "cron-registry",
      label: "Cron registry",
      status: "error",
      message: `memory/crons.json invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      hint: "reconcile will quarantine this file and rebuild defaults on next session",
    };
  }

  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return {
      id: "cron-registry",
      label: "Cron registry",
      status: "error",
      message: "memory/crons.json missing expected shape (version=1, entries[])",
      hint: "reconcile will quarantine this file and rebuild defaults on next session",
    };
  }

  const entries = parsed.entries as Array<{
    key?: string;
    paused?: boolean;
    tombstone?: string | null;
    harnessTaskId?: string | null;
  }>;

  const active = entries.filter((e) => !e.tombstone && !e.paused).length;
  const paused = entries.filter((e) => e.paused).length;
  const tombstoned = entries.filter((e) => e.tombstone).length;

  // Stale tombstones: older than 30 days.
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const staleTombstones = entries.filter((e) => {
    if (!e.tombstone) return false;
    const ts = Date.parse(e.tombstone);
    return !Number.isNaN(ts) && now - ts > THIRTY_DAYS_MS;
  }).length;

  const parts = [
    `${active} active`,
    ...(paused > 0 ? [`${paused} paused`] : []),
    ...(tombstoned > 0 ? [`${tombstoned} tombstoned`] : []),
  ];

  if (staleTombstones > 0) {
    return {
      id: "cron-registry",
      label: "Cron registry",
      status: "warn",
      message: `${parts.join(" · ")} (${staleTombstones} stale >30d)`,
      hint: "run /agent:crons reconcile to prune old tombstones",
    };
  }

  return {
    id: "cron-registry",
    label: "Cron registry",
    status: "ok",
    message: parts.join(" · "),
  };
}

export function checkJq(): DiagnosticCheck {
  // jq is required by hooks/reconcile-crons.sh and hooks/cron-posttool.sh.
  try {
    execSync("command -v jq", { stdio: "ignore" });
    return {
      id: "jq",
      label: "jq",
      status: "ok",
      message: "jq available in PATH",
    };
  } catch {
    return {
      id: "jq",
      label: "jq",
      status: "warn",
      message: "jq not found in PATH — cron persistence runs in degraded mode",
      hint: "install: brew install jq (macOS) or apt install jq (Linux)",
    };
  }
}

// ---------------------------------------------------------------------------
// Scope checks (Phase 0 of channel-scope compatibility plan)
// ---------------------------------------------------------------------------

/**
 * Surface signals that channel-derived content is reachable through
 * shared memory ahead of any scope enforcement. Pure read-only summary
 * over `runScopeAudit`.
 */
export function checkScopePreEnforceAudit(
  workspace: string
): DiagnosticCheck {
  let report;
  try {
    report = runScopeAudit(workspace);
  } catch (err) {
    return {
      id: "scope-pre-enforce-audit",
      label: "Scope audit",
      status: "warn",
      message: `audit failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: "Run `/agent:scope audit` for diagnostic detail",
    };
  }
  const s = report.summary;
  // Tier the status: actual content leaks (signals 1-3) warrant a WARN;
  // implementation hints alone (signals 4-6) are INFO; nothing → OK.
  if (s.anySignals) {
    const parts: string[] = [];
    if (s.extraPathChunkCount > 0)
      parts.push(`${s.extraPathChunkCount} chunk(s) under extra:`);
    if (s.promotedLineCount > 0)
      parts.push(`${s.promotedLineCount} promoted line(s) cite extra:`);
    if (s.recallEntryCount > 0)
      parts.push(`${s.recallEntryCount} recall entry/entries`);
    return {
      id: "scope-pre-enforce-audit",
      label: "Scope audit",
      status: "warn",
      message: parts.join(" · "),
      hint: "Channel-derived content reachable via memory_search. Future `/agent:scope wizard` (Phase 4a-1+) will let you opt into per-channel enforcement; meanwhile see docs/channel-scope-compat.md.",
    };
  }
  if (s.anyImplementationHints) {
    const parts: string[] = [];
    if (s.hotPathLogCount > 0)
      parts.push(`${s.hotPathLogCount} log statement(s) in hot paths`);
    if (s.mcpResourceCount > 0)
      parts.push(`${s.mcpResourceCount} MCP resource declaration(s)`);
    if (s.exportCommandCount > 0)
      parts.push(`${s.exportCommandCount} export/backup command(s)`);
    return {
      id: "scope-pre-enforce-audit",
      label: "Scope audit",
      status: "info",
      message: `no content leaked yet · code hints: ${parts.join(" · ")}`,
      hint: "Code-level signals to review before scope enforcement ships. See docs/channel-scope-compat.md.",
    };
  }
  return {
    id: "scope-pre-enforce-audit",
    label: "Scope audit",
    status: "ok",
    message: "no channel-derived content found in shared memory",
  };
}

/**
 * Always-present reminder that the planned scope filter only covers
 * MCP tool surfaces; native filesystem reads (Read, Grep, direct
 * SQLite) bypass the filter by design.
 */
export function checkScopeBypasses(_workspace: string): DiagnosticCheck {
  return {
    id: "scope-bypasses",
    label: "Scope bypasses",
    status: "info",
    message: "MCP scope ≠ filesystem sandbox",
    hint: "Native Read/Grep/SQLite directos sobre logs no se filtran (intencional). Ver docs/channel-scope-compat.md.",
  };
}

/**
 * Surface count of quarantined memory snapshots under
 * ~/.claude/agent/quarantine/ so the user remembers they exist.
 */
export function checkScopeQuarantinePending(
  _workspace: string
): DiagnosticCheck {
  const home = os.homedir();
  const quarantineDir = path.join(home, ".claude", "agent", "quarantine");
  if (!fs.existsSync(quarantineDir)) {
    return {
      id: "scope-quarantine-pending",
      label: "Scope quarantine",
      status: "off",
      message: "no quarantined content",
    };
  }
  let count = 0;
  try {
    for (const entry of fs.readdirSync(quarantineDir, {
      withFileTypes: true,
    })) {
      if (
        entry.isFile() &&
        entry.name.startsWith("MEMORY.") &&
        entry.name.endsWith(".md")
      ) {
        count++;
      }
    }
  } catch {
    // Permission denied or not readable — treat as no content.
  }
  if (count === 0) {
    return {
      id: "scope-quarantine-pending",
      label: "Scope quarantine",
      status: "off",
      message: "no quarantined content",
    };
  }
  return {
    id: "scope-quarantine-pending",
    label: "Scope quarantine",
    status: "info",
    message: `${count} archived snapshot(s) in ${quarantineDir}`,
    hint: "Review with: ls ~/.claude/agent/quarantine/",
  };
}

/**
 * Phase 4a-2.6 v12 (Codex 12th-pass LOW v11-F3): surface the
 * synthetic-indexer counters persisted by `MemoryDB.bumpIndexerMetric`.
 * Reads the `scope_indexer_metrics` table directly (no MemoryDB
 * instantiation — doctor must be safe to run in any state). Returns
 * "off" if the workspace has never run the indexer, "info" / "warn"
 * when there's something to surface.
 */
export function checkScopeIndexerHealth(workspace: string): DiagnosticCheck {
  const dbPath = path.join(workspace, "memory", ".memory.sqlite");
  if (!fs.existsSync(dbPath)) {
    return {
      id: "scope-indexer-health",
      label: "Scope indexer health",
      status: "off",
      message: "no memory DB yet",
    };
  }
  let pairsCapped = 0;
  let reservedPrefixSkipped = 0;
  let scopedUnknownSkipped = 0;
  try {
    // Reuse the MemoryDB accessor so the metrics-table CREATE IF NOT
    // EXISTS contract is honored — opening the file directly with
    // better-sqlite3 in readonly mode would fail when the table
    // doesn't exist yet. Codex 13th-pass LOW v12-F4: use the new
    // `headless: true` flag so doctor doesn't allocate fs.watch
    // handles or rewrite mode bits on every diagnostic run.
    const memDb = new MemoryDB(workspace, [], {
      quietBoot: true,
      headless: true,
    });
    try {
      pairsCapped = memDb.getIndexerMetric("pairs_capped");
      reservedPrefixSkipped = memDb.getIndexerMetric(
        "reserved_prefix_skipped"
      );
      // Codex Phase 4a-3 post-impl-round3 LOW #10.
      scopedUnknownSkipped = memDb.getIndexerMetric(
        "scoped_unknown_channel_skipped"
      );
    } finally {
      memDb.close();
    }
  } catch {
    return {
      id: "scope-indexer-health",
      label: "Scope indexer health",
      status: "off",
      message: "metrics unreadable",
    };
  }
  if (
    pairsCapped === 0 &&
    reservedPrefixSkipped === 0 &&
    scopedUnknownSkipped === 0
  ) {
    return {
      id: "scope-indexer-health",
      label: "Scope indexer health",
      status: "ok",
      message: "no truncation or reserved-prefix collisions",
    };
  }
  // Codex 13th-pass LOW v12-F3: counters are cumulative event counts
  // (a single problem chat-day or colliding file may bump the counter
  // multiple times across re-runs), so word the message that way.
  // The user can't infer "N distinct issues" from these.
  const parts: string[] = [];
  if (pairsCapped > 0)
    parts.push(
      `${pairsCapped} cumulative chat-day truncation event(s) past the per-pair cap`
    );
  if (reservedPrefixSkipped > 0)
    parts.push(
      `${reservedPrefixSkipped} cumulative file-collision event(s) at the reserved prefix`
    );
  if (scopedUnknownSkipped > 0)
    parts.push(
      `${scopedUnknownSkipped} cumulative scoped file(s) skipped under unknown channel(s)`
    );
  // Codex 13th-pass MEDIUM v12-F1: pairsCapped is privacy-relevant
  // (an owner won't find tail messages from a truncated day), so
  // promote to `warn` rather than `info`. A truly informational state
  // (capped=0, collision=0) is `ok` above.
  // Codex 14th-pass LOW v13-F1: when BOTH counters are non-zero,
  // build a compound hint instead of dropping the truncation
  // remediation in favor of the collision one.
  const status: DiagnosticCheck["status"] = "warn";
  const hints: string[] = [];
  if (reservedPrefixSkipped > 0) {
    hints.push(
      "rename the extraPath that contains 'messages-db/' or files at extra:claude-whatsapp/messages-db/...; the prefix is reserved for the synthetic per-chat indexer"
    );
  }
  if (pairsCapped > 0) {
    hints.push(
      "a very high-volume chat-day was truncated to the safety bound; tail messages from that day aren't in the synthetic chunk and won't surface in memory_search results"
    );
  }
  if (scopedUnknownSkipped > 0) {
    hints.push(
      "memory/.scoped/<channel>/ exists for a channel name the runtime doesn't recognize; remove the directory or rename to a known channel (whatsapp/telegram/discord/imessage/webchat)"
    );
  }
  return {
    id: "scope-indexer-health",
    label: "Scope indexer health",
    status,
    message: parts.join("; "),
    hint: hints.join("; "),
  };
}

/**
 * Phase 5: scope status row. Reads `loadConfig().scope` and asks
 * `detectScopeRuntime(cfg)` for the live snapshot. Per-channel info
 * row showing mode, identity, armed state, and whether the access
 * path was auto-discovered.
 *
 * Always uses the config-aware runtime path — calling the no-arg
 * `detectScopeRuntime()` would always return `anyArmed: false`
 * (intentional Phase-0-stub compatibility shim).
 */
export function checkScopeStatus(workspace: string): DiagnosticCheck {
  let cfg;
  try {
    cfg = loadConfig(workspace);
  } catch {
    return {
      id: "scope-status",
      label: "Scope status",
      status: "off",
      message: "config unreadable",
    };
  }
  // Codex round 3 LOW: surface typo'd values that `coerceMode` /
  // `coerceIdentity` would have silently swallowed. The user's bad
  // input is fail-closed to off/auto/deny by config-load — but they
  // need to know that, otherwise they think scope is on.
  let warnings: ReturnType<typeof collectScopeConfigWarnings> = [];
  try {
    warnings = collectScopeConfigWarnings(workspace);
  } catch {
    /* ignore — typo diagnostics are best-effort */
  }
  if (!cfg.scope) {
    if (warnings.length > 0) {
      // Raw scope block exists but every value typo'd — `loadConfig`
      // returned `scope: undefined`. Still surface the typos.
      return {
        id: "scope-status",
        label: "Scope status",
        status: "warn",
        message: formatScopeWarnings(warnings),
        hint: "Invalid scope values fail-closed to off — fix the typos and re-run /agent:scope status.",
      };
    }
    return {
      id: "scope-status",
      label: "Scope status",
      status: "ok",
      message: "Channel scope: not configured (per-channel opt-in)",
      hint: "Run `/agent:scope wizard` to opt in, or see docs/channel-scope-compat.md",
    };
  }
  let runtime;
  try {
    runtime = detectScopeRuntime(cfg, workspace);
  } catch {
    return {
      id: "scope-status",
      label: "Scope status",
      status: "off",
      message: "runtime detection failed",
    };
  }
  const channels: string[] = [];
  // Codex round 1 MEDIUM #1: a channel configured with mode=shadow or
  // enforce that fails to arm (e.g. access.json missing) is a broken
  // opt-in, not informational. Bump status to warn so the user notices.
  let hasMisconfiguredArm = false;
  for (const [ch, state] of Object.entries(runtime.channels)) {
    if (!state) continue;
    const s = state as {
      mode: string;
      armed: boolean;
      configured: boolean;
      reason?: string;
    };
    if (!s.configured) continue;
    const tag = s.armed ? "armed" : "disarmed";
    if (!s.armed && s.mode !== "off") hasMisconfiguredArm = true;
    channels.push(
      `${ch}: ${s.mode}/${tag}${s.reason ? ` (${s.reason})` : ""}`
    );
  }
  const warnMsg = warnings.length > 0 ? formatScopeWarnings(warnings) : null;
  if (channels.length === 0) {
    if (warnMsg) {
      return {
        id: "scope-status",
        label: "Scope status",
        status: "warn",
        message: warnMsg,
        hint: "Invalid scope values fail-closed to off — fix the typos and re-run /agent:scope status.",
      };
    }
    return {
      id: "scope-status",
      label: "Scope status",
      status: "ok",
      message: "Channel scope configured but no channels armed",
    };
  }
  if (hasMisconfiguredArm) {
    const message = warnMsg
      ? `${channels.join("; ")} | ${warnMsg}`
      : channels.join("; ");
    return {
      id: "scope-status",
      label: "Scope status",
      status: "warn",
      message,
      hint:
        "A channel is set to shadow/enforce but failed to arm — check governance (e.g. access.json) and run /agent:scope status. The MCP filter is NOT active for that channel.",
    };
  }
  if (warnMsg) {
    return {
      id: "scope-status",
      label: "Scope status",
      status: "warn",
      message: `${channels.join("; ")} | ${warnMsg}`,
      hint: "Invalid scope values fail-closed to off — fix the typos and re-run /agent:scope status.",
    };
  }
  return {
    id: "scope-status",
    label: "Scope status",
    status: "info",
    message: channels.join("; "),
    hint: runtime.anyArmed
      ? "MCP-level filter active. Native Read/Grep/SQLite still bypass — see docs/channel-scope-compat.md"
      : "Configured with mode=off — run /agent:scope wizard to opt in",
  };
}

function formatScopeWarnings(
  warnings: ReturnType<typeof collectScopeConfigWarnings>
): string {
  return (
    "invalid: " +
    warnings
      .map((w) => `${w.channel}.${w.field}=${JSON.stringify(w.raw)}`)
      .join(", ")
  );
}

/**
 * Phase 5: proactive offer to run `/agent:scope wizard` when:
 *   (a) at least one channel detector reports installed + authenticated,
 *   (b) `loadConfig().scope?.<channel>?.mode` is undefined or "off",
 *   (c) the dismiss-marker `~/.claude/agent/.scope-wizard-dismissed`
 *       does NOT exist.
 *
 * Severity is `info` (a suggestion, not a defect). Marker is
 * permanent; users can re-run by removing it. Codex pre-impl WATCH:
 * non-expiring dismissal matches existing per-user marker patterns
 * in this repo.
 */
/**
 * Test-only injection point. Production callers pass no second arg
 * and the real `detectChannels` is used. Tests can substitute a
 * fake to exercise positive-offer paths without depending on the
 * caller's environment having claude-whatsapp paired.
 */
export type _DetectChannelsFn = (...args: unknown[]) => Array<{
  name: string;
  installed: string;
  authenticated: string;
}>;

export function checkScopeWizardAvailable(
  workspace: string,
  _detectChannelsForTest?: _DetectChannelsFn
): DiagnosticCheck {
  // Marker dismisses the offer permanently.
  // `CLAW_SCOPE_DISMISS_MARKER` env var overrides the default path —
  // used by tests to avoid touching the real user's ~/.claude. Codex
  // round 1 LOW #7.
  const markerPath =
    process.env.CLAW_SCOPE_DISMISS_MARKER ||
    path.join(os.homedir(), ".claude", "agent", ".scope-wizard-dismissed");
  if (fs.existsSync(markerPath)) {
    return {
      id: "scope-wizard-available",
      label: "Scope wizard",
      status: "off",
      message: "dismissed",
    };
  }
  let cfg;
  try {
    cfg = loadConfig(workspace);
  } catch {
    return {
      id: "scope-wizard-available",
      label: "Scope wizard",
      status: "off",
      message: "config unreadable",
    };
  }
  // Codex round 1 MEDIUM #2: only offer the wizard for channels with
  // implemented adapters. Today only WhatsApp ships an adapter; the
  // wizard flow itself only describes WA. Telegram/Discord/iMessage
  // detectors may report installed+authenticated but enabling scope
  // for them would be a no-op (mode != off + no adapter = disarmed).
  const SUPPORTED_OFFER_CHANNELS = new Set(["whatsapp"]);
  let installed: string[] = [];
  try {
    const detector = _detectChannelsForTest ?? detectChannels;
    const channels = detector({ cwd: workspace });
    for (const c of channels) {
      // Codex pre-impl LOW #9: tri-state strings, not booleans.
      if (
        SUPPORTED_OFFER_CHANNELS.has(c.name) &&
        c.installed === "yes" &&
        c.authenticated === "yes"
      ) {
        installed.push(c.name);
      }
    }
  } catch {
    // Detector failure is non-fatal — the offer just doesn't fire.
    return {
      id: "scope-wizard-available",
      label: "Scope wizard",
      status: "off",
      message: "detector unavailable",
    };
  }
  // Only offer for channels that are installed + authenticated AND
  // currently `mode: off` (or unconfigured). Skip channels that already
  // have a non-off mode set.
  const offerCandidates = installed.filter((ch) => {
    const sc = cfg.scope?.[ch as keyof typeof cfg.scope] as
      | { mode?: string }
      | undefined;
    return !sc || !sc.mode || sc.mode === "off";
  });
  if (offerCandidates.length === 0) {
    return {
      id: "scope-wizard-available",
      label: "Scope wizard",
      status: "ok",
      message: "no eligible channel for the wizard",
    };
  }
  // Dismiss instruction lives in the MESSAGE (not the hint) because
  // `formatReport` suppresses hints on `info` rows. Codex round 2 LOW.
  return {
    id: "scope-wizard-available",
    label: "Scope wizard",
    status: "info",
    message:
      `${offerCandidates.join(", ")} paired but scope is off — run /agent:scope wizard to opt in (dismiss with: touch ${markerPath})`,
  };
}

// ---------------------------------------------------------------------------
// Phase 5 ship-readiness doctor checks (round-8 follow-up)
// Plan line 561 lists `scope-stale`, `scope-owner-assertion`,
// `scope-schema-drift`. v8 of Phase 5 hadn't implemented them. v9 adds
// all three.
// ---------------------------------------------------------------------------

/**
 * scope-stale — detect when access.json mtime changed without the
 * runtime cache being invalidated. Today the runtime caches detection
 * for 5s (RUNTIME_TTL_MS) and the lifecycle watcher invalidates on
 * `~/.claude/plugins/installed_plugins.json` change. But upstream
 * editing access.json directly (e.g. user adds a new allowFrom JID)
 * doesn't trigger the watcher. This check surfaces the discrepancy:
 * if access.json was modified more than RUNTIME_TTL_MS ago but the
 * runtime cache hasn't observed it, flag warn so the user knows to
 * restart the MCP or wait for the cache window to elapse.
 *
 * Plan line 561 specifically asked for cadence "on-startup +
 * on-config-change + on-MCP-tool-call". This implementation runs at
 * doctor time, which covers on-startup and on-config-change-via-doctor
 * paths. The on-MCP-tool-call cadence is implicit via the 5s TTL.
 */
export function checkScopeStale(workspace: string): DiagnosticCheck {
  let cfg;
  try {
    cfg = loadConfig(workspace);
  } catch {
    return {
      id: "scope-stale",
      label: "Scope staleness",
      status: "off",
      message: "config unreadable",
    };
  }
  if (!cfg.scope) {
    return {
      id: "scope-stale",
      label: "Scope staleness",
      status: "off",
      message: "scope not configured",
    };
  }
  // For each configured channel with mode != off, check the
  // governance file mtime against the runtime cache. The cache key
  // includes the config fingerprint so config changes already
  // invalidate it; this check is about FILE changes outside the
  // config (e.g. access.json edited directly).
  const stale: string[] = [];
  const futureMtime: string[] = [];
  // Codex round-9 LOW: clock-skew guard. A 5-second tolerance covers
  // typical NTP wobble; anything beyond is a real anomaly worth surfacing.
  const CLOCK_SKEW_TOLERANCE_MS = 5_000;
  for (const channel of ["whatsapp"] as const) {
    const sc = cfg.scope[channel];
    if (!sc || !sc.mode || sc.mode === "off") continue;
    const accessPath =
      sc.accessJsonPath && sc.accessJsonPath !== "auto"
        ? sc.accessJsonPath
        : null;
    if (!accessPath) continue; // auto-resolved paths re-detect on each call
    try {
      const stat = fs.statSync(accessPath);
      const ageMs = Date.now() - stat.mtimeMs;
      // Codex round-9 LOW: future-mtime detection. Negative age means
      // the file is "from the future" — clock skew between this host
      // and whatever wrote the file, or a host clock that was just
      // adjusted backwards. Either way the user should know.
      if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
        futureMtime.push(
          `${channel} (access.json mtime ${Math.round(-ageMs / 1000)}s in the future)`
        );
        continue;
      }
      // Codex round-9 LOW: use `>=` to capture the exact 5s boundary
      // instead of silently passing it. Heuristic: flag stale if mtime
      // is between RUNTIME_TTL_MS (5s) and 1h ago.
      if (ageMs >= 5_000 && ageMs < 3_600_000) {
        stale.push(`${channel} (access.json modified ${Math.round(ageMs / 1000)}s ago)`);
      }
    } catch {
      /* file missing → handled by other checks */
    }
  }
  if (futureMtime.length > 0) {
    return {
      id: "scope-stale",
      label: "Scope staleness",
      status: "warn",
      message: `clock skew detected: ${futureMtime.join("; ")}`,
      hint: "Governance file mtime is in the future — possible NTP issue or host clock adjustment. Stale-detection heuristics rely on monotonic local time.",
    };
  }
  if (stale.length > 0) {
    return {
      id: "scope-stale",
      label: "Scope staleness",
      status: "info",
      message: `recent governance edit: ${stale.join("; ")}`,
      hint: "The runtime cache may serve a snapshot up to 5s old; if you JUST edited access.json, wait or run /mcp restart to force a re-read.",
    };
  }
  return {
    id: "scope-stale",
    label: "Scope staleness",
    status: "ok",
    message: "no recent governance edits detected",
  };
}

/**
 * scope-owner-assertion — UX safety: when the agent is acting as
 * channel owner (identity=owner + trust file present), surface that
 * fact so the user remembers they granted full-channel memory access.
 * Plan line 561.
 */
export function checkScopeOwnerAssertion(
  workspace: string
): DiagnosticCheck {
  let cfg;
  try {
    cfg = loadConfig(workspace);
  } catch {
    return {
      id: "scope-owner-assertion",
      label: "Scope owner assertion",
      status: "off",
      message: "config unreadable",
    };
  }
  if (!cfg.scope) {
    return {
      id: "scope-owner-assertion",
      label: "Scope owner assertion",
      status: "off",
      message: "scope not configured",
    };
  }
  const owners: string[] = [];
  for (const channel of ["whatsapp"] as const) {
    const sc = cfg.scope[channel];
    if (!sc || sc.identity !== "owner") continue;
    // Check for the out-of-band trust file
    const trustPath =
      process.env.CLAW_SCOPE_TRUST_DIR
        ? path.join(process.env.CLAW_SCOPE_TRUST_DIR, `${channel}-owner`)
        : path.join(os.homedir(), ".claude", "agent", "scope-trust", `${channel}-owner`);
    if (fs.existsSync(trustPath)) {
      owners.push(channel);
    }
  }
  if (owners.length === 0) {
    return {
      id: "scope-owner-assertion",
      label: "Scope owner assertion",
      status: "ok",
      message: "agent not acting as owner for any channel",
    };
  }
  return {
    id: "scope-owner-assertion",
    label: "Scope owner assertion",
    status: "info",
    message: `agent acting as owner for: ${owners.join(", ")}`,
    hint: "Trust file + identity=owner grants the agent full memory access for this channel's chunks. Revoke via: rm <trust-file> AND /agent:scope wizard to set identity=auto.",
  };
}

/**
 * scope-schema-drift — detect when upstream access.json or messages.db
 * schemas have unrecognized fields/columns. Phase 4a-2.6 v9 implemented
 * the messages.db schema check (rejected on unknown columns). This
 * doctor check surfaces the same condition so the user knows there
 * may be silent loss of per-chat indexing after an upstream upgrade.
 * Plan line 561.
 */
export function checkScopeSchemaDrift(
  workspace: string
): DiagnosticCheck {
  let cfg;
  try {
    cfg = loadConfig(workspace);
  } catch {
    return {
      id: "scope-schema-drift",
      label: "Scope schema drift",
      status: "off",
      message: "config unreadable",
    };
  }
  if (!cfg.scope) {
    return {
      id: "scope-schema-drift",
      label: "Scope schema drift",
      status: "off",
      message: "scope not configured",
    };
  }
  const drifts: string[] = [];
  // Codex round-9 BUG fix: previously a single broad `try/catch`
  // swallowed BOTH lazy-require failures AND schema probe failures,
  // returning silent `ok` even when imports broke in a packaged dist
  // layout. v10 splits the require step from the probe step: a require
  // failure surfaces as `warn` ("probe unavailable") so the user knows
  // we couldn't check. A probe failure (handle null on existing file)
  // remains `warn` ("unsupported schema").
  let openMessagesDb:
    | ((channelDir: string) => { close: () => void } | null)
    | null = null;
  let resolveWhatsappChannelDir:
    | ((c: unknown, ws?: string) => string | null)
    | null = null;
  try {
    openMessagesDb = require("./scope/messages-db.ts").openMessagesDb;
    resolveWhatsappChannelDir =
      require("./scope/runtime.ts").resolveWhatsappChannelDir;
  } catch (err) {
    return {
      id: "scope-schema-drift",
      label: "Scope schema drift",
      status: "warn",
      message: `probe unavailable: ${
        err instanceof Error ? err.message : String(err)
      }`,
      hint: "Schema-drift detection requires the messages-db reader to load. If this fires on a packaged dist, that's a packaging bug — drift can no longer be detected by doctor until fixed.",
    };
  }
  for (const channel of ["whatsapp"] as const) {
    const sc = cfg.scope[channel];
    if (!sc || !sc.mode || sc.mode === "off") continue;
    try {
      const channelDir = resolveWhatsappChannelDir!(cfg, workspace);
      if (channelDir) {
        const handle = openMessagesDb!(channelDir);
        if (!handle) {
          // Could be missing OR schema mismatch. Distinguish by
          // checking the file actually exists.
          const dbPath = path.join(channelDir, "messages.db");
          if (fs.existsSync(dbPath)) {
            drifts.push(`${channel} messages.db unsupported schema`);
          }
        } else {
          handle.close();
        }
      }
    } catch (err) {
      // Probe-time failure on this specific channel (corrupt DB,
      // permission denied). Surface as a per-channel drift entry so
      // the user knows we tried and couldn't.
      drifts.push(
        `${channel} probe failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  if (drifts.length > 0) {
    return {
      id: "scope-schema-drift",
      label: "Scope schema drift",
      status: "warn",
      message: drifts.join("; "),
      hint: "Upstream schema changed in a way ClawCode doesn't recognize. Per-chat indexing is paused for this channel until support is added. File issue at github.com/crisandrews/ClawCode/issues.",
    };
  }
  return {
    id: "scope-schema-drift",
    label: "Scope schema drift",
    status: "ok",
    message: "no schema drift detected",
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runDoctor(
  workspace: string
): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];
  checks.push(checkConfig(workspace));
  checks.push(checkIdentity(workspace));
  checks.push(checkMemoryDir(workspace));
  checks.push(checkSqlite(workspace));
  checks.push(checkQmd(workspace));
  checks.push(checkBootstrap(workspace));
  checks.push(await checkHttpBridge(workspace));
  checks.push(checkMessaging(workspace));
  checks.push(checkDreaming(workspace));
  checks.push(checkCronRegistry(workspace));
  checks.push(checkJq());
  checks.push(checkScopePreEnforceAudit(workspace));
  checks.push(checkScopeBypasses(workspace));
  checks.push(checkScopeQuarantinePending(workspace));
  checks.push(checkScopeIndexerHealth(workspace));
  checks.push(checkScopeStatus(workspace));
  checks.push(checkScopeWizardAvailable(workspace));
  // Phase 5 ship-readiness round-8 follow-up
  checks.push(checkScopeStale(workspace));
  checks.push(checkScopeOwnerAssertion(workspace));
  checks.push(checkScopeSchemaDrift(workspace));

  const summary = { ok: 0, warn: 0, error: 0, info: 0, off: 0 };
  for (const c of checks) summary[c.status]++;

  return {
    workspace,
    ranAt: new Date().toISOString(),
    checks,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Fixes — safe, idempotent, no human judgment required
// ---------------------------------------------------------------------------

/** Create memory/ if missing. */
function fixMemoryDir(workspace: string): FixResult {
  const memoryDir = path.join(workspace, "memory");
  if (fs.existsSync(memoryDir)) {
    return { id: "memory-dir", applied: false, message: "already exists" };
  }
  try {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(path.join(memoryDir, ".dreams"), { recursive: true });
    return { id: "memory-dir", applied: true, message: "created memory/ and memory/.dreams/" };
  } catch (err) {
    return {
      id: "memory-dir",
      applied: false,
      message: `failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Rebuild the SQLite index (sync). Safe — sync is idempotent. */
function fixSqliteSync(workspace: string): FixResult {
  try {
    const db = new MemoryDB(workspace);
    const result = db.sync();
    db.close();
    return {
      id: "sqlite",
      applied: true,
      message: `indexed ${result.indexed}, unchanged ${result.unchanged}, removed ${result.removed}`,
    };
  } catch (err) {
    return {
      id: "sqlite",
      applied: false,
      message: `sync failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Delete BOOTSTRAP.md if identity looks filled in (bootstrap already complete). */
function fixStaleBootstrap(workspace: string): FixResult {
  const bootstrapPath = path.join(workspace, "BOOTSTRAP.md");
  if (!fs.existsSync(bootstrapPath)) {
    return { id: "bootstrap", applied: false, message: "no BOOTSTRAP.md to remove" };
  }
  // Only remove if the identity check would say "filled"
  const identityPath = path.join(workspace, "IDENTITY.md");
  let identityFilled = false;
  try {
    const content = fs.readFileSync(identityPath, "utf-8");
    identityFilled =
      !!content.match(/\*\*Name:\*\*\s*([^\s<][^\n]+)/) &&
      !content.includes("Replace this with");
  } catch {}

  if (!identityFilled) {
    return {
      id: "bootstrap",
      applied: false,
      message: "IDENTITY.md not yet filled — keeping BOOTSTRAP.md",
    };
  }

  try {
    fs.unlinkSync(bootstrapPath);
    return { id: "bootstrap", applied: true, message: "removed stale BOOTSTRAP.md" };
  } catch (err) {
    return {
      id: "bootstrap",
      applied: false,
      message: `failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function runDoctorFix(
  workspace: string
): Promise<FixReport> {
  const fixes: FixResult[] = [];
  fixes.push(fixMemoryDir(workspace));
  fixes.push(fixSqliteSync(workspace));
  fixes.push(fixStaleBootstrap(workspace));

  const postCheck = await runDoctor(workspace);
  return {
    workspace,
    ranAt: new Date().toISOString(),
    fixes,
    postCheck,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const ICONS: Record<CheckStatus, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
  info: "ℹ️",
  off: "⏸️",
};

export function formatReport(report: DiagnosticReport): string {
  const lines: string[] = [];
  lines.push("🩺 Agent Diagnostics");
  lines.push("");
  const labelWidth = Math.max(
    ...report.checks.map((c) => c.label.length),
    12
  );
  for (const c of report.checks) {
    const padded = c.label.padEnd(labelWidth);
    lines.push(`${ICONS[c.status]}  ${padded}  ${c.message}`);
    if (c.hint && c.status !== "ok" && c.status !== "info") {
      lines.push(`   ${" ".repeat(labelWidth)}  → ${c.hint}`);
    }
  }
  lines.push("");
  const s = report.summary;
  const hasProblems = s.error > 0 || s.warn > 0;
  if (!hasProblems) {
    lines.push("All checks passed. Nothing to fix.");
  } else {
    const parts: string[] = [];
    if (s.error > 0) parts.push(`${s.error} error${s.error > 1 ? "s" : ""}`);
    if (s.warn > 0) parts.push(`${s.warn} warning${s.warn > 1 ? "s" : ""}`);
    lines.push(`${parts.join(", ")}. Run \`/agent:doctor --fix\` to attempt auto-repair.`);
  }
  return lines.join("\n");
}

export function formatFixReport(report: FixReport): string {
  const lines: string[] = [];
  lines.push("🔧 Doctor fix");
  lines.push("");
  const applied = report.fixes.filter((f) => f.applied);
  const skipped = report.fixes.filter((f) => !f.applied);
  if (applied.length === 0) {
    lines.push("No fixes applied (nothing auto-fixable).");
  } else {
    for (const f of applied) lines.push(`✅ ${f.id}: ${f.message}`);
  }
  if (skipped.length > 0) {
    lines.push("");
    lines.push("Skipped:");
    for (const f of skipped) lines.push(`⏸️  ${f.id}: ${f.message}`);
  }
  lines.push("");
  lines.push("--- Post-fix diagnostics ---");
  lines.push("");
  lines.push(formatReport(report.postCheck));
  return lines.join("\n");
}
