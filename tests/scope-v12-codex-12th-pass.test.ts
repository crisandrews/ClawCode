/**
 * Regression tier1 + tier2 for Codex 12th-pass findings on Phase 4a-2.6.
 *
 * One test per finding so future regressions tell you exactly which
 * mitigation broke:
 *
 *   v11-F1 [MED]  cap lowered to 100k (heap safety)
 *   v11-F3 [LOW]  doctor surfaces pairsCapped + reservedPrefixSkipped
 *
 * The v11-F2 (temp B-tree sort on rowid tie-break) is a perf finding;
 * docs/channel-scope-compat.md tracks it as a future optimization. No
 * regression test — it would require EXPLAIN QUERY PLAN parsing.
 *
 * Run: `npx tsx tests/scope-v12-codex-12th-pass.test.ts`
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

function tmpDir(prefix = "v12-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// v11-F1 — cap is now 100k; under-cap days don't trigger pairsCapped.
// (Verifying we didn't lower it so far that real days would hit it.)
// ---------------------------------------------------------------------------

await check(
  "v11-F1: 5k-row chat-day stays under cap (pairsCapped=0)",
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
      const baseTs = Math.floor(
        Date.parse("2026-04-09T10:00:00Z") / 1000
      );
      // 5000 rows — well under the 100k cap.
      for (let i = 0; i < 5000; i++) {
        stmt.run(`m-${i}`, "alice@s.whatsapp.net", baseTs + i, "in", `m${i}`);
      }
      db.close();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        let totalCapped = 0;
        for (let i = 0; i < 10; i++) {
          const r = await runMessagesDbIndexerTick({
            channelDir: ch,
            memoryDb: memDb,
          });
          totalCapped += r.pairsCapped;
        }
        if (totalCapped !== 0)
          throw new Error(`expected pairsCapped=0, got ${totalCapped}`);
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
// v11-F3 — doctor surfaces metrics persisted by the indexer + sync.
// ---------------------------------------------------------------------------

await check(
  "v11-F3: doctor reports 'ok' when no metrics persisted",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.sync(); // creates the DB shell
      } finally {
        memDb.close();
      }
      const c = checkScopeIndexerHealth(ws);
      if (c.status !== "ok")
        throw new Error(`expected ok, got ${c.status} (${c.message})`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v11-F3: doctor surfaces reservedPrefixSkipped as warn",
  () => {
    const ws = tmpDir();
    const extra = tmpDir("extra-claude-whatsapp-");
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const collisionDir = path.join(extra, "messages-db", "alice");
      fs.mkdirSync(collisionDir, { recursive: true });
      fs.writeFileSync(
        path.join(collisionDir, "2026-01-01.md"),
        "fake collision"
      );
      const extraAlias = path.join(ws, "claude-whatsapp");
      fs.symlinkSync(extra, extraAlias);
      const memDb = new MemoryDB(ws, [extraAlias], { quietBoot: true });
      try {
        memDb.sync();
      } finally {
        memDb.close();
      }
      const c = checkScopeIndexerHealth(ws);
      // v13: collision still surfaces as warn; message reworded
      // (Codex 13th-pass v12-F3) to "cumulative file-collision events"
      // since the counter is event-based, not unique-file-based.
      if (c.status !== "warn")
        throw new Error(`expected warn, got ${c.status}`);
      if (!c.message.includes("file-collision"))
        throw new Error(`unexpected message: ${c.message}`);
      if (!c.hint || !c.hint.includes("rename the extraPath"))
        throw new Error(`expected actionable hint, got: ${c.hint}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(extra, { recursive: true, force: true });
    }
  }
);

await check(
  "v11-F3 + v12-F1: doctor surfaces pairsCapped as warn (privacy-relevant)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.bumpIndexerMetric("pairs_capped", 3);
      } finally {
        memDb.close();
      }
      const c = checkScopeIndexerHealth(ws);
      // Codex 13th-pass MEDIUM v12-F1: pairsCapped > 0 means tail
      // messages from a high-volume day aren't searchable — privacy
      // relevant, so warn (was info pre-v13).
      if (c.status !== "warn")
        throw new Error(`expected warn, got ${c.status}`);
      if (!c.message.includes("3 cumulative chat-day truncation"))
        throw new Error(`unexpected message: ${c.message}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v11-F3: bumpIndexerMetric increments cumulatively",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.bumpIndexerMetric("pairs_capped", 2);
        memDb.bumpIndexerMetric("pairs_capped", 5);
        const v = memDb.getIndexerMetric("pairs_capped");
        if (v !== 7) throw new Error(`expected 7, got ${v}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v11-F3: bumpIndexerMetric ignores non-positive amounts",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.bumpIndexerMetric("pairs_capped", 0);
        memDb.bumpIndexerMetric("pairs_capped", -3);
        const v = memDb.getIndexerMetric("pairs_capped");
        if (v !== 0) throw new Error(`expected 0, got ${v}`);
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
console.log(`\n${pass}/${results.length} v12 Codex-12th-pass tests passed`);
if (pass !== results.length) process.exit(1);
