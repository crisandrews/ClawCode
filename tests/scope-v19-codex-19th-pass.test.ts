/**
 * Regression tier1+tier2 for Codex 19th-pass findings on Phase 4a-2.6.
 *
 *   v18-F1 [HIGH]    Same-inode truncation: dev:ino stable but
 *                    MAX(rowid) regresses below cursor → indexer
 *                    silently skips every new row forever.
 *   v18-F2 [HIGH]    SQLite INTEGER PRIMARY KEY without AUTOINCREMENT
 *                    reuses deleted-max rowid → new row at rowid===
 *                    cursor never consumed.
 *   v18-F3 [HIGH]    Confirmed-absent messages.db: stale synthetic
 *                    chunks remain searchable forever (no
 *                    quarantine).
 *   v18-F4 [MEDIUM]  Rowid-driven rebuilds didn't stamp rotation
 *                    marker → freshly-built chunks ranked first in
 *                    next reconciliation pass under sustained
 *                    ingestion.
 *
 * Run: `npx tsx tests/scope-v19-codex-19th-pass.test.ts`
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

function tmpDir(prefix = "v19-"): string {
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

function insertMsg(
  db: Database.Database,
  args: { id?: string; rowid?: number; chat_id: string; ts: number; text: string }
) {
  if (args.rowid !== undefined) {
    db.prepare(
      `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, 'in', ?, ?)`
    ).run(args.rowid, args.id ?? `m-${args.rowid}`, args.chat_id, args.ts, args.chat_id, args.text);
  } else {
    db.prepare(
      `INSERT INTO messages (id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, 'in', ?, ?)`
    ).run(args.id ?? `m-${args.chat_id}-${args.ts}`, args.chat_id, args.ts, args.chat_id, args.text);
  }
}

// ---------------------------------------------------------------------------
// v18-F1 — same-inode truncation
// ---------------------------------------------------------------------------

await check(
  "v18-F1: same-inode truncation (rows deleted in place) resets cursor and re-indexes",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      // Plant rows at high rowids so cursor lands well above any
      // reuse threshold.
      insertMsg(upstream, { rowid: 5000, id: "x1", chat_id: "alice@s.whatsapp.net", ts: APR, text: "old" });
      insertMsg(upstream, { rowid: 5001, id: "x2", chat_id: "alice@s.whatsapp.net", ts: APR, text: "older" });

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== 5001)
          throw new Error(
            `expected cursor=5001, got ${memDb.getIndexerCursor("whatsapp")}`
          );

        // In-place truncation: DELETE all rows + insert at rowid=1.
        // Same inode (we don't unlink the file). Cursor is 5001 →
        // MAX(rowid) is 1 after this. Pre-v19 the cursor sticks at
        // 5001 forever and the new row at rowid=1 is invisible.
        upstream.exec(`DELETE FROM messages`);
        insertMsg(upstream, { rowid: 1, id: "fresh", chat_id: "alice@s.whatsapp.net", ts: APR, text: "fresh-content" });
        upstream.close();

        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (t.rowsConsumed === 0)
          throw new Error(
            `v19 F1: indexer stalled after in-place truncation. cursor=${memDb.getIndexerCursor("whatsapp")}`
          );

        const text = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-08"
        );
        if (!text?.includes("fresh-content"))
          throw new Error(`fresh row not indexed: ${text}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v18-F1: cursor below MAX(rowid) does NOT trigger reset (normal operation)",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "a", chat_id: "alice@s.whatsapp.net", ts: APR, text: "first" });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        // Cursor=1, MAX(rowid)=1. Add row 2.
        insertMsg(upstream, { rowid: 2, id: "b", chat_id: "alice@s.whatsapp.net", ts: APR, text: "second" });
        upstream.close();
        // Tick should NOT reset (cursor 1 ≤ MAX 2).
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== 2)
          throw new Error(
            `cursor regressed unexpectedly: ${memDb.getIndexerCursor("whatsapp")}`
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v18-F2 — cursor row tampering / rowid reuse
// ---------------------------------------------------------------------------

await check(
  "v18-F2: deleted-and-reinserted row at same rowid is detected and re-indexed",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR_8 = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      const APR_9 = Math.floor(new Date("2026-04-09T12:00:00Z").getTime() / 1000);
      // Single row at rowid=1.
      insertMsg(upstream, { rowid: 1, id: "first", chat_id: "alice@s.whatsapp.net", ts: APR_8, text: "alpha" });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const cursor1 = memDb.getIndexerCursor("whatsapp");
        if (cursor1 !== 1)
          throw new Error(`expected cursor=1, got ${cursor1}`);
        const storedRowId = memDb.getIndexerCursorRowId("whatsapp");
        if (storedRowId !== "first")
          throw new Error(`expected stored cursor_row_id='first', got ${storedRowId}`);

        // Delete row 1, insert new row — without AUTOINCREMENT,
        // SQLite reuses rowid=1.
        upstream.prepare(`DELETE FROM messages WHERE rowid = 1`).run();
        insertMsg(upstream, {
          chat_id: "bob@s.whatsapp.net",
          ts: APR_9,
          text: "replaced-content",
          id: "second",
        });
        // Verify SQLite did reuse rowid=1.
        const reusedRow = upstream
          .prepare(`SELECT rowid, id FROM messages`)
          .get() as { rowid: number; id: string };
        if (reusedRow.rowid !== 1)
          throw new Error(
            `test setup invalid: SQLite did not reuse rowid; got ${reusedRow.rowid}`
          );
        upstream.close();

        // Without v19 F2, cursor=1 + WHERE rowid > 1 = no rows → tick
        // sees nothing. With v19 F2, cursor row id mismatch detected
        // → walk back to 0 → re-read row 1.
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (t.rowsConsumed === 0)
          throw new Error(
            `v19 F2: rowid reuse not detected. cursor=${memDb.getIndexerCursor("whatsapp")}`
          );
        const bobText = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-09"
        );
        if (!bobText?.includes("replaced-content"))
          throw new Error(`replaced row not indexed: ${bobText}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v18-F2: cursor row id matches stored → no re-read, no walk-back",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "first", chat_id: "alice@s.whatsapp.net", ts: APR, text: "x" });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== 1)
          throw new Error("first tick should have advanced cursor to 1");
        // Second tick on unchanged DB: cursor should NOT walk back.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== 1)
          throw new Error(
            "v19 F2: cursor regressed on stable DB (false-positive tampering detection)"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v18-F2: getIndexerCursorRowId is null pre-tick, set after",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 7, id: "row-7", chat_id: "alice@s.whatsapp.net", ts: APR, text: "y" });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        if (memDb.getIndexerCursorRowId("whatsapp") !== null)
          throw new Error("expected null pre-tick");
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const stored = memDb.getIndexerCursorRowId("whatsapp");
        if (stored !== "row-7")
          throw new Error(`expected 'row-7', got ${stored}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v18-F3 — PII quarantine on confirmed absence
// ---------------------------------------------------------------------------

await check(
  "v18-F3: messages.db absent past grace window → all synthetic chunks purged",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "a1", chat_id: "alice@s.whatsapp.net", ts: APR, text: "secret-1" });
      insertMsg(upstream, { rowid: 2, id: "b1", chat_id: "bob@s.whatsapp.net", ts: APR, text: "secret-2" });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Build chunks.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const before = memDb.listSyntheticChunkPathsForChannel("whatsapp", 100);
        if (before.length !== 2)
          throw new Error(`expected 2 chunks, got ${before.length}`);

        // Simulate user removing the WhatsApp pair: nuke messages.db.
        for (const ext of ["", "-wal", "-shm"]) {
          try {
            fs.unlinkSync(path.join(channelDir, `messages.db${ext}`));
          } catch {}
        }
        // Tick with grace=0 → ENOENT detected → past grace → purge.
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          dbAbsenceGraceMs: 0,
        });
        if (t.ran !== false)
          throw new Error("expected ran=false on missing DB");
        if (t.pairsDeleted !== 2)
          throw new Error(
            `expected 2 quarantined chunks, got ${t.pairsDeleted}`
          );
        const after = memDb.listSyntheticChunkPathsForChannel("whatsapp", 100);
        if (after.length !== 0)
          throw new Error(`expected 0 chunks after quarantine, got ${after.length}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v18-F3: messages.db absent within grace window → no quarantine",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "a", chat_id: "alice@s.whatsapp.net", ts: APR, text: "x" });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        for (const ext of ["", "-wal", "-shm"]) {
          try {
            fs.unlinkSync(path.join(channelDir, `messages.db${ext}`));
          } catch {}
        }
        // Default grace window is 24h; we just opened the DB so the
        // absence is well within grace. No purge.
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
        });
        if (t.pairsDeleted !== 0)
          throw new Error(`unexpected purge within grace: ${t.pairsDeleted}`);
        const list = memDb.listSyntheticChunkPathsForChannel("whatsapp", 100);
        if (list.length !== 1)
          throw new Error(`expected chunk preserved, got ${list.length}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v18-F3: first-ever absence (no last_open_ms stored) → no quarantine",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      // No DB ever created.
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          dbAbsenceGraceMs: 0,
        });
        if (t.ran !== false)
          throw new Error("expected ran=false");
        if (t.pairsDeleted !== 0)
          throw new Error(`first-ever absence shouldn't purge: ${t.pairsDeleted}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v18-F4 — rowid-driven rebuild stamps marker
// ---------------------------------------------------------------------------

await check(
  "v18-F4: rowid-driven rebuild marks the chunk path so it doesn't dominate next reconciliation pass",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "x", chat_id: "alice@s.whatsapp.net", ts: APR, text: "x" });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const p = "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-08";
        // Plant a NEVER-checked second chunk via direct upsert.
        memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-08",
          sourceChannel: "whatsapp",
          sourceChatId: "bob@s.whatsapp.net",
          text: "y",
          upstreamMaxTs: APR,
        });
        const list = memDb.listSyntheticChunkPathsForChannel("whatsapp", 2);
        if (list.length !== 2)
          throw new Error(`expected 2, got ${list.length}`);
        // bob is never-checked (NULL last_checked_ms) → ranks first.
        // alice was just stamped by F4 → ranks second.
        if (!list[0].includes("/bob@"))
          throw new Error(
            `v19 F4: rowid-driven rebuild didn't stamp marker — alice still ranks ahead of never-checked bob: ${JSON.stringify(list)}`
          );
        if (!list[1].includes("/alice@"))
          throw new Error(
            `expected alice second, got: ${list[1]}`
          );
      } finally {
        memDb.close();
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
console.log(`\n${pass}/${results.length} v19 Codex-19th-pass tests passed`);
if (pass !== results.length) process.exit(1);
