/**
 * Regression tier1+tier2 for Codex 17th-pass findings on Phase 4a-2.6.
 *
 *   v16-F1 [HIGH]    Synthetic chunks never reconciled when upstream
 *                    deletes/edits a (chat,date) without producing new
 *                    rowids — stale text persists in memory_search.
 *   v16-F2 [MEDIUM]  Shadow mode silently skipped QMD when allowlist
 *                    was partial/deny — flipped ranking + results
 *                    while user thought scope was only being observed.
 *   v16-F3 [LOW]     readBatchWithMaxRowid advanced cursor from any
 *                    numeric raw rowid including unsafe integers.
 *                    Hostile huge rowid + valid lower rowid = silent
 *                    skip forever.
 *
 * Run: `npx tsx tests/scope-v17-codex-17th-pass.test.ts`
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

function tmpDir(prefix = "v17-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build a fixture upstream `messages.db` matching claude-whatsapp's
 * schema closely enough to exercise the indexer.
 */
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
  args: { id?: string; chat_id: string; ts: number; text: string; direction?: "in" | "out"; sender_id?: string }
) {
  db.prepare(
    `INSERT INTO messages (id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    args.id ?? `m-${args.chat_id}-${args.ts}`,
    args.chat_id,
    args.ts,
    args.direction ?? "in",
    args.sender_id ?? args.chat_id,
    args.text
  );
}

// ---------------------------------------------------------------------------
// v16-F1 — reconciliation
// ---------------------------------------------------------------------------

await check(
  "v16-F1: deleting all upstream rows for a (chat,date) drops the synthetic chunk on reconciliation",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);

      const APR_8_NOON = Math.floor(new Date("2026-04-08T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { chat_id: "alice@s.whatsapp.net", ts: APR_8_NOON, text: "secret" });

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // First tick (rowsConsumed > 0) → builds synthetic chunk.
        // reconcileThrottleMs:0 doesn't matter here; reconcile only
        // runs on rowsConsumed===0 ticks.
        const t1 = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (!t1.ran) throw new Error("first tick did not run");
        if (t1.pairsRebuilt !== 1) throw new Error(`pairsRebuilt=${t1.pairsRebuilt}`);

        const before = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-08"
        );
        if (!before || !before.includes("secret"))
          throw new Error(`stale text not seeded: ${before}`);

        upstream.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(
          "alice@s.whatsapp.net"
        );
        upstream.close();

        // Second tick: rowsConsumed=0 → reconcile fires (throttle=0).
        const t2 = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (!t2.ran) throw new Error("second tick did not run");
        if (t2.rowsConsumed !== 0)
          throw new Error(`unexpected rowsConsumed: ${t2.rowsConsumed}`);
        if (t2.pairsDeleted !== 1)
          throw new Error(`expected 1 pairDeleted, got ${t2.pairsDeleted}`);

        const after = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-08"
        );
        if (after !== null) throw new Error(`stale text still present: ${after}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v16-F1: editing upstream text without new rowids triggers chunk rewrite via reconciliation",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const APR_9_NOON = Math.floor(
        new Date("2026-04-09T12:00:00Z").getTime() / 1000
      );
      insertMsg(upstream, {
        chat_id: "bob@s.whatsapp.net",
        ts: APR_9_NOON,
        text: "original",
      });

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const path0 =
          "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-09";
        const before = memDb.readSyntheticChunkText(path0);
        if (!before?.includes("original"))
          throw new Error(`expected 'original' in chunk, got ${before}`);

        upstream
          .prepare(`UPDATE messages SET text = 'redacted' WHERE chat_id = ?`)
          .run("bob@s.whatsapp.net");
        upstream.close();

        const t2 = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        if (t2.pairsReconciled !== 1)
          throw new Error(`expected 1 reconciled, got ${t2.pairsReconciled}`);
        const after = memDb.readSyntheticChunkText(path0);
        if (!after?.includes("redacted"))
          throw new Error(`chunk did not pick up edit: ${after}`);
        if (after.includes("original"))
          throw new Error(`old text still present: ${after}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v16-F1: throttle prevents reconciliation from running on back-to-back ticks",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const ts = Math.floor(new Date("2026-04-10T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { chat_id: "carol@s.whatsapp.net", ts, text: "x" });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        // First post-build tick at throttle=0 sets last_reconcile_ms.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        // Now request the default 60s throttle. Even with an upstream
        // delete, reconciliation should NOT run because we just ran.
        upstream.prepare(`DELETE FROM messages`).run();
        upstream.close();
        const t = await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 60_000,
        });
        if (t.pairsDeleted !== 0)
          throw new Error(`throttle ignored: pairsDeleted=${t.pairsDeleted}`);
        if (t.pairsReconciled !== 0)
          throw new Error(`throttle ignored: pairsReconciled=${t.pairsReconciled}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v16-F1: getIndexerLastReconcileMs is null pre-reconcile, set after",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const ts = Math.floor(new Date("2026-04-11T12:00:00Z").getTime() / 1000);
      insertMsg(upstream, { chat_id: "dave@s.whatsapp.net", ts, text: "y" });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        if (memDb.getIndexerLastReconcileMs("whatsapp") !== null)
          throw new Error("last_reconcile_ms should be null pre-tick");
        // Build, then run a no-rows tick with throttle=0 to force reconcile.
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        upstream.close();
        await runMessagesDbIndexerTick({
          channelDir,
          memoryDb: memDb,
          reconcileThrottleMs: 0,
        });
        const lr = memDb.getIndexerLastReconcileMs("whatsapp");
        if (typeof lr !== "number")
          throw new Error(`expected number, got ${lr}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v16-F2 — shadow mode does not skip QMD
// ---------------------------------------------------------------------------

/**
 * Predicate mirror of `searchMemory`'s `skipQmd` (server.ts):
 *
 *   skipQmd =
 *     waAdapter !== null
 *     && runtime.channels.whatsapp?.mode === "enforce"
 *     && Array.isArray(allowedChatIds)
 *
 * If you change this in server.ts, update the mirror and the
 * assertions below.
 */
function computeSkipQmd(args: {
  adapterPresent: boolean;
  mode: "off" | "shadow" | "enforce";
  allowedChatIds: string[] | null;
}): boolean {
  return (
    args.adapterPresent &&
    args.mode === "enforce" &&
    Array.isArray(args.allowedChatIds)
  );
}

await check("v16-F2: shadow + deny-all does NOT skip QMD", () => {
  const skip = computeSkipQmd({
    adapterPresent: true,
    mode: "shadow",
    allowedChatIds: [],
  });
  if (skip)
    throw new Error(
      "shadow mode silently flipped backend off QMD — F2 regression"
    );
});

await check("v16-F2: shadow + partial allowlist does NOT skip QMD", () => {
  const skip = computeSkipQmd({
    adapterPresent: true,
    mode: "shadow",
    allowedChatIds: ["alice@s.whatsapp.net"],
  });
  if (skip)
    throw new Error("shadow mode skipped QMD on partial allowlist");
});

await check("v16-F2: enforce + deny-all DOES skip QMD (pre-existing)", () => {
  const skip = computeSkipQmd({
    adapterPresent: true,
    mode: "enforce",
    allowedChatIds: [],
  });
  if (!skip)
    throw new Error("enforce mode regressed: QMD not skipped under deny-all");
});

await check(
  "v16-F2: enforce + partial allowlist DOES skip QMD (pre-existing)",
  () => {
    const skip = computeSkipQmd({
      adapterPresent: true,
      mode: "enforce",
      allowedChatIds: ["alice@s.whatsapp.net"],
    });
    if (!skip)
      throw new Error("enforce mode regressed: QMD not skipped on partial");
  }
);

await check(
  "v16-F2: enforce + owner unlock (allowedChatIds=null) does NOT skip QMD",
  () => {
    const skip = computeSkipQmd({
      adapterPresent: true,
      mode: "enforce",
      allowedChatIds: null,
    });
    if (skip)
      throw new Error("enforce mode wrongly skipped QMD under owner unlock");
  }
);

await check("v16-F2: no adapter never skips QMD", () => {
  const skip = computeSkipQmd({
    adapterPresent: false,
    mode: "enforce",
    allowedChatIds: [],
  });
  if (skip) throw new Error("missing adapter wrongly skipped QMD");
});

// ---------------------------------------------------------------------------
// v16-F3 — hostile rowid clamp + safe-integer filter
// ---------------------------------------------------------------------------

await check("v16-F3: setIndexerCursor rejects regression", () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      memDb.setIndexerCursor("whatsapp", 1000);
      memDb.setIndexerCursor("whatsapp", 500); // regression — must be ignored
      const v = memDb.getIndexerCursor("whatsapp");
      if (v !== 1000)
        throw new Error(`cursor walked backward: expected 1000, got ${v}`);
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

await check(
  "v16-F3: setIndexerCursor caps at MAX_SAFE_INTEGER",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // 2^60 is finite, > MAX_SAFE_INTEGER (2^53-1).
        memDb.setIndexerCursor("whatsapp", Math.pow(2, 60));
        const v = memDb.getIndexerCursor("whatsapp");
        if (v !== Number.MAX_SAFE_INTEGER)
          throw new Error(
            `expected clamp to MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}), got ${v}`
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
  "v16-F3: advanceIndexerCursorAtomic rejects regression but lands valid bumps",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.setIndexerCursor("whatsapp", 1000);
        // Regression rowid + valid metric — cursor must hold at 1000,
        // metric must still land.
        memDb.advanceIndexerCursorAtomic("whatsapp", 500, [
          { metric: "pairs_capped", amount: 3 },
        ]);
        if (memDb.getIndexerCursor("whatsapp") !== 1000)
          throw new Error("cursor regressed");
        if (memDb.getIndexerMetric("pairs_capped") !== 3)
          throw new Error("valid metric did not land alongside hostile rowid");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v16-F3: hostile huge raw rowid is filtered out (cursor stays safe; valid row at lower rowid is indexed)",
  async () => {
    const ws = tmpDir();
    const channelDir = path.join(ws, "wa");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const upstream = buildUpstreamDb(channelDir);
      const ts = Math.floor(new Date("2026-04-12T12:00:00Z").getTime() / 1000);

      // Both rows get explicit rowids so SQLite's auto-increment can't
      // give us a second unsafe rowid after the hostile one.
      // Valid alice at rowid=1 (safe).
      upstream
        .prepare(
          `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(1, "v-1", "alice@s.whatsapp.net", ts, "in", "alice", "real");

      // Hostile: explicit rowid past MAX_SAFE_INTEGER. SQLite stores it
      // (rowid is 64-bit signed); JS would lose precision past 2^53.
      const HOSTILE = "9007199254740993"; // MAX_SAFE_INTEGER + 2 as bigint
      upstream
        .prepare(
          `INSERT INTO messages (rowid, id, chat_id, ts, direction, sender_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(HOSTILE, "h-1", "evil@s.whatsapp.net", ts, "in", "evil", "trap");

      upstream.close();

      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        await runMessagesDbIndexerTick({ channelDir, memoryDb: memDb });

        // alice's chunk MUST exist — pre-v17 the hostile huge rowid
        // would land in maxRawRowid via the raw scan and the cursor
        // would leap past it, but validateRows would drop the row.
        // alice would be indexed in this tick BUT a future safe row
        // at rowid 2 would be skipped (cursor=huge). v17 filters
        // unsafe rowids out of the maxRawRowid scan so the cursor
        // stays at 1 and future safe rows still get picked up.
        const aliceText = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-12"
        );
        if (!aliceText?.includes("real"))
          throw new Error(`alice chunk missing: ${aliceText}`);

        // The hostile row's text MUST NOT be in any chunk — validateRows
        // drops the row, and (post-v17) the cursor never advanced past
        // the safe-int frontier so we never even tried to chunk it.
        const evilText = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/evil@s.whatsapp.net/2026-04-12"
        );
        if (evilText !== null)
          throw new Error(`hostile row's text was indexed: ${evilText}`);

        // Cursor itself must be a safe integer (≤ MAX_SAFE_INTEGER).
        // Pre-v17 it would be 9007199254740993 (unsafe); v17 filters
        // unsafe raw rowids out of the maxRawRowid scan.
        const cursor = memDb.getIndexerCursor("whatsapp");
        if (!Number.isSafeInteger(cursor))
          throw new Error(`cursor is not a safe integer: ${cursor}`);
        if (cursor !== 1)
          throw new Error(
            `cursor advanced past the safe-int frontier: ${cursor} (expected 1)`
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
console.log(`\n${pass}/${results.length} v17 Codex-17th-pass tests passed`);
if (pass !== results.length) process.exit(1);
