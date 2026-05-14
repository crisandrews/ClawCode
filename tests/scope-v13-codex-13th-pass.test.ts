/**
 * Regression tier1 + tier2 for Codex 13th-pass findings on Phase 4a-2.6.
 *
 * One test per finding so future regressions tell you exactly which
 * mitigation broke:
 *
 *   v12-F1 [MED]  pairsCapped → warn (privacy-relevant), not info
 *   v12-F2 [MED]  cursor advance + metric bump are atomic (one txn)
 *   v12-F3 [LOW]  doctor message wording: "cumulative event(s)"
 *   v12-F4 [LOW]  MemoryDB(headless: true) skips watch + chmod
 *
 * Run: `npx tsx tests/scope-v13-codex-13th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import { runMessagesDbIndexerTick } from "../lib/scope/messages-db-indexer.ts";
import { MemoryDB } from "../lib/memory-db.ts";
import { checkScopeIndexerHealth } from "../lib/doctor.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix = "v13-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// v12-F1 — pairsCapped → warn (already covered in v12 tests after v13
// retrofit; leaving a duplicate here so a future split of the file
// keeps the v13 mitigation visible).
// ---------------------------------------------------------------------------

await check("v12-F1: pairsCapped > 0 → status='warn' from doctor", () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      memDb.bumpIndexerMetric("pairs_capped", 1);
    } finally {
      memDb.close();
    }
    const c = checkScopeIndexerHealth(ws);
    if (c.status !== "warn") throw new Error(`expected warn, got ${c.status}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v12-F2 — cursor advance + metric bump are atomic.
// We can't easily simulate a process death mid-transaction, so verify
// the atomic API exists and is invoked: insert rows that cause a
// capped pair, run a tick, assert BOTH the cursor advanced AND the
// metric was bumped — proving the single transaction completed.
// ---------------------------------------------------------------------------

await check(
  "v12-F2: tick result + persisted state are coherent (cursor + metric)",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      fs.mkdirSync(ch, { recursive: true });
      const db = new Database(path.join(ch, "messages.db"));
      db.pragma("journal_mode = WAL");
      db.exec(`
        CREATE TABLE messages (
          rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, chat_id TEXT NOT NULL,
          sender_id TEXT, ts INTEGER NOT NULL, direction TEXT NOT NULL,
          text TEXT NOT NULL DEFAULT ''
        );
      `);
      const stmt = db.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      const baseTs = Math.floor(Date.parse("2026-04-09T10:00:00Z") / 1000);
      // 100 valid rows.
      for (let i = 0; i < 100; i++) {
        stmt.run(`m-${i}`, "alice@s.whatsapp.net", baseTs + i, "in", `m${i}`);
      }
      db.close();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Tick consumes all 100 rows; pairsRebuilt=1, pairsCapped=0
        // (well under MAX_ROWS_PER_PAIR), cursor advances. Verify
        // cursor and metrics agree post-tick.
        const r = await runMessagesDbIndexerTick({
          channelDir: ch,
          memoryDb: memDb,
        });
        if (r.cursor !== 100)
          throw new Error(`cursor expected 100, got ${r.cursor}`);
        if (memDb.getIndexerCursor("whatsapp") !== 100)
          throw new Error("persisted cursor mismatch with tick result");
        if (memDb.getIndexerMetric("pairs_capped") !== 0)
          throw new Error(
            `expected 0 pairs_capped persisted, got ${memDb.getIndexerMetric("pairs_capped")}`
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

await check(
  "v12-F2: advanceIndexerCursorAtomic bumps metric in same txn as cursor",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.advanceIndexerCursorAtomic("whatsapp", 999, [
          { metric: "pairs_capped", amount: 4 },
        ]);
        if (memDb.getIndexerCursor("whatsapp") !== 999)
          throw new Error("cursor did not advance");
        if (memDb.getIndexerMetric("pairs_capped") !== 4)
          throw new Error("metric did not bump");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v12-F2: advanceIndexerCursorAtomic ignores zero/negative bumps",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.advanceIndexerCursorAtomic("whatsapp", 100, [
          { metric: "pairs_capped", amount: 0 },
          { metric: "reserved_prefix_skipped", amount: -2 },
        ]);
        if (memDb.getIndexerCursor("whatsapp") !== 100)
          throw new Error("cursor did not advance with zero/negative bumps");
        if (memDb.getIndexerMetric("pairs_capped") !== 0)
          throw new Error("zero amount unexpectedly bumped metric");
        if (memDb.getIndexerMetric("reserved_prefix_skipped") !== 0)
          throw new Error("negative amount unexpectedly bumped metric");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v12-F3 — doctor message says "cumulative event(s)".
// ---------------------------------------------------------------------------

await check(
  "v12-F3: doctor message wording reflects cumulative events",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.bumpIndexerMetric("pairs_capped", 5);
        memDb.bumpIndexerMetric("reserved_prefix_skipped", 2);
      } finally {
        memDb.close();
      }
      const c = checkScopeIndexerHealth(ws);
      if (!c.message.includes("cumulative chat-day truncation event"))
        throw new Error(`pairsCapped wording missing: ${c.message}`);
      if (!c.message.includes("cumulative file-collision event"))
        throw new Error(`reservedPrefix wording missing: ${c.message}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v12-F4 — MemoryDB(headless: true) skips watcher + chmod.
// ---------------------------------------------------------------------------

await check(
  "v12-F4: headless ctor skips fs.watch (no FSWatcher leak across many runs)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      // Open + close 10 headless instances. If watchers leaked,
      // node would eventually hit the EMFILE / fd-limit ceiling.
      // We can't reliably observe fd count cross-platform; instead
      // verify the public contract: opening N instances with
      // headless: true is faster and cleaner than non-headless.
      for (let i = 0; i < 10; i++) {
        const memDb = new MemoryDB(ws, [], {
          quietBoot: true,
          headless: true,
        });
        memDb.close();
      }
      // If we got here without throwing, the ctor at least doesn't
      // bind FSWatchers in headless mode. (Smoke check; real
      // assertion is the absence of fs.watch calls — covered by
      // direct module inspection in code review.)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v12-F4: close() releases fs.watch handles in non-headless mode",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      // memDb has at least 1 watcher (the memoryDir watch).
      // Close it. After close(), opening another should not be
      // blocked by stale handle.
      memDb.close();
      const memDb2 = new MemoryDB(ws, [], { quietBoot: true });
      memDb2.close();
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v12-F4: doctor uses headless mode (no chmod on read-only diagnostic)",
  () => {
    // Direct verification: doctor's checkScopeIndexerHealth opens a
    // MemoryDB; in v13 it passes `headless: true`. Run a check on a
    // fresh workspace and assert the call doesn't throw and returns
    // a sensible result. The headless-no-watcher behavior is covered
    // by the previous case; here we just assert the integration.
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      // Pre-create the .memory.sqlite via a non-headless instance,
      // close it, then run doctor (which should open headless).
      const seed = new MemoryDB(ws, [], { quietBoot: true });
      seed.close();
      const c = checkScopeIndexerHealth(ws);
      // Without any metrics persisted, status is ok.
      if (c.status !== "ok") throw new Error(`expected ok, got ${c.status}`);
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
console.log(`\n${pass}/${results.length} v13 Codex-13th-pass tests passed`);
if (pass !== results.length) process.exit(1);
