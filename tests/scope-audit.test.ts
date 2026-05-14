/**
 * Tier 1 tests for scope audit (Phase 0 of channel-scope compat plan).
 *
 * Covers:
 *  - channel hint derivation reuses CHANNEL_REGISTRY markers
 *  - extra: chunks are surfaced from memory.sqlite
 *  - "source: extra:" lines in MEMORY.md / DREAMS.md are surfaced
 *  - recall state entries with extra: paths are surfaced
 *  - log statements in hot paths are surfaced
 *  - missing / corrupt artifacts are handled gracefully (no throw)
 *
 * Run: `npx tsx tests/scope-audit.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { runScopeAudit, deriveChannelHint } from "../lib/scope-audit.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-scope-audit-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  fs.mkdirSync(path.join(root, "memory", ".dreams"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
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
// Channel hint derivation
// ---------------------------------------------------------------------------

check("deriveChannelHint identifies WhatsApp paths", () => {
  const hint = deriveChannelHint(
    "extra:claude-whatsapp/logs/conversations/abc/2024-01-01.md"
  );
  assert(hint === "whatsapp", `expected whatsapp, got ${hint}`);
});

check("deriveChannelHint identifies Telegram paths", () => {
  const hint = deriveChannelHint(
    "/home/u/.claude/channels/telegram/logs/x.md"
  );
  assert(hint === "telegram", `expected telegram, got ${hint}`);
});

check("deriveChannelHint returns null for unrelated paths", () => {
  assert(deriveChannelHint("memory/some-note.md") === null, "memory note");
  assert(deriveChannelHint("") === null, "empty string");
});

// ---------------------------------------------------------------------------
// Empty / missing workspace
// ---------------------------------------------------------------------------

check("audit reports zero signals on empty workspace", () => {
  const f = makeFixture();
  try {
    const r = runScopeAudit(f.workspace);
    assert(r.summary.extraPathChunkCount === 0, "no extra chunks");
    assert(r.summary.promotedLineCount === 0, "no promoted lines");
    assert(r.summary.recallEntryCount === 0, "no recall leaks");
    assert(r.summary.anySignals === false, "no signals");
    assert(
      r.summary.anyImplementationHints === false,
      "no implementation hints"
    );
  } finally {
    f.cleanup();
  }
});

check("audit handles missing memory.sqlite gracefully", () => {
  const f = makeFixture();
  try {
    // Intentionally no DB created
    const r = runScopeAudit(f.workspace);
    assert(r.summary.extraPathChunkCount === 0, "0 chunks when db missing");
    assert(r.summary.anySignals === false, "no signals");
  } finally {
    f.cleanup();
  }
});

check("audit handles corrupt recall state gracefully", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", ".dreams", "short-term-recall.json"),
      "{ this is not valid json"
    );
    const r = runScopeAudit(f.workspace);
    assert(r.summary.recallEntryCount === 0, "0 on corrupt json");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SQLite chunks audit
// ---------------------------------------------------------------------------

check("audit surfaces extra: chunks in memory.sqlite", () => {
  const f = makeFixture();
  try {
    makeMemoryDb(f.workspace, [
      { path: "memory/MEMORY.md", text: "local fact" },
      {
        path: "extra:claude-whatsapp/logs/2024-01-01.md",
        text: "from whatsapp",
      },
      { path: "extra:telegram/logs/x.md", text: "from telegram" },
    ]);
    const r = runScopeAudit(f.workspace);
    assert(
      r.summary.extraPathChunkCount === 2,
      `expected 2, got ${r.summary.extraPathChunkCount}`
    );
    const hints = new Set(
      r.extraPathChunks.map((c) => c.channelHint).filter(Boolean) as string[]
    );
    assert(hints.has("whatsapp"), "whatsapp hint present");
    assert(hints.has("telegram"), "telegram hint present");
    assert(r.summary.anySignals === true, "anySignals true");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Promoted lines in MEMORY.md / DREAMS.md
// ---------------------------------------------------------------------------

check("audit detects promoted lines citing extra: source", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", "MEMORY.md"),
      [
        "# Memory",
        "",
        "## Promoted by dreaming (2024-01-01)",
        "",
        "- local fact *(score: 0.85, source: memory/note.md#L1)*",
        "- whatsapp leak *(score: 0.75, source: extra:claude-whatsapp/logs/x.md#L3)*",
        "- telegram leak *(score: 0.70, source: extra:telegram/x.md#L1)*",
        "",
      ].join("\n")
    );
    const r = runScopeAudit(f.workspace);
    assert(
      r.summary.promotedLineCount === 2,
      `expected 2, got ${r.summary.promotedLineCount}`
    );
    const hints = new Set(
      r.promotedFromExtra.map((p) => p.channelHint).filter(Boolean) as string[]
    );
    assert(hints.has("whatsapp"), "whatsapp hint present");
    assert(hints.has("telegram"), "telegram hint present");
    assert(r.summary.anySignals === true, "anySignals true");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Recall state leaks
// ---------------------------------------------------------------------------

check("audit detects recall entries with extra: paths (real `entries` shape)", () => {
  // The real shape produced by dreaming.ts wraps entries under an
  // `entries` key alongside `version` + `updatedAt`.
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", ".dreams", "short-term-recall.json"),
      JSON.stringify({
        version: 1,
        updatedAt: "2026-04-25T00:00:00Z",
        entries: {
          "memory/x.md:1:5": { path: "memory/x.md" },
          "extra:claude-whatsapp/y.md:1:10": {
            path: "extra:claude-whatsapp/y.md",
          },
          "extra:telegram/z.md:1:5": { path: "extra:telegram/z.md" },
        },
      })
    );
    const r = runScopeAudit(f.workspace);
    assert(
      r.summary.recallEntryCount === 2,
      `expected 2, got ${r.summary.recallEntryCount}`
    );
    const hints = new Set(
      r.recallStateLeaks.map((p) => p.channelHint).filter(Boolean) as string[]
    );
    assert(hints.has("whatsapp"), "whatsapp hint present");
    assert(hints.has("telegram"), "telegram hint present");
  } finally {
    f.cleanup();
  }
});

check("audit tolerates legacy flat-shape recall (no `entries` wrapper)", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", ".dreams", "short-term-recall.json"),
      JSON.stringify({
        "memory/x.md:1:5": { path: "memory/x.md" },
        "extra:claude-whatsapp/y.md:1:10": {
          path: "extra:claude-whatsapp/y.md",
        },
      })
    );
    const r = runScopeAudit(f.workspace);
    assert(
      r.summary.recallEntryCount === 1,
      `expected 1 from flat shape, got ${r.summary.recallEntryCount}`
    );
  } finally {
    f.cleanup();
  }
});

check("audit ignores recall non-string path values", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", ".dreams", "short-term-recall.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "weird:1": { path: 42 },
          "weird:2": { path: null },
          "good": { path: "extra:whatsapp/x.md" },
        },
      })
    );
    const r = runScopeAudit(f.workspace);
    assert(
      r.summary.recallEntryCount === 1,
      `expected 1, got ${r.summary.recallEntryCount}`
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Log statements in hot paths
// ---------------------------------------------------------------------------

check("audit surfaces console.* and logger.* in hot paths", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "lib", "dreaming.ts"),
      [
        "// no log here",
        'console.log("dream cycle done", snippet);',
        "logger.info('promote', candidate);",
        "// not a log: logToString(x)",
      ].join("\n")
    );
    const r = runScopeAudit(f.workspace);
    assert(
      r.summary.hotPathLogCount >= 2,
      `expected >= 2, got ${r.summary.hotPathLogCount}`
    );
    const previews = r.hotPathLogStatements.map((s) => s.preview).join(" || ");
    assert(/console\.log/.test(previews), "console.log surfaced");
    assert(/logger\.info/.test(previews), "logger.info surfaced");
    // Code-level hints with no real content leak: anySignals stays false,
    // anyImplementationHints flips to true. Doctor maps this to INFO.
    assert(
      r.summary.anySignals === false,
      "anySignals stays false (no content leak)"
    );
    assert(
      r.summary.anyImplementationHints === true,
      "anyImplementationHints true on log statements"
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-audit tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
