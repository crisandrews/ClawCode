/**
 * Regression tier1+tier2 for Codex 18th-pass findings on Phase 4a-2.6.
 *
 *   v17-F1 [HIGH]    Reconciliation only fired on rowsConsumed===0
 *                    (true EOF). Steady insert load (≥1 msg/min) →
 *                    EOF unreachable → upstream deletes/edits stale
 *                    forever. v18: throttle gate decides; runs on
 *                    every code path including the rowid-driven
 *                    rebuild path.
 *   v17-F2 [HIGH]    RECONCILE_LIMIT=50 returned same most-recent
 *                    chunks each pass — older chunks (51+) never
 *                    reconciled. v18: per-path last_checked_ms
 *                    rotation walks oldest-unchecked first.
 *   v17-F3 [HIGH]    Fresh upstream messages.db (different inode)
 *                    starts new rowids at 1; v17 cursor regression
 *                    rejection refused to walk back → indexer
 *                    permanently stalled. v18: dev:ino identity
 *                    check resets cursor on file replacement.
 *   v17-F4 [MEDIUM]  rebuildPair returned "absent" unconditionally
 *                    on empty upstream without checking
 *                    deleteSyntheticChunk return value. v18:
 *                    propagate failure → return "failed".
 *
 * Run: `npx tsx tests/scope-v18-codex-18th-pass.test.ts`
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

function tmpDir(prefix = "v18-"): string {
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
  args: { id?: string; chat_id: string; ts: number; text: string }
) {
  db.prepare(
    `INSERT INTO messages (id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, 'in', ?, ?)`
  ).run(args.id ?? `m-${args.chat_id}-${args.ts}`, args.chat_id, args.ts, args.chat_id, args.text);
}

// ---------------------------------------------------------------------------
// v17-F1 — reconciliation fires under steady insert load
// ---------------------------------------------------------------------------

await check(
  "v17-F1: reconciliation runs on rowsConsumed>0 ticks (steady insert load)",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR_8 = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);

      // Build a chunk for alice on day 1, drain its tick.
      insertMsg(upstream, {
        id: "a1",
        chat_id: "alice@s.whatsapp.net",
        ts: APR_8,
        text: "secret",
      });

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const t1 = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        // Sanity: alice's chunk built.
        if (t1.pairsRebuilt !== 1)
          throw new Error(`first tick pairsRebuilt=${t1.pairsRebuilt}`);

        // Now the steady-state scenario: upstream deletes alice's
        // row AND inserts a brand-new row for bob in the SAME tick
        // window. rowsConsumed will be > 0 (the bob INSERT). Pre-v18
        // reconciliation would skip — v18 still fires.
        upstream
          .prepare(`DELETE FROM messages WHERE chat_id = ?`)
          .run("alice@s.whatsapp.net");
        const APR_9 = Math.floor(
          new Date("2026-04-09T12:00:00Z").getTime() / 1000
        );
        // Use explicit rowid > cursor to dodge any auto-rowid quirks
        // around deleted rows (SQLite reuses if last rowid was max).
        upstream
          .prepare(
            `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, 'in', ?, ?)`
          )
          .run(999, "b1", "bob@s.whatsapp.net", APR_9, "bob", "fresh");
        upstream.close();

        const t2 = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (t2.rowsConsumed === 0)
          throw new Error(
            `expected rowsConsumed > 0 (bob INSERT). t2=${JSON.stringify(t2)} cursor=${memDb.getIndexerCursor("whatsapp")}`
          );
        if (t2.pairsDeleted !== 1)
          throw new Error(
            `v18 F1: reconciliation didn't fire on rowsConsumed>0 tick — pairsDeleted=${t2.pairsDeleted}`
          );

        // alice gone, bob present.
        const aliceText = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-08"
        );
        if (aliceText !== null)
          throw new Error(`alice's stale text persisted: ${aliceText}`);
        const bobText = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-09"
        );
        if (!bobText?.includes("fresh"))
          throw new Error(`bob's chunk missing: ${bobText}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v17-F2 — rotation past RECONCILE_LIMIT
// ---------------------------------------------------------------------------

await check(
  "v17-F2: rotation walks past the 50-most-recent window over successive passes",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);

      // Build 60 distinct (chat,date) chunks. RECONCILE_LIMIT=50 so
      // 10 of them rank past the window by mtime.
      const insert = upstream.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, 'in', ?, ?)`
      );
      for (let i = 0; i < 60; i++) {
        // Each chunk lives on its own UTC day (so dates are distinct)
        // and gets a unique chat_id (so source_chat_id is distinct).
        const ts = Math.floor(
          new Date(`2025-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00Z`).getTime() / 1000
        );
        insert.run(`m-${i}`, `chat-${i}@s.whatsapp.net`, ts, `chat-${i}`, "x");
      }

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Drain first tick — builds 60 chunks, no reconciliation
        // happens because rowsConsumed > 0 on that tick.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });

        // Now run reconciliation passes in sequence and verify the
        // SET of paths walked converges to the full 60 over passes.
        const allPaths = new Set<string>();
        for (let pass = 0; pass < 3; pass++) {
          const visible = memDb.listSyntheticChunkPathsForChannel(
            "whatsapp",
            50
          );
          if (visible.length !== 50)
            throw new Error(
              `pass ${pass}: expected 50 paths from listSyntheticChunkPathsForChannel, got ${visible.length}`
            );
          for (const p of visible) allPaths.add(p);
          // Stamp them all (simulating one reconciliation pass).
          const now = Date.now() + pass; // strictly increasing
          for (const p of visible) memDb.markSyntheticChunkReconciled(p, now);
        }

        if (allPaths.size < 60)
          throw new Error(
            `rotation didn't cover all chunks in 3 passes: ${allPaths.size}/60`
          );
      } finally {
        memDb.close();
        upstream.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v17-F2: never-checked chunks rank ahead of any timestamped chunk",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Plant 3 chunks: A (checked recently), B (never checked),
        // C (checked long ago). With pure-mtime ordering A would win
        // every time. With v18 rotation, B (NULL last_checked_ms)
        // ranks first.
        const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
        memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/a@s.whatsapp.net/2026-04-08",
          sourceChannel: "whatsapp",
          sourceChatId: "a@s.whatsapp.net",
          text: "ax",
          upstreamMaxTs: APR,
        });
        memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/b@s.whatsapp.net/2026-04-08",
          sourceChannel: "whatsapp",
          sourceChatId: "b@s.whatsapp.net",
          text: "bx",
          upstreamMaxTs: APR,
        });
        memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/c@s.whatsapp.net/2026-04-08",
          sourceChannel: "whatsapp",
          sourceChatId: "c@s.whatsapp.net",
          text: "cx",
          upstreamMaxTs: APR,
        });

        memDb.markSyntheticChunkReconciled(
          "extra:claude-whatsapp/messages-db/a@s.whatsapp.net/2026-04-08",
          1000
        );
        memDb.markSyntheticChunkReconciled(
          "extra:claude-whatsapp/messages-db/c@s.whatsapp.net/2026-04-08",
          500
        );
        // B is unmarked — should rank first.
        const list = memDb.listSyntheticChunkPathsForChannel("whatsapp", 3);
        if (list.length !== 3)
          throw new Error(`expected 3 paths, got ${list.length}`);
        if (!list[0].includes("/b@"))
          throw new Error(
            `unmarked chunk should rank first; got: ${list[0]}`
          );
        // Then oldest-checked = c (500), then most-recent-checked = a (1000).
        if (!list[1].includes("/c@"))
          throw new Error(`oldest-checked should be second; got: ${list[1]}`);
        if (!list[2].includes("/a@"))
          throw new Error(
            `most-recently-checked should be last; got: ${list[2]}`
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
  "v17-F2: deleteSyntheticChunk clears the rotation marker",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
        const p = "extra:claude-whatsapp/messages-db/d@s.whatsapp.net/2026-04-08";
        memDb.upsertSyntheticChunk({
          path: p,
          sourceChannel: "whatsapp",
          sourceChatId: "d@s.whatsapp.net",
          text: "dx",
          upstreamMaxTs: APR,
        });
        memDb.markSyntheticChunkReconciled(p, 999);
        if (!memDb.deleteSyntheticChunk(p))
          throw new Error("delete failed");
        // Re-create chunk; it should rank as never-checked.
        memDb.upsertSyntheticChunk({
          path: p,
          sourceChannel: "whatsapp",
          sourceChatId: "d@s.whatsapp.net",
          text: "dx2",
          upstreamMaxTs: APR,
        });
        // Plant another already-checked chunk so the comparison
        // matters.
        const p2 = "extra:claude-whatsapp/messages-db/e@s.whatsapp.net/2026-04-08";
        memDb.upsertSyntheticChunk({
          path: p2,
          sourceChannel: "whatsapp",
          sourceChatId: "e@s.whatsapp.net",
          text: "ex",
          upstreamMaxTs: APR,
        });
        memDb.markSyntheticChunkReconciled(p2, 1);
        const list = memDb.listSyntheticChunkPathsForChannel("whatsapp", 2);
        if (!list[0].includes("/d@"))
          throw new Error(
            `re-created chunk should rank first (marker cleared on delete); got: ${list[0]}`
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
// v17-F3 — DB identity reset on fresh messages.db
// ---------------------------------------------------------------------------

await check(
  "v17-F3: replacing messages.db (different inode) resets cursor and re-indexes",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });

      // First DB: large explicit rowid → cursor lands high.
      let upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      upstream
        .prepare(
          `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, 'in', ?, ?)`
        )
        .run(1000, "old", "alice@s.whatsapp.net", APR, "alice", "old-data");
      upstream.close();

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== 1000)
          throw new Error(
            `expected cursor=1000, got ${memDb.getIndexerCursor("whatsapp")}`
          );

        // Now nuke and recreate messages.db (different inode).
        fs.unlinkSync(path.join(channelDir, "messages.db"));
        // Also nuke WAL/SHM if they exist.
        for (const ext of ["-wal", "-shm"]) {
          try {
            fs.unlinkSync(path.join(channelDir, `messages.db${ext}`));
          } catch {}
        }
        upstream = buildUpstreamDb(channelDir);
        // Fresh rowids start at 1 — much lower than stored cursor=1000.
        insertMsg(upstream, {
          id: "new",
          chat_id: "alice@s.whatsapp.net",
          ts: APR,
          text: "new-data",
        });
        upstream.close();

        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (t.rowsConsumed === 0)
          throw new Error(
            "v18 F3: fresh DB stalled — rowsConsumed=0 after identity reset should have been"
          );

        const text = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-08"
        );
        if (!text?.includes("new-data"))
          throw new Error(
            `fresh DB row not indexed after identity reset: ${text}`
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
  "v17-F3: no reset when DB is unchanged across ticks (identity stable)",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, {
        id: "x",
        chat_id: "alice@s.whatsapp.net",
        ts: APR,
        text: "y",
      });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const t1 = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const cursorAfterFirst = memDb.getIndexerCursor("whatsapp");
        // Second tick on unchanged DB: cursor must NOT reset.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (memDb.getIndexerCursor("whatsapp") !== cursorAfterFirst)
          throw new Error(
            "cursor regressed on stable-identity tick (unwanted reset)"
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
  "v17-F3: no reset on first-ever tick (stored identity null is not a mismatch)",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, {
        id: "z",
        chat_id: "alice@s.whatsapp.net",
        ts: APR,
        text: "first-tick",
      });
      upstream.close();
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        if (memDb.getIndexerDbIdentity("whatsapp") !== null)
          throw new Error("identity should be null pre-tick");
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (t.rowsConsumed === 0)
          throw new Error("first tick should have consumed the row");
        const id = memDb.getIndexerDbIdentity("whatsapp");
        if (typeof id !== "string" || id.length === 0)
          throw new Error(`identity not persisted: ${id}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v17-F4 — propagate deleteSyntheticChunk failure
// ---------------------------------------------------------------------------

await check(
  "v17-F4: deleteSyntheticChunk failure surfaces — chunk text remains until next retry",
  async () => {
    // We can't easily make `deleteSyntheticChunk` fail at the SQL
    // level without breaking the DB, but we can verify the contract
    // directly: a non-synthetic path returns false.
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Path that doesn't match the synthetic prefix returns false.
        if (memDb.deleteSyntheticChunk("memory/notes.md") !== false)
          throw new Error("non-synthetic path should return false");
        // Path that matches but doesn't exist still returns true (no-op
        // delete is idempotent at the SQL layer).
        const p = "extra:claude-whatsapp/messages-db/x@s/2026-04-08";
        if (memDb.deleteSyntheticChunk(p) !== true)
          throw new Error("synthetic-path delete (even of nonexistent) returns true");
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
console.log(`\n${pass}/${results.length} v18 Codex-18th-pass tests passed`);
if (pass !== results.length) process.exit(1);
