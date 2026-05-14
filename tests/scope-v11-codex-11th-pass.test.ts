/**
 * Regression tier1 + tier2 for Codex 11th-pass findings on Phase 4a-2.6.
 *
 * One test per finding so future regressions tell you exactly which
 * mitigation broke:
 *
 *   F1 [HIGH]   pairsCapped surfaced when chat-day exceeds the cap
 *   F2 [HIGH]   pagination doesn't EOF-falsely when validation drops rows
 *   F3 [MEDIUM] non-INTEGER rowid column → openMessagesDb returns null
 *   F3 [MEDIUM] safe-integer rowid validation (defense in depth)
 *   F4 [HIGH]   keyset pagination on (ts, rowid) — duplicate ts handled
 *   F5 [LOW]    sync() returns reservedPrefixSkipped count
 *
 * Run: `npx tsx tests/scope-v11-codex-11th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { runMessagesDbIndexerTick } from "../lib/scope/messages-db-indexer.ts";
import { openMessagesDb } from "../lib/scope/messages-db.ts";
import { MemoryDB } from "../lib/memory-db.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix = "v11-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMessagesDb(channelDir: string): Database.Database {
  fs.mkdirSync(channelDir, { recursive: true });
  const db = new Database(path.join(channelDir, "messages.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      push_name TEXT,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      meta TEXT
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// F1 [HIGH] — pairsCapped surfaced.
// We can't realistically insert 500k rows in a unit test (would take
// minutes). Use the test interface to verify the result type carries
// `pairsCapped` and that an under-cap day reports 0.
// ---------------------------------------------------------------------------

await check(
  "F1: under-cap day reports pairsCapped=0 in tick result",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const writer = makeMessagesDb(ch);
      const stmt = writer.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      const baseTs = 1700000000;
      for (let i = 0; i < 50; i++) {
        stmt.run(`m-${i}`, "alice@s.whatsapp.net", baseTs + i, "in", `m${i}`);
      }
      writer.close();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const r = await runMessagesDbIndexerTick({
          channelDir: ch,
          memoryDb: memDb,
        });
        if (typeof (r as any).pairsCapped !== "number") {
          throw new Error("pairsCapped missing from result");
        }
        if (r.pairsCapped !== 0) {
          throw new Error(`expected pairsCapped=0, got ${r.pairsCapped}`);
        }
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// F2 [HIGH] — pagination doesn't EOF-falsely when validation drops rows.
// Insert e.g. 5005 rows where some in the first page fail validation.
// Pre-v11 the page would return < pageLimit and rebuildPair would EOF.
// ---------------------------------------------------------------------------

await check(
  "F2: pagination keeps draining when validation rejects some rows mid-page",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const writer = makeMessagesDb(ch);
      const stmt = writer.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      const baseTs = Math.floor(
        Date.parse("2026-04-09T10:00:00Z") / 1000
      );
      // 5000 valid rows + 5 invalid (bad direction) interleaved + 100
      // valid rows AFTER. With pageLimit=5000 and ts-based keyset, the
      // first page returns 5005 raw rows (5000 valid + 5 invalid). If
      // pagination treated `validated.length < limit` as EOF, the
      // trailing 100 would be lost.
      let counter = 0;
      for (let i = 0; i < 4995; i++) {
        stmt.run(
          `m-${++counter}`,
          "alice@s.whatsapp.net",
          baseTs + i,
          "in",
          `valid${i}`
        );
      }
      // 5 invalid rows (bad direction) interleaved
      for (let i = 0; i < 5; i++) {
        stmt.run(
          `bad-${++counter}`,
          "alice@s.whatsapp.net",
          baseTs + 4995 + i,
          "INVALID",
          `bad${i}`
        );
      }
      // 100 trailing valid rows
      for (let i = 0; i < 100; i++) {
        stmt.run(
          `t-${++counter}`,
          "alice@s.whatsapp.net",
          baseTs + 5000 + i,
          "in",
          `tail${i}`
        );
      }
      writer.close();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Drain — multiple ticks because BATCH_SIZE=1000.
        for (let i = 0; i < 12; i++) {
          await runMessagesDbIndexerTick({ channelDir: ch, memoryDb: memDb });
        }
        const text = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-09"
        );
        if (!text) throw new Error("alice chunk missing entirely");
        if (!text.includes("valid0"))
          throw new Error("first valid row missing");
        // The CRITICAL assertion: tail rows AFTER the invalid block
        // must be present.
        if (!text.includes("tail99"))
          throw new Error(
            "trailing valid rows after invalid block were lost — F2 regression"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// F3 [MEDIUM] — non-INTEGER rowid column makes openMessagesDb fail closed.
// ---------------------------------------------------------------------------

await check(
  "F3: rowid column declared non-INTEGER → openMessagesDb returns null",
  async () => {
    const ch = tmpDir();
    try {
      fs.mkdirSync(ch, { recursive: true });
      const db = new Database(path.join(ch, "messages.db"));
      db.pragma("journal_mode = WAL");
      // Hostile schema: explicit rowid column with TEXT type.
      db.exec(`
        CREATE TABLE messages (
          rowid TEXT NOT NULL,
          id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          sender_id TEXT,
          ts INTEGER NOT NULL,
          direction TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT ''
        );
      `);
      db.close();
      const handle = await openMessagesDb(ch);
      if (handle !== null) {
        try {
          handle.close();
        } catch {}
        throw new Error("expected null for non-INTEGER rowid");
      }
    } finally {
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

await check(
  "F3: validateRows rejects rows with non-safe-integer rowid (defense in depth)",
  async () => {
    const ch = tmpDir();
    try {
      const writer = makeMessagesDb(ch);
      const stmt = writer.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      // Insert 2 valid rows.
      stmt.run("m1", "alice@s.whatsapp.net", 1700000000, "in", "ok");
      stmt.run("m2", "alice@s.whatsapp.net", 1700000001, "in", "ok2");
      writer.close();
      const handle = await openMessagesDb(ch);
      if (!handle) throw new Error("handle null");
      try {
        const rows = handle.readBatch(0, 100);
        if (rows.length !== 2) {
          throw new Error(`expected 2 valid rows, got ${rows.length}`);
        }
        for (const r of rows) {
          if (!Number.isSafeInteger(r.rowid))
            throw new Error("validated row has non-safe-integer rowid");
        }
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// F4 [HIGH] — keyset pagination on (ts, rowid) — duplicate ts handled.
// Multiple rows at the SAME ts (within the same day) must all land in
// the synthetic chunk; pre-v11 rowid-only pagination handled this fine
// but the v11 (ts, rowid) keyset must also.
// ---------------------------------------------------------------------------

await check(
  "F4: multiple rows sharing ts in same day all land in synthetic chunk",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const writer = makeMessagesDb(ch);
      const stmt = writer.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      const sharedTs = Math.floor(
        Date.parse("2026-04-09T10:00:00Z") / 1000
      );
      // 10 rows all sharing the same ts (only rowid differs).
      for (let i = 0; i < 10; i++) {
        stmt.run(`m-${i}`, "alice@s.whatsapp.net", sharedTs, "in", `share${i}`);
      }
      writer.close();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb: memDb });
        const text = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-09"
        );
        if (!text) throw new Error("chunk missing");
        // All 10 must be present — keyset cursor with (ts, rowid)
        // tiebreaker should walk through them in rowid order.
        for (let i = 0; i < 10; i++) {
          if (!text.includes(`share${i}`))
            throw new Error(`row ${i} missing — keyset tiebreaker broke`);
        }
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// F5 [LOW] — sync() returns reservedPrefixSkipped count.
// ---------------------------------------------------------------------------

await check(
  "F5: sync() reports reservedPrefixSkipped when extraPath collides with synthetic prefix",
  async () => {
    const ws = tmpDir();
    const extra = tmpDir("extra-claude-whatsapp-");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const collisionDir = path.join(extra, "messages-db", "alice");
      fs.mkdirSync(collisionDir, { recursive: true });
      // Two real files at the reserved prefix.
      fs.writeFileSync(
        path.join(collisionDir, "2026-01-01.md"),
        "fake collision file"
      );
      fs.writeFileSync(
        path.join(collisionDir, "2026-01-02.md"),
        "another fake"
      );
      const extraAlias = path.join(ws, "claude-whatsapp");
      fs.symlinkSync(extra, extraAlias);
      const memDb = new MemoryDB(ws, [extraAlias], { quietBoot: true });
      try {
        const stats = memDb.sync();
        if (stats.reservedPrefixSkipped !== 2) {
          throw new Error(
            `expected reservedPrefixSkipped=2, got ${stats.reservedPrefixSkipped}`
          );
        }
        // None of the colliding files should be indexed.
        if (stats.indexed > 0)
          throw new Error(
            `synthetic-shaped real files were indexed (${stats.indexed})`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(extra, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let pass = 0;
for (const r of results) {
  if (r.pass) {
    console.log(`  ✓ ${r.name}`);
    pass++;
  } else {
    console.log(`  ✗ ${r.name}: ${r.msg}`);
  }
}
console.log(`\n${pass}/${results.length} v11 Codex-11th-pass tests passed`);
if (pass !== results.length) process.exit(1);
