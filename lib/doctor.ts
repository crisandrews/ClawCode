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
import path from "path";
import http from "http";
import { execSync } from "child_process";
import { loadConfig } from "./config.ts";
import { MemoryDB } from "./memory-db.ts";
import { QmdManager } from "./qmd-manager.ts";

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
