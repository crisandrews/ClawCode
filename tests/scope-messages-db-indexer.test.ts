/**
 * Tier 1 + tier 2 — `lib/scope/messages-db-indexer.ts`.
 *
 * Tier 1 covers single-tick mechanics:
 *   - empty DB → no-op, ran=true, rowsConsumed=0
 *   - missing DB → ran=false with reason
 *   - first tick over fresh rows → builds synthetic chunks
 *   - cursor advances; second tick is no-op
 *   - upstream writes more rows → next tick picks them up
 *   - per-(chat,date) chunk: all rows for that pair are concatenated
 *   - chat_id with `/` is path-encoded
 *
 * Tier 2 covers the integration with MemoryDB.search + scope filter:
 *   - synthetic chunks land in the index with non-null source_chat_id
 *   - search returns them with correct provenance
 *   - canSee with a partial allowlist filters per-chat (mock adapter)
 *   - readFile of a synthetic path reconstructs the rendered text
 *
 * Run: `npx tsx tests/scope-messages-db-indexer.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMessagesDbIndexerTick } from "../lib/scope/messages-db-indexer.ts";
import { MemoryDB } from "../lib/memory-db.ts";

const Database = (await import("better-sqlite3")).default;

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void | Promise<void>) {
  const r = fn();
  if (r instanceof Promise) {
    return r
      .then(() => results.push({ name, pass: true }))
      .catch((e) => results.push({ name, pass: false, msg: String(e) }));
  }
  try {
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scope-mdb-indexer-"));
}

/** Channel-dir builder: writes upstream-shaped messages.db. */
function makeChannel(dir: string): {
  channelDir: string;
  insert: (r: {
    chat_id: string;
    sender_id?: string | null;
    ts: number;
    direction?: "in" | "out";
    text: string;
  }) => void;
  closeWriter: () => void;
} {
  const channelDir = dir;
  fs.mkdirSync(channelDir, { recursive: true });
  const dbPath = path.join(channelDir, "messages.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      push_name TEXT,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL DEFAULT '',
      meta TEXT
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, push_name, ts, direction, text, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let counter = 0;
  return {
    channelDir,
    insert(r) {
      stmt.run(
        `m-${++counter}`,
        r.chat_id,
        r.sender_id ?? null,
        null,
        r.ts,
        r.direction ?? "in",
        r.text,
        null
      );
    },
    closeWriter() {
      db.close();
    },
  };
}

/** Bare MemoryDB at <ws>/.memory.sqlite. No watching, no extras. */
function makeMemoryDb(ws: string): MemoryDB {
  fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
  return new MemoryDB(ws, [], { quietBoot: true });
}

// ---------------------------------------------------------------------------
// Tier 1
// ---------------------------------------------------------------------------

await check("missing DB → ran=false with reason", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const memoryDb = makeMemoryDb(ws);
    try {
      const r = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (r.ran) throw new Error("expected ran=false");
      if (!r.reason) throw new Error("expected reason");
    } finally {
      memoryDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check("empty DB → ran=true with rowsConsumed=0", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const writer = makeChannel(ch);
    writer.closeWriter();
    const memoryDb = makeMemoryDb(ws);
    try {
      const r = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (!r.ran) throw new Error("expected ran=true");
      if (r.rowsConsumed !== 0)
        throw new Error(`expected 0 rows, got ${r.rowsConsumed}`);
    } finally {
      memoryDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check("first tick builds synthetic chunks per (chat,date)", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const writer = makeChannel(ch);
    // Two chats, same day, plus one different day.
    const day1Ts = new Date("2026-04-09T10:00:00Z").getTime() / 1000;
    const day1Ts2 = new Date("2026-04-09T11:00:00Z").getTime() / 1000;
    const day2Ts = new Date("2026-04-10T08:00:00Z").getTime() / 1000;
    writer.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: day1Ts,
      text: "hi alice",
    });
    writer.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: day1Ts2,
      text: "alice again",
    });
    writer.insert({
      chat_id: "bob@s.whatsapp.net",
      ts: day1Ts,
      text: "hi bob",
    });
    writer.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: day2Ts,
      text: "next day",
    });
    writer.closeWriter();

    const memoryDb = makeMemoryDb(ws);
    try {
      const r = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (!r.ran) throw new Error("expected ran");
      if (r.rowsConsumed !== 4)
        throw new Error(`expected 4 rows, got ${r.rowsConsumed}`);
      if (r.pairsRebuilt !== 3)
        throw new Error(`expected 3 pairs (alice/4-9, bob/4-9, alice/4-10), got ${r.pairsRebuilt}`);

      // Cursor advanced
      if (r.cursor !== 4) throw new Error(`cursor expected 4, got ${r.cursor}`);

      // Synthetic chunks landed with correct chat_id
      const aliceText = memoryDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-09"
      );
      if (!aliceText || !aliceText.includes("hi alice"))
        throw new Error(`alice chunk missing text: ${aliceText}`);
      if (aliceText.includes("hi bob"))
        throw new Error("alice chunk leaked bob's text — CRITICAL");

      const bobText = memoryDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/bob@s.whatsapp.net/2026-04-09"
      );
      if (!bobText || !bobText.includes("hi bob"))
        throw new Error(`bob chunk missing text: ${bobText}`);
      if (bobText.includes("hi alice"))
        throw new Error("bob chunk leaked alice's text — CRITICAL");

      const day2Text = memoryDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-10"
      );
      if (!day2Text || !day2Text.includes("next day"))
        throw new Error("day2 chunk missing");
    } finally {
      memoryDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check("second tick on same DB is a no-op (cursor honored)", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const writer = makeChannel(ch);
    writer.insert({
      chat_id: "alice@s.whatsapp.net",
      ts: 1700000000,
      text: "hello",
    });
    writer.closeWriter();
    const memoryDb = makeMemoryDb(ws);
    try {
      const r1 = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (r1.rowsConsumed !== 1) throw new Error("first tick miss");

      const r2 = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (r2.rowsConsumed !== 0)
        throw new Error(`second tick should be no-op, got ${r2.rowsConsumed}`);
      if (r2.cursor !== r1.cursor) throw new Error("cursor moved on no-op");
    } finally {
      memoryDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check("incremental: new rows after first tick land in next tick", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  fs.mkdirSync(ch, { recursive: true });
  const dbPath = path.join(ch, "messages.db");
  const writerDb = new Database(dbPath);
  writerDb.pragma("journal_mode = WAL");
  writerDb.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, chat_id TEXT NOT NULL,
      sender_id TEXT, push_name TEXT, ts INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT NOT NULL DEFAULT '', meta TEXT
    );
  `);
  const ins = writerDb.prepare(
    `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
  );
  try {
    ins.run("m1", "alice@s.whatsapp.net", 1700000000, "in", "first");
    const memoryDb = makeMemoryDb(ws);
    try {
      const r1 = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (r1.rowsConsumed !== 1) throw new Error("first tick miss");

      // Upstream writes another row for the same chat+date
      ins.run("m2", "alice@s.whatsapp.net", 1700003600, "in", "second");

      const r2 = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (r2.rowsConsumed !== 1)
        throw new Error(`second tick expected 1 row, got ${r2.rowsConsumed}`);
      if (r2.pairsRebuilt !== 1) throw new Error("expected 1 pair rebuilt");

      const t = memoryDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2023-11-14"
      );
      if (!t || !t.includes("first") || !t.includes("second"))
        throw new Error(`expected merged chunk, got: ${t}`);
    } finally {
      memoryDb.close();
    }
  } finally {
    writerDb.close();
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

await check("path-encoded chat_id with slash", async () => {
  const ws = tmpDir();
  const ch = tmpDir();
  try {
    const writer = makeChannel(ch);
    writer.insert({
      chat_id: "weird/jid@s.whatsapp.net",
      ts: 1700000000,
      text: "edge case",
    });
    writer.closeWriter();
    const memoryDb = makeMemoryDb(ws);
    try {
      const r = await runMessagesDbIndexerTick({
        channelDir: ch,
        memoryDb,
      });
      if (r.pairsRebuilt !== 1) throw new Error("pair not built");
      const t = memoryDb.readSyntheticChunkText(
        "extra:claude-whatsapp/messages-db/weird%2Fjid@s.whatsapp.net/2023-11-14"
      );
      if (!t || !t.includes("edge case"))
        throw new Error(`encoded path missing: ${t}`);
    } finally {
      memoryDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(ch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tier 2 — MemoryDB.search + readFile integration
// ---------------------------------------------------------------------------

await check(
  "tier2: search returns synthetic chunks with non-null source_chat_id",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const writer = makeChannel(ch);
      writer.insert({
        chat_id: "alice@s.whatsapp.net",
        ts: 1700000000,
        text: "lunch tomorrow at noon",
      });
      writer.insert({
        chat_id: "bob@s.whatsapp.net",
        ts: 1700000000,
        text: "lunch is canceled",
      });
      writer.closeWriter();
      const memoryDb = makeMemoryDb(ws);
      try {
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb });
        const hits = memoryDb.search("lunch", { maxResults: 10 });
        if (hits.length < 2)
          throw new Error(`expected ≥ 2 hits, got ${hits.length}`);
        for (const h of hits) {
          if (!h.path.startsWith("extra:claude-whatsapp/messages-db/"))
            throw new Error(`unexpected path: ${h.path}`);
          if (!h.provenance || h.provenance.sourceChannel !== "whatsapp")
            throw new Error(
              `provenance missing channel: ${JSON.stringify(h.provenance)}`
            );
          if (
            !h.provenance.sourceChatId ||
            !h.provenance.sourceChatId.includes("@s.whatsapp.net")
          )
            throw new Error(
              `provenance missing chat_id: ${JSON.stringify(h.provenance)}`
            );
        }
      } finally {
        memoryDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

await check(
  "tier2: readFile reconstructs synthetic chunk from chunks table",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      const writer = makeChannel(ch);
      writer.insert({
        chat_id: "alice@s.whatsapp.net",
        ts: 1700000000,
        text: "first message",
      });
      writer.insert({
        chat_id: "alice@s.whatsapp.net",
        ts: 1700001000,
        text: "second message",
      });
      writer.closeWriter();
      const memoryDb = makeMemoryDb(ws);
      try {
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb });
        const r = memoryDb.readFile(
          "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2023-11-14"
        );
        if ("error" in r) throw new Error(`readFile errored: ${r.error}`);
        if (
          !r.text.includes("first message") ||
          !r.text.includes("second message")
        )
          throw new Error(`text missing: ${r.text}`);
      } finally {
        memoryDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

setTimeout(() => {
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.pass) {
      pass++;
      console.log(`  ✓ ${r.name}`);
    } else {
      fail++;
      console.log(`  ✗ ${r.name}: ${r.msg}`);
    }
  }
  console.log(`\n${pass}/${pass + fail} messages-db-indexer tests passed`);
  if (fail > 0) process.exit(1);
}, 100);
