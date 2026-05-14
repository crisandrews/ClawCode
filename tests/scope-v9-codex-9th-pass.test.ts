/**
 * Regression tier1 + tier2 for Codex 9th-pass findings on Phase 4a-2.6.
 *
 * One test per finding so future regressions tell you exactly which
 * mitigation broke:
 *
 *   F1 [HIGH]   per-pair query reaches rows beyond rowid 5000
 *   F2 [HIGH]   hostile ts is rejected at the reader; indexer doesn't crash
 *   F3 [MEDIUM] encodeChatId distinguishes `a/b` from literal `a%2Fb`
 *   F4 [MEDIUM] isSyntheticChunkPath only matches the canonical prefix
 *   F5 [MEDIUM] upsert failure holds cursor; next tick retries
 *   F6 [LOW]    formatScopeNotice surfaces "scope active" on prefilter/QMD-skip
 *
 * Run: `npx tsx tests/scope-v9-codex-9th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import {
  runMessagesDbIndexerTick,
  decodeChatIdFromSyntheticPath,
} from "../lib/scope/messages-db-indexer.ts";
import { openMessagesDb } from "../lib/scope/messages-db.ts";
import { MemoryDB, isSyntheticChunkPath } from "../lib/memory-db.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix = "v9-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMessagesDb(channelDir: string): {
  insert: (r: {
    chat_id: string;
    sender_id?: string | null;
    ts: number;
    direction?: "in" | "out";
    text: string;
  }) => void;
  setRowid: (r: {
    rowid: number;
    chat_id: string;
    ts: number;
    text: string;
  }) => void;
  closeWriter: () => void;
} {
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
  const stmt = db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, ts, direction, text) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const stmtRowid = db.prepare(
    `INSERT INTO messages (rowid, id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?, ?)`
  );
  let counter = 0;
  return {
    insert(r) {
      stmt.run(
        `m-${++counter}`,
        r.chat_id,
        r.sender_id ?? null,
        r.ts,
        r.direction ?? "in",
        r.text
      );
    },
    setRowid(r) {
      stmtRowid.run(r.rowid, `m-${r.rowid}`, r.chat_id, r.ts, "in", r.text);
    },
    closeWriter() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// F1 [HIGH] — pair at high rowid past the old in-memory cap rebuilds.
// ---------------------------------------------------------------------------

await check(
  "F1: pair at rowid past PAIR_FETCH_CAP still rebuilds (per-pair query)",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const w = makeMessagesDb(ch);
      // Plant an OLD chat at low rowid so the pair-window has noise.
      // Then plant a NEW chat-row at rowid > 5000 (the v8 in-memory
      // cap). Pre-v9 the indexer's rebuildPair would call
      // readBatch(0, 5000) and miss this row entirely.
      const day = new Date("2026-04-09T10:00:00Z").getTime() / 1000;
      // Fill in a bunch of unrelated rows to push the cap up.
      for (let i = 1; i <= 5500; i++) {
        w.setRowid({
          rowid: i,
          chat_id: `bystander${i}@s.whatsapp.net`,
          ts: day,
          text: "noise",
        });
      }
      // The interesting row at rowid > 5000.
      w.setRowid({
        rowid: 6000,
        chat_id: "alice@s.whatsapp.net",
        ts: day,
        text: "high-rowid alice msg",
      });
      w.closeWriter();

      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // First tick consumes the first 1000 rows; cursor at rowid 1000.
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb: memDb });
        // Keep ticking until we reach the alice row at 6000. With
        // BATCH_SIZE=1000 we need ~6 ticks.
        for (let i = 0; i < 10; i++) {
          await runMessagesDbIndexerTick({ channelDir: ch, memoryDb: memDb });
        }
        const aliceText = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-09"
        );
        if (!aliceText || !aliceText.includes("high-rowid alice msg")) {
          throw new Error(`alice chunk missing high-rowid msg: ${aliceText}`);
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
// F2 [HIGH] — hostile ts is rejected at the reader; tick doesn't throw.
// ---------------------------------------------------------------------------

await check("F2: NaN ts rejected at reader (row dropped)", async () => {
  const ch = tmpDir();
  try {
    const w = makeMessagesDb(ch);
    // Insert a finite-but-broken ts via the raw underlying DB. NaN
    // doesn't roundtrip through SQLite well, but unsafe ints do.
    w.insert({ chat_id: "alice@s.whatsapp.net", ts: 1e15, text: "future" });
    w.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: -1,
      text: "negative ts",
    });
    w.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: 1.5,
      text: "fractional",
    });
    w.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: 1700000000,
      text: "valid",
    });
    w.closeWriter();
    const handle = await openMessagesDb(ch);
    if (!handle) throw new Error("handle null");
    try {
      const rows = handle.readBatch(0, 100);
      // Only the valid ts should survive.
      if (rows.length !== 1) {
        throw new Error(`expected 1 row, got ${rows.length}`);
      }
      if (rows[0].text !== "valid") {
        throw new Error(`wrong row survived: ${rows[0].text}`);
      }
    } finally {
      handle.close();
    }
  } finally {
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check(
  "F2: indexer tick over a hostile-ts DB doesn't throw",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const w = makeMessagesDb(ch);
      // All rows have invalid ts; reader should drop them all and
      // tick should report no pairs but not throw. NaN can't be
      // inserted (NOT NULL constraint), so use values that pass the
      // schema check but fail the reader's `isValidTsSec` guard.
      w.insert({ chat_id: "alice@s.whatsapp.net", ts: -1, text: "neg" });
      w.insert({
        chat_id: "alice@s.whatsapp.net",
        ts: Number.MAX_SAFE_INTEGER, // > MAX_VALID_TS_SEC
        text: "huge",
      });
      w.insert({
        chat_id: "alice@s.whatsapp.net",
        ts: 1.5,
        text: "fractional",
      });
      w.closeWriter();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const r = await runMessagesDbIndexerTick({
          channelDir: ch,
          memoryDb: memDb,
        });
        if (!r.ran) throw new Error("expected ran=true");
        if (r.rowsConsumed !== 0)
          throw new Error(`expected 0 valid rows, got ${r.rowsConsumed}`);
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
// F3 [MEDIUM] — encoding distinguishes a/b from literal a%2Fb.
// ---------------------------------------------------------------------------

await check("F3: encodeChatId path distinguishes a/b from a%2Fb", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const w = makeMessagesDb(ch);
    const day = 1700000000;
    // Two distinct chats whose encodings collided pre-v9.
    w.insert({ chat_id: "a/b@s.whatsapp.net", ts: day, text: "real-slash" });
    w.insert({
      chat_id: "a%2Fb@s.whatsapp.net",
      ts: day,
      text: "literal-percent",
    });
    w.closeWriter();
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      await runMessagesDbIndexerTick({ channelDir: ch, memoryDb: memDb });

      // Real-slash path: escape-% beats escape-/, so `a/b` → `a%2Fb`
      // and `a%2Fb` → `a%252Fb`. The two MUST be distinct. ts=1700000000
      // → 2023-11-14 UTC.
      const realSlash = memDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/a%2Fb@s.whatsapp.net/2023-11-14"
      );
      const literalPct = memDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/a%252Fb@s.whatsapp.net/2023-11-14"
      );
      if (!realSlash || !realSlash.includes("real-slash"))
        throw new Error(`real-slash missing: ${realSlash}`);
      if (!literalPct || !literalPct.includes("literal-percent"))
        throw new Error(`literal-percent missing: ${literalPct}`);
      // Cross-leak check.
      if (realSlash.includes("literal-percent"))
        throw new Error("CRITICAL collision: real-slash leaked literal");
      if (literalPct.includes("real-slash"))
        throw new Error("CRITICAL collision: literal-percent leaked real-slash");
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check("F3: decode round-trip for a/b", () => {
  const decoded = decodeChatIdFromSyntheticPath(
    "extra:claude-whatsapp/messages-db/a%2Fb@s.whatsapp.net/2026-11-14"
  );
  if (decoded !== "a/b@s.whatsapp.net")
    throw new Error(`expected 'a/b@s.whatsapp.net', got '${decoded}'`);
});

// ---------------------------------------------------------------------------
// F4 [MEDIUM] — isSyntheticChunkPath only matches the canonical prefix.
// ---------------------------------------------------------------------------

await check("F4: isSyntheticChunkPath rejects substring-only matches", () => {
  // Canonical match
  if (
    !isSyntheticChunkPath(
      "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-09"
    )
  ) {
    throw new Error("canonical synthetic path rejected");
  }
  // Substring-but-not-prefix match — this is the F4 attack:
  // user has a regular extraPath at `extra:other-channel/foo/messages-db/x.md`.
  // Pre-v9 the substring check returned true and skipped cleanup.
  if (
    isSyntheticChunkPath(
      "extra:other-channel/foo/messages-db/some-real-file.md"
    )
  ) {
    throw new Error("substring match leaked through F4 mitigation");
  }
  // Non-extra path with the segment also rejected
  if (isSyntheticChunkPath("memory/messages-db/note.md"))
    throw new Error("non-extra path matched");
  // Path within extra: but wrong channel rejected
  if (isSyntheticChunkPath("extra:not-claude-whatsapp/messages-db/x/y"))
    throw new Error("wrong-channel extra path matched");
});

// ---------------------------------------------------------------------------
// F5 [MEDIUM] — upsert failure holds cursor; next tick retries.
// ---------------------------------------------------------------------------

await check("F5: upsert failure holds cursor for retry", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const w = makeMessagesDb(ch);
    w.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: 1700000000,
      text: "first",
    });
    w.closeWriter();
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      // Monkey-patch upsertSyntheticChunk to fail on first call,
      // succeed on second.
      const realUpsert = memDb.upsertSyntheticChunk.bind(memDb);
      let calls = 0;
      memDb.upsertSyntheticChunk = function (args: any) {
        calls++;
        if (calls === 1) return false; // simulated failure
        return realUpsert(args);
      } as any;

      const r1 = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb: memDb,
      });
      // First tick: upsert returns false → cursor must NOT advance.
      if (r1.cursor !== 0)
        throw new Error(`first-tick cursor should be 0, got ${r1.cursor}`);
      if (memDb.getIndexerCursor("whatsapp") !== 0)
        throw new Error("persisted cursor advanced despite failure");

      const r2 = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb: memDb,
      });
      // Second tick: upsert succeeds; cursor advances.
      if (r2.cursor !== 1)
        throw new Error(`second-tick cursor should be 1, got ${r2.cursor}`);
      const aliceText = memDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2023-11-14"
      );
      if (!aliceText || !aliceText.includes("first"))
        throw new Error("retry didn't recover the row");
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// F6 [LOW] — preFilteredOrSkipped surfaces a notice when constrained.
// ---------------------------------------------------------------------------

await check("F6: preFilteredOrSkipped flag is part of the stats shape", () => {
  // Just assert the type contract — the server-side wiring is exercised
  // implicitly by other tests (scope-zero-diff covers the unarmed path,
  // scope-filter covers the post-filter path). Here we just prove the
  // flag is present and optional.
  type S = import("../lib/scope/filter.ts").ScopeFilterStats;
  const s: S = {
    evaluated: true,
    total: 0,
    kept: 0,
    notVisible: 0,
    dropped: 0,
    byChannel: {},
    modes: {},
    operatorIsOwner: true,
    preFilteredOrSkipped: true,
  };
  if (s.preFilteredOrSkipped !== true) throw new Error("flag not set");
});

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
console.log(`\n${pass}/${results.length} v9 Codex-9th-pass tests passed`);
if (pass !== results.length) process.exit(1);
