/**
 * Tier 1 tests for the new scope-related doctor checks (Phase 0).
 *
 * Covers:
 *  - checkScopePreEnforceAudit reports OK on a clean workspace
 *  - checkScopePreEnforceAudit reports WARN with summary on signals
 *  - checkScopeBypasses always returns the info banner
 *  - checkScopeQuarantinePending behavior is type-correct (we don't
 *    mutate the user's real ~/.claude/agent/quarantine, so we just
 *    confirm the function returns a DiagnosticCheck)
 *
 * Run: `npx tsx tests/scope-doctor.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  checkScopePreEnforceAudit,
  checkScopeBypasses,
  checkScopeQuarantinePending,
} from "../lib/doctor.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, msg: (err as Error).message });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface Fixture {
  workspace: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-scope-doc-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  return {
    workspace: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function makeMemoryDb(
  workspace: string,
  rows: Array<{ path: string; text: string }>
) {
  const dbPath = path.join(workspace, "memory", ".memory.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, hash TEXT, mtime INTEGER, size INTEGER
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER,
      end_line INTEGER, text TEXT NOT NULL, hash TEXT
    );
  `);
  const insert = db.prepare(
    "INSERT INTO chunks (id, path, start_line, end_line, text, hash) VALUES (?, ?, 1, 10, ?, ?)"
  );
  let idx = 0;
  for (const r of rows) {
    insert.run(`chunk-${idx}`, r.path, r.text, "h");
    idx++;
  }
  db.close();
}

// ---------------------------------------------------------------------------
// checkScopePreEnforceAudit
// ---------------------------------------------------------------------------

check("checkScopePreEnforceAudit returns ok on clean workspace", () => {
  const f = makeFixture();
  try {
    const r = checkScopePreEnforceAudit(f.workspace);
    assert(r.id === "scope-pre-enforce-audit", "id");
    assert(r.status === "ok", `expected ok on clean, got ${r.status}`);
  } finally {
    f.cleanup();
  }
});

check("checkScopePreEnforceAudit returns warn with extra: chunks", () => {
  const f = makeFixture();
  try {
    makeMemoryDb(f.workspace, [
      { path: "memory/MEMORY.md", text: "local" },
      { path: "extra:claude-whatsapp/x.md", text: "channel-derived" },
    ]);
    const r = checkScopePreEnforceAudit(f.workspace);
    assert(r.status === "warn", `expected warn, got ${r.status}`);
    assert(r.message.includes("chunk"), `message mentions chunks: ${r.message}`);
    assert(typeof r.hint === "string" && r.hint.length > 0, "has hint");
  } finally {
    f.cleanup();
  }
});

check("checkScopePreEnforceAudit returns warn with promoted lines", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", "MEMORY.md"),
      "- leak *(score: 0.7, source: extra:whatsapp/x.md#L1)*\n"
    );
    const r = checkScopePreEnforceAudit(f.workspace);
    assert(r.status === "warn", `expected warn, got ${r.status}`);
    assert(
      r.message.includes("promoted") || r.message.includes("line"),
      `message mentions promoted/line: ${r.message}`
    );
  } finally {
    f.cleanup();
  }
});

check("checkScopePreEnforceAudit returns info on implementation hints only", () => {
  const f = makeFixture();
  try {
    // No content leaks (no extra: chunks, no promoted lines, no recall
    // entries) but a log statement in a hot path. Doctor should report
    // INFO — code-level signal, not a real content leak.
    fs.mkdirSync(path.join(f.workspace, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(f.workspace, "lib", "dreaming.ts"),
      'console.log("snippet", x);\n'
    );
    const r = checkScopePreEnforceAudit(f.workspace);
    assert(r.status === "info", `expected info, got ${r.status}`);
    assert(
      r.message.includes("hint") || r.message.includes("log"),
      `message mentions hints/log: ${r.message}`
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// checkScopeBypasses
// ---------------------------------------------------------------------------

check("checkScopeBypasses always returns info", () => {
  const r = checkScopeBypasses("/any/workspace");
  assert(r.id === "scope-bypasses", "id");
  assert(r.status === "info", `expected info, got ${r.status}`);
  assert(
    r.message.includes("filesystem sandbox") || r.message.includes("MCP"),
    `message mentions sandbox/MCP: ${r.message}`
  );
});

// ---------------------------------------------------------------------------
// checkScopeQuarantinePending
// ---------------------------------------------------------------------------

check("checkScopeQuarantinePending returns DiagnosticCheck shape", () => {
  // We can't safely manipulate the real ~/.claude/agent/quarantine.
  // Just confirm the function returns a well-formed result.
  const r = checkScopeQuarantinePending("/any/workspace");
  assert(r.id === "scope-quarantine-pending", "id");
  assert(
    r.status === "off" || r.status === "info",
    `expected off|info, got ${r.status}`
  );
  assert(typeof r.message === "string", "has message");
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-doctor tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
