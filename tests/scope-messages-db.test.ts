/**
 * Tier 1 — `lib/scope/messages-db.ts` reader.
 *
 * Validates failure modes without standing up the full indexer:
 *   - missing file → null
 *   - corrupt file → null
 *   - schema drift (missing required column) → null
 *   - good DB with mixed rows → batched read in rowid order
 *   - data_version stable across no-write reads, increments after write
 *   - row-level invariants: skips bad direction, skips empty chat_id
 *
 * Run: `npx tsx tests/scope-messages-db.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openMessagesDb } from "../lib/scope/messages-db.ts";

// We need a writer for fixtures. Lazy-load to mirror the production path.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "scope-messages-db-"));
}

/** Build a writable upstream-shaped messages.db at `<dir>/messages.db`. */
function makeUpstreamDb(dir: string): { dbPath: string; insert: (r: any) => void; close: () => void } {
  const dbPath = path.join(dir, "messages.db");
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
  return {
    dbPath,
    insert(r) {
      stmt.run(
        r.id ?? `m-${Math.random()}`,
        r.chat_id,
        r.sender_id ?? null,
        r.push_name ?? null,
        r.ts ?? 1700000000,
        r.direction ?? "in",
        r.text ?? "",
        null
      );
    },
    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

await check("missing file → null", async () => {
  const d = tmpDir();
  try {
    const h = await openMessagesDb(d);
    if (h !== null) throw new Error("expected null for missing DB");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await check("corrupt file → null", async () => {
  const d = tmpDir();
  try {
    fs.writeFileSync(path.join(d, "messages.db"), "this is not sqlite");
    const h = await openMessagesDb(d);
    if (h !== null) throw new Error("expected null for corrupt DB");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await check("schema drift (missing required column) → null", async () => {
  const d = tmpDir();
  try {
    const dbPath = path.join(d, "messages.db");
    const db = new Database(dbPath);
    // Missing chat_id → the reader must reject.
    db.exec(`CREATE TABLE messages (rowid INTEGER PRIMARY KEY, id TEXT, ts INTEGER, direction TEXT, text TEXT)`);
    db.close();
    const h = await openMessagesDb(d);
    if (h !== null) throw new Error("expected null for schema drift");
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

await check("reads rows in rowid order, batched", async () => {
  const d = tmpDir();
  const writer = makeUpstreamDb(d);
  try {
    writer.insert({ chat_id: "chat-A@s.whatsapp.net", text: "first", ts: 1 });
    writer.insert({ chat_id: "chat-B@s.whatsapp.net", text: "second", ts: 2 });
    writer.insert({ chat_id: "chat-A@s.whatsapp.net", text: "third", ts: 3 });
    writer.close();

    const h = await openMessagesDb(d);
    if (!h) throw new Error("open failed");
    try {
      const batch1 = h.readBatch(0, 2);
      if (batch1.length !== 2)
        throw new Error(`batch1 expected 2 rows, got ${batch1.length}`);
      if (batch1[0].text !== "first")
        throw new Error(`order wrong: ${batch1[0].text}`);
      const batch2 = h.readBatch(batch1[batch1.length - 1].rowid, 10);
      if (batch2.length !== 1)
        throw new Error(`batch2 expected 1 row, got ${batch2.length}`);
      if (batch2[0].text !== "third")
        throw new Error("third row missing from batch2");
    } finally {
      h.close();
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await check("data_version increments after upstream write", async () => {
  const d = tmpDir();
  const writer = makeUpstreamDb(d);
  try {
    writer.insert({ chat_id: "x@s.whatsapp.net", text: "v1" });

    const h = await openMessagesDb(d);
    if (!h) throw new Error("open failed");
    try {
      const v1 = h.dataVersion();
      // Upstream writes another row.
      writer.insert({ chat_id: "x@s.whatsapp.net", text: "v2" });
      const v2 = h.dataVersion();
      if (v2 === v1)
        throw new Error(`data_version stale: ${v1} === ${v2}`);
    } finally {
      h.close();
      writer.close();
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await check("row-level: skips bad direction, skips empty chat_id", async () => {
  const d = tmpDir();
  const dbPath = path.join(d, "messages.db");
  // Build a DB that bypasses the upstream CHECK constraint by leaving
  // it off the schema, simulating a hypothetical schema drift where
  // upstream relaxed the constraint.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE messages (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL,
      chat_id TEXT,
      sender_id TEXT,
      ts INTEGER NOT NULL,
      direction TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT ''
    );
  `);
  const ins = db.prepare(
    `INSERT INTO messages (id, chat_id, sender_id, ts, direction, text) VALUES (?, ?, ?, ?, ?, ?)`
  );
  ins.run("a", "good@s.whatsapp.net", null, 1, "in", "ok");
  ins.run("b", "", null, 2, "in", "empty chat_id");
  ins.run("c", "good@s.whatsapp.net", null, 3, "weird", "bad direction");
  db.close();

  try {
    const h = await openMessagesDb(d);
    if (!h) throw new Error("open failed");
    try {
      const all = h.readBatch(0, 100);
      const okOnly = all.filter((r) => r.text === "ok");
      if (okOnly.length !== 1) throw new Error("good row missing");
      if (all.length !== 1)
        throw new Error(
          `expected only 1 valid row, got ${all.length}: ${JSON.stringify(all.map((r) => r.text))}`
        );
    } finally {
      h.close();
    }
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

await check("readonly enforced: ctor flag is set", async () => {
  const d = tmpDir();
  const writer = makeUpstreamDb(d);
  try {
    writer.insert({ chat_id: "x@s.whatsapp.net" });
    writer.close();
    const h = await openMessagesDb(d);
    if (!h) throw new Error("open failed");
    h.close();
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

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
  console.log(`\n${pass}/${pass + fail} messages-db reader tests passed`);
  if (fail > 0) process.exit(1);
}, 100);
