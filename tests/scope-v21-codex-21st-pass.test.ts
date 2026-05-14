/**
 * Regression tier1+tier2 for Codex 21st-pass findings on Phase 4a-2.6.
 *
 *   v20-F1 [HIGH]   v20 bootstrap branch trusted observed id when
 *                   non-null. If rowid reuse happened BEFORE the
 *                   v18→v19 upgrade, the bootstrap stored the
 *                   replacement id and `WHERE rowid > cursor`
 *                   skipped the replacement row forever.
 *                   v21: walk-back unconditionally on storedId=null.
 *
 * Run: `npx tsx tests/scope-v21-codex-21st-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { MemoryDB } from "../lib/memory-db.ts";
import { runMessagesDbIndexerTick } from "../lib/scope/messages-db-indexer.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix = "v21-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function buildUpstreamDb(channelDir: string): Database.Database {
  fs.mkdirSync(channelDir, { recursive: true });
  const dbPath = path.join(channelDir, "messages.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_messages_chat_ts ON messages(chat_id, ts DESC);
  `);
  return db;
}

function clearCursorRowId(workspace: string): void {
  const sqlitePath = path.join(workspace, "memory", ".memory.sqlite");
  const db = new Database(sqlitePath);
  try {
    db.prepare(
      `UPDATE scope_indexer_cursors SET cursor_row_id = NULL WHERE channel = 'whatsapp'`
    ).run();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// v20-F1 — pre-upgrade rowid reuse must still be detected
// ---------------------------------------------------------------------------

await check(
  "v20-F1: rowid reuse BEFORE v18→v19 upgrade is detected → replacement row indexed",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });

      // Step 1: simulate v18 indexing — plant row at rowid=1, run a tick
      // so cursor advances to 1.
      const upstream = buildUpstreamDb(channelDir);
      const APR_8 = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      upstream
        .prepare(
          `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, 'in', ?, ?)`
        )
        .run(1, "old-id", "alice@s.whatsapp.net", APR_8, "alice", "old-content");

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== 1)
          throw new Error("setup: cursor not at 1");
      } finally {
        memDb.close();
      }

      // Step 2: while OpenCLAUDE is offline (no tick running),
      // upstream deletes the row and inserts a replacement that
      // reuses rowid=1 (SQLite INTEGER PRIMARY KEY without
      // AUTOINCREMENT does this automatically).
      upstream.prepare(`DELETE FROM messages WHERE rowid = 1`).run();
      const APR_9 = Math.floor(new Date("2026-04-09T12:00:00Z").getTime() / 1000);
      upstream
        .prepare(
          `INSERT INTO messages (id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, 'in', ?, ?)`
        )
        .run("new-id", "bob@s.whatsapp.net", APR_9, "bob", "new-content");
      const reusedRow = upstream.prepare(`SELECT rowid FROM messages`).get() as {
        rowid: number;
      };
      if (reusedRow.rowid !== 1)
        throw new Error(
          `test setup invalid: rowid not reused; got ${reusedRow.rowid}`
        );
      upstream.close();

      // Step 3: simulate the v18→v19 upgrade by clearing cursor_row_id.
      // (v18 didn't have the column. v19 ALTERs the column nullable.
      // Stored cursor_row_id is null for any pre-upgrade row.)
      clearCursorRowId(ws);

      // Step 4: post-upgrade tick. Pre-v21 v20 code: observed id is
      // "new-id", stored is null → bootstrap sets cursor_row_id to
      // "new-id", does NOT walk back. WHERE rowid > 1 returns
      // nothing → replacement row never indexed → bob's chunk
      // missing. v21 walks back unconditionally → re-reads rowid=1
      // → indexes the replacement.
      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          reconcileThrottleMs: 0,
        });
        if (t.rowsConsumed === 0)
          throw new Error(
            `v21 F1: pre-upgrade rowid reuse missed — rowsConsumed=${t.rowsConsumed}, cursor=${memDb2.getIndexerCursor("whatsapp")}, cursor_row_id=${memDb2.getIndexerCursorRowId("whatsapp")}`
          );
        const bobText = memDb2.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-09"
        );
        if (!bobText?.includes("new-content"))
          throw new Error(`bob's replacement chunk missing: ${bobText}`);
        // After walk-back + rescan, cursor_row_id should reflect
        // the actual current row at rowid=1 (the replacement).
        if (memDb2.getIndexerCursorRowId("whatsapp") !== "new-id")
          throw new Error(
            `cursor_row_id should now be 'new-id', got: ${memDb2.getIndexerCursorRowId("whatsapp")}`
          );
      } finally {
        memDb2.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v20-F1: unchanged row across v18→v19 upgrade still converges (walk-back+rescan re-stamps same id)",
  async () => {
    // Sanity: the v21 unconditional walk-back must not break the
    // benign case where the row at cursor genuinely hasn't been
    // touched. Walk-back to 0, re-scan reads row 1 (same id),
    // cursor advances back to 1, id stamped.
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      upstream
        .prepare(
          `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, 'in', ?, ?)`
        )
        .run(1, "stable-id", "alice@s.whatsapp.net", APR, "alice", "x");
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
      } finally {
        memDb.close();
      }
      clearCursorRowId(ws);
      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          reconcileThrottleMs: 0,
        });
        if (memDb2.getIndexerCursor("whatsapp") !== 1)
          throw new Error(
            `cursor should converge to 1 after walk-back+rescan, got ${memDb2.getIndexerCursor("whatsapp")}`
          );
        if (memDb2.getIndexerCursorRowId("whatsapp") !== "stable-id")
          throw new Error(
            `cursor_row_id should be 'stable-id', got ${memDb2.getIndexerCursorRowId("whatsapp")}`
          );
      } finally {
        memDb2.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
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
console.log(`\n${pass}/${results.length} v21 Codex-21st-pass tests passed`);
if (pass !== results.length) process.exit(1);
