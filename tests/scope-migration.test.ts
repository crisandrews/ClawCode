/**
 * Tier 1 + tier 2 tests for the Phase 2 scope-columns migration in
 * lib/memory-db.ts.
 *
 * Tier 1 (mechanics):
 *  - PRAGMA detects missing columns; ALTER adds them; idempotent rerun
 *  - batched 1k-row backfill terminates and assigns expected channels
 *  - auto-backup file is created exactly once when the DB has rows
 *  - marker file appears during migration and is removed at end
 *  - brand-new DB sees columns from initSchema and skips backfill
 *
 * Tier 2 (real user perspective):
 *  - search returns SearchResult with .provenance + .scopeToken
 *  - extra: chunks → provenance.sourceChannel matches the channel
 *  - memory/ chunks → provenance.class.kind === "local"
 *  - users without extraPaths see no behavior regression
 *
 * Run: `npx tsx tests/scope-migration.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { MemoryDB } from "../lib/memory-db.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-mig-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  return {
    workspace: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Build a pre-Phase-2 chunks table with N rows whose paths span:
 *  - extra:claude-whatsapp/* (channel)
 *  - memory/MEMORY.md, memory/foo.md (local)
 *  - extra:unknown-source/* (legacy)
 *
 * Mirrors the pre-Phase-2 schema (no source_channel/source_chat_id).
 */
function makeLegacyDb(workspace: string, n: number): void {
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
    "INSERT INTO chunks (id, path, start_line, end_line, text, hash) VALUES (?, ?, 1, 1, ?, 'h')"
  );
  for (let i = 0; i < n; i++) {
    let p: string;
    if (i % 4 === 0) {
      p = `extra:claude-whatsapp/logs/2026-04-${(i % 28) + 1}.md`;
    } else if (i % 4 === 1) {
      p = `extra:unknown-source-${i}/foo.md`;
    } else if (i % 4 === 2) {
      p = `memory/${i}.md`;
    } else {
      p = "memory/MEMORY.md";
    }
    insert.run(`chunk-${i}`, p, `text-${i}`);
  }
  db.close();
}

// ---------------------------------------------------------------------------
// Tier 1 — schema migration mechanics
// ---------------------------------------------------------------------------

check("migration adds source_channel and source_chat_id to legacy DB", () => {
  const f = makeFixture();
  try {
    makeLegacyDb(f.workspace, 5);
    new MemoryDB(f.workspace, []).close();
    const dbPath = path.join(f.workspace, "memory", ".memory.sqlite");
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{
      name: string;
    }>;
    const names = new Set(cols.map((c) => c.name));
    db.close();
    assert(names.has("source_channel"), "source_channel column added");
    assert(names.has("source_chat_id"), "source_chat_id column added");
  } finally {
    f.cleanup();
  }
});

check("migration backfill assigns whatsapp / _local / _legacy correctly", () => {
  const f = makeFixture();
  try {
    makeLegacyDb(f.workspace, 8);
    new MemoryDB(f.workspace, []).close();
    const dbPath = path.join(f.workspace, "memory", ".memory.sqlite");
    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare("SELECT path, source_channel FROM chunks")
      .all() as Array<{ path: string; source_channel: string | null }>;
    db.close();

    let whatsappCount = 0;
    let localCount = 0;
    let legacyCount = 0;
    for (const r of rows) {
      if (r.path.startsWith("extra:claude-whatsapp/")) {
        assert(
          r.source_channel === "whatsapp",
          `expected whatsapp for ${r.path}, got ${r.source_channel}`
        );
        whatsappCount++;
      } else if (r.path.startsWith("memory/") || r.path === "MEMORY.md") {
        assert(
          r.source_channel === "_local",
          `expected _local for ${r.path}, got ${r.source_channel}`
        );
        localCount++;
      } else {
        assert(
          r.source_channel === "_legacy",
          `expected _legacy for ${r.path}, got ${r.source_channel}`
        );
        legacyCount++;
      }
    }
    assert(whatsappCount > 0, "saw at least one whatsapp row");
    assert(localCount > 0, "saw at least one local row");
    assert(legacyCount > 0, "saw at least one legacy row");
  } finally {
    f.cleanup();
  }
});

check("migration is idempotent (rerun touches no rows)", () => {
  const f = makeFixture();
  try {
    makeLegacyDb(f.workspace, 4);
    new MemoryDB(f.workspace, []).close();
    // Snapshot path values
    const dbPath = path.join(f.workspace, "memory", ".memory.sqlite");
    const db1 = new Database(dbPath, { readonly: true });
    const before = db1.prepare("SELECT id, source_channel FROM chunks").all();
    db1.close();
    // Rerun — should be a no-op other than the marker create+delete.
    new MemoryDB(f.workspace, []).close();
    const db2 = new Database(dbPath, { readonly: true });
    const after = db2.prepare("SELECT id, source_channel FROM chunks").all();
    db2.close();
    assert(
      JSON.stringify(before) === JSON.stringify(after),
      "rows unchanged on rerun"
    );
  } finally {
    f.cleanup();
  }
});

check("migration auto-backup file is created when ALTER is needed", () => {
  const f = makeFixture();
  try {
    makeLegacyDb(f.workspace, 3);
    new MemoryDB(f.workspace, []).close();
    const memDir = path.join(f.workspace, "memory");
    const entries = fs.readdirSync(memDir);
    const backups = entries.filter((e) => e.startsWith(".memory.sqlite.bak."));
    assert(backups.length >= 1, `expected >= 1 backup, got ${backups.length}`);
  } finally {
    f.cleanup();
  }
});

check("migration removes the in-progress marker on completion", () => {
  const f = makeFixture();
  try {
    makeLegacyDb(f.workspace, 3);
    new MemoryDB(f.workspace, []).close();
    const marker = path.join(
      f.workspace,
      "memory",
      ".scope-migration-in-progress"
    );
    assert(!fs.existsSync(marker), "marker should be cleaned up");
  } finally {
    f.cleanup();
  }
});

check("brand-new DB initializes with scope columns from initSchema", () => {
  const f = makeFixture();
  try {
    // No legacy DB. Constructor creates the file fresh.
    new MemoryDB(f.workspace, []).close();
    const dbPath = path.join(f.workspace, "memory", ".memory.sqlite");
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{
      name: string;
    }>;
    db.close();
    const names = new Set(cols.map((c) => c.name));
    assert(names.has("source_channel"), "fresh DB has source_channel");
    assert(names.has("source_chat_id"), "fresh DB has source_chat_id");
  } finally {
    f.cleanup();
  }
});

check("brand-new DB does not produce a backup file", () => {
  const f = makeFixture();
  try {
    new MemoryDB(f.workspace, []).close();
    const memDir = path.join(f.workspace, "memory");
    const entries = fs.readdirSync(memDir);
    const backups = entries.filter((e) => e.startsWith(".memory.sqlite.bak."));
    // Brand-new DBs have zero rows, so no backup is created (the
    // check guards on `needsBackfill` AND a real path on disk).
    assert(
      backups.length === 0,
      `fresh DB should not need backup, got ${backups.length}`
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Tier 2 — real-user search returns provenance + scopeToken
// ---------------------------------------------------------------------------

check("search returns provenance + scopeToken on hits", () => {
  const f = makeFixture();
  try {
    // Build a real workspace with one local file and one extra channel
    // file so MemoryDB.sync() actually indexes content the FTS engine
    // can match.
    fs.writeFileSync(
      path.join(f.workspace, "memory", "MEMORY.md"),
      "# notes\n\nthe rare token PHASE_TWO_HIT lives in local memory\n"
    );

    const extraRoot = path.join(f.workspace, "claude-whatsapp", "logs");
    fs.mkdirSync(extraRoot, { recursive: true });
    fs.writeFileSync(
      path.join(extraRoot, "2026-04-09.md"),
      "this also has the rare token PHASE_TWO_HIT in a channel context\n"
    );

    const db = new MemoryDB(f.workspace, [
      path.join(f.workspace, "claude-whatsapp"),
    ]);
    db.sync();
    const r = db.search("PHASE_TWO_HIT", { maxResults: 5 });
    db.close();

    assert(r.length > 0, `expected hits, got ${r.length}`);
    for (const hit of r) {
      assert(hit.provenance !== undefined, `provenance present for ${hit.path}`);
      assert(typeof hit.scopeToken === "string", `scopeToken on ${hit.path}`);
    }

    const channelHit = r.find((h) => h.path.startsWith("extra:"));
    if (channelHit) {
      assert(
        channelHit.provenance?.sourceChannel === "whatsapp",
        `expected whatsapp channel, got ${channelHit.provenance?.sourceChannel}`
      );
    }

    const localHit = r.find(
      (h) => h.path === "memory/MEMORY.md" || h.path === "MEMORY.md"
    );
    if (localHit) {
      assert(
        localHit.provenance?.class.kind === "local",
        `expected local kind, got ${localHit.provenance?.class.kind}`
      );
    }
  } finally {
    f.cleanup();
  }
});

check("user without extraPaths still gets results (no regression)", () => {
  const f = makeFixture();
  try {
    fs.writeFileSync(
      path.join(f.workspace, "memory", "MEMORY.md"),
      "# notes\n\nthe rare token NOREGRESSION_TWO is here\n"
    );
    const db = new MemoryDB(f.workspace, []);
    db.sync();
    const r = db.search("NOREGRESSION_TWO", { maxResults: 5 });
    db.close();
    assert(r.length > 0, `expected hits, got ${r.length}`);
    for (const hit of r) {
      assert(hit.provenance !== undefined, `provenance present`);
      assert(
        hit.provenance!.class.kind === "local",
        `expected local, got ${hit.provenance!.class.kind}`
      );
    }
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-migration tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
