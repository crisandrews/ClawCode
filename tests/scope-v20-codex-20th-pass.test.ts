/**
 * Regression tier1+tier2 for Codex 20th-pass findings on Phase 4a-2.6.
 *
 *   v19-F1 [HIGH]   v18→v19 upgrade with existing chunks + ENOENT
 *                   messages.db: `last_open_ms` is null (column added
 *                   nullable in v19, no backfill) → quarantine guard
 *                   skips purge → stale PII forever.
 *   v19-F2 [HIGH]   v18→v19 upgrade with last_rowid > 0:
 *                   `cursor_row_id` is null → F2 walk-back is skipped
 *                   on legacy cursor → rowid reuse undetected.
 *
 * Run: `npx tsx tests/scope-v20-codex-20th-pass.test.ts`
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

function tmpDir(prefix = "v20-"): string {
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

/**
 * Simulate v18→v19 upgrade: a v18 install would have populated
 * `chunks` + `files` (synthetic chunks) and `scope_indexer_cursors`
 * (last_rowid, db_identity, last_reconcile_ms) but NEVER cursor_row_id
 * or last_open_ms (those columns didn't exist). After the upgrade,
 * v19's `ensureIndexerCursorTable` adds the columns nullable. Tests
 * here null those columns explicitly to mirror that state.
 */
function simulateV18UpgradeState(
  workspace: string,
  args: { lastRowid?: number; clearCursorRowId?: boolean; clearLastOpenMs?: boolean } = {}
): void {
  const sqlitePath = path.join(workspace, "memory", ".memory.sqlite");
  const db = new Database(sqlitePath);
  try {
    if (args.clearCursorRowId !== false) {
      db.prepare(
        `UPDATE scope_indexer_cursors SET cursor_row_id = NULL WHERE channel = 'whatsapp'`
      ).run();
    }
    if (args.clearLastOpenMs !== false) {
      db.prepare(
        `UPDATE scope_indexer_cursors SET last_open_ms = NULL WHERE channel = 'whatsapp'`
      ).run();
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// v19-F1 — backfill quarantine trigger for v18→v19 upgrades
// ---------------------------------------------------------------------------

await check(
  "v19-F1: existing chunks + ENOENT + null last_open_ms → backfill seeds last_open_ms past grace → purge fires",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      // Build chunks via a normal tick first.
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "a", chat_id: "alice@s.whatsapp.net", ts: APR, text: "secret" });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.countSyntheticChunksForChannel("whatsapp") !== 1)
          throw new Error("setup: expected 1 chunk");
      } finally {
        memDb.close();
      }

      // Now simulate v18 state: clear last_open_ms (as if v19 column
      // was just added by ensureIndexerCursorTable). Existing chunks
      // remain. Then nuke messages.db.
      simulateV18UpgradeState(ws, { clearLastOpenMs: true });
      for (const ext of ["", "-wal", "-shm"]) {
        try {
          fs.unlinkSync(path.join(channelDir, `messages.db${ext}`));
        } catch {}
      }

      // Fresh MemoryDB to mirror process restart on the upgraded install.
      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      try {
        if (memDb2.getIndexerLastOpenMs("whatsapp") !== null)
          throw new Error("setup: expected last_open_ms null");
        if (memDb2.countSyntheticChunksForChannel("whatsapp") !== 1)
          throw new Error("setup: expected chunk preserved");

        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          dbAbsenceGraceMs: 1_000, // 1 second — grace is well under what the seed produces
        });
        if (t.ran !== false)
          throw new Error("expected ran=false on missing DB");
        if (t.pairsDeleted !== 1)
          throw new Error(
            `v20 F1: backfill didn't fire — pairsDeleted=${t.pairsDeleted}`
          );
        if (memDb2.countSyntheticChunksForChannel("whatsapp") !== 0)
          throw new Error("chunk was not purged");
      } finally {
        memDb2.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v19-F1: NO chunks indexed + ENOENT + null last_open_ms → no backfill, no purge (true first-ever)",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      // No DB ever created. No chunks indexed.
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
          throw new Error(
            `true first-ever absence shouldn't backfill: pairsDeleted=${t.pairsDeleted}`
          );
        // last_open_ms must remain null — backfill should only fire when
        // there's prior indexed state.
        if (memDb.getIndexerLastOpenMs("whatsapp") !== null)
          throw new Error("backfill seeded last_open_ms in true-first-ever path");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v19-F2 — bootstrap cursor_row_id for v18→v19 upgrades
// ---------------------------------------------------------------------------

await check(
  "v19-F2 (v21): legacy cursor + cursor_row_id=null + row unchanged → final state cursor=1, id stamped (walk-back+rescan converges)",
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
        const cursorAfter = memDb.getIndexerCursor("whatsapp");
        if (cursorAfter !== 1)
          throw new Error(`setup: expected cursor=1, got ${cursorAfter}`);
      } finally {
        memDb.close();
      }
      // Simulate v18 state: cursor=1 but cursor_row_id null.
      simulateV18UpgradeState(ws, { clearCursorRowId: true });

      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      try {
        if (memDb2.getIndexerCursorRowId("whatsapp") !== null)
          throw new Error("setup: expected cursor_row_id null");
        // v21 update: bootstrap walks back unconditionally (treats
        // null storedId as untrusted, since rowid reuse may have
        // happened pre-upgrade). The walk-back + rescan re-reads
        // the SAME row "first" and stamps it. Final state is the
        // same as pre-v21 trust path; the walk-back is invisible
        // to the caller for unchanged-row scenarios.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          reconcileThrottleMs: 0,
        });
        if (memDb2.getIndexerCursorRowId("whatsapp") !== "first")
          throw new Error(
            `bootstrap didn't seed cursor_row_id: ${memDb2.getIndexerCursorRowId("whatsapp")}`
          );
        if (memDb2.getIndexerCursor("whatsapp") !== 1)
          throw new Error(
            `cursor regressed unexpectedly during bootstrap: ${memDb2.getIndexerCursor("whatsapp")}`
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
  "v19-F2: legacy cursor + row at cursor missing → force one-time walk-back",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "old", chat_id: "alice@s.whatsapp.net", ts: APR, text: "old-content" });
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
      // Simulate v18 state: cursor=1, cursor_row_id null.
      simulateV18UpgradeState(ws, { clearCursorRowId: true });
      // Add row at higher rowid so cursor (1) <= maxRowid (2), then
      // delete row 1 (without reusing rowid). cursor_row_id null and
      // observed id at rowid=1 is null (row gone). Bootstrap must
      // walk back to 0.
      insertMsg(upstream, { rowid: 2, id: "new", chat_id: "bob@s.whatsapp.net", ts: APR, text: "new-content" });
      upstream.prepare(`DELETE FROM messages WHERE rowid = 1`).run();
      upstream.close();

      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          reconcileThrottleMs: 0,
        });
        // After walk-back to 0 and rescan, row 2 (rowid > 0) is read.
        if (t.rowsConsumed === 0)
          throw new Error("v20 F2: walk-back+rescan didn't fire");
        const bobText = memDb2.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-08"
        );
        if (!bobText?.includes("new-content"))
          throw new Error(`bob's chunk missing after walk-back: ${bobText}`);
      } finally {
        memDb2.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v19-F2: bootstrap stamps cursor_row_id; second tick sees stable id, doesn't walk back",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { rowid: 1, id: "stable", chat_id: "alice@s.whatsapp.net", ts: APR, text: "x" });
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
      simulateV18UpgradeState(ws, { clearCursorRowId: true });

      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Tick 1 (post-upgrade): bootstrap.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          reconcileThrottleMs: 0,
        });
        const cursorAfter1 = memDb2.getIndexerCursor("whatsapp");
        const idAfter1 = memDb2.getIndexerCursorRowId("whatsapp");
        // Tick 2: id matches → stable, no walk-back.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb2,
          reconcileThrottleMs: 0,
        });
        if (memDb2.getIndexerCursor("whatsapp") !== cursorAfter1)
          throw new Error(
            `cursor regressed on stable post-bootstrap tick: ${memDb2.getIndexerCursor("whatsapp")} vs ${cursorAfter1}`
          );
        if (memDb2.getIndexerCursorRowId("whatsapp") !== idAfter1)
          throw new Error(
            `cursor_row_id changed unexpectedly: ${memDb2.getIndexerCursorRowId("whatsapp")} vs ${idAfter1}`
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
console.log(`\n${pass}/${results.length} v20 Codex-20th-pass tests passed`);
if (pass !== results.length) process.exit(1);
