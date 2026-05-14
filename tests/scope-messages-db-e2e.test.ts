/**
 * Tier 2 — Phase 4a-2.6 end-to-end via the scope filter.
 *
 * The earlier `scope-messages-db-indexer.test.ts` proved synthetic
 * chunks land with the right `source_chat_id`. This file proves the
 * end-to-end behavior under a partial allowlist:
 *
 *   - A non-owner adapter that returns `[<X's chat>]` from
 *     `allowedChatIds` lets X see X's chunks but not Y's.
 *   - Owner adapter (returns `null`) sees both.
 *   - Phase 1 daily transcript chunks (path = `extra:claude-whatsapp/logs/<date>.md`)
 *     have `source_chat_id = null` — the partial-allowlist run
 *     correctly DROPS them (fail closed) so cross-chat content from
 *     the daily transcript can't leak.
 *
 * This is the canonical proof that Codex 4a-2.6 pre-impl review's
 * CRITICAL F1 is closed.
 *
 * Run: `npx tsx tests/scope-messages-db-e2e.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runMessagesDbIndexerTick } from "../lib/scope/messages-db-indexer.ts";
import { MemoryDB } from "../lib/memory-db.ts";
import { filterScopedResults } from "../lib/scope/filter.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import {
  _resetRegistryForTests,
  registerScopeAdapter,
} from "../lib/scope/index.ts";
import type { ScopeRuntimeState } from "../lib/scope/runtime.ts";
import type { ScopeAdapter } from "../lib/scope/index.ts";
import { deriveProvenance } from "../lib/scope/provenance.ts";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "scope-mdb-e2e-"));
}

function makeChannelDb(channelDir: string) {
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
  return db;
}

/** Mock adapter that returns a fixed allowlist regardless of context. */
function mockAdapter(channel: "whatsapp", allowed: string[] | null): ScopeAdapter {
  return {
    channel,
    canSee(prov, _ctx) {
      if (!prov || prov.class.kind !== "channel") return true;
      if (prov.class.sourceChannel !== channel) return true;
      if (allowed === null) return true;
      const cid = prov.class.sourceChatId;
      if (!cid) return false; // null chat_id under partial → fail closed
      return allowed.includes(cid);
    },
    allowedChatIds(_ctx) {
      return allowed;
    },
    requiresPerChunkCheck: false,
  };
}

function armedRuntime(): ScopeRuntimeState {
  return {
    anyArmed: true,
    anyEnforceConfigured: true,
    channels: {
      whatsapp: {
        mode: "enforce",
        configured: true,
        adapterAvailable: true,
        governanceResolvable: true,
        armed: true,
      },
    },
  };
}

function ownerRuntimeUnarmed(): ScopeRuntimeState {
  return { anyArmed: false, anyEnforceConfigured: false, channels: {} };
}

// ---------------------------------------------------------------------------
// Tier 2: end-to-end with partial allowlist
// ---------------------------------------------------------------------------

await check(
  "partial allowlist: non-owner sees only their chat",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      _resetRegistryForTests();
      const db = makeChannelDb(ch);
      const ins = db.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      ins.run("m1", "alice@s.whatsapp.net", 1700000000, "in", "lunch tomorrow");
      ins.run("m2", "bob@s.whatsapp.net", 1700000000, "in", "lunch is canceled");
      ins.run("m3", "alice@s.whatsapp.net", 1700001000, "in", "see you at noon");
      db.close();

      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memoryDb = new MemoryDB(ws, []);
      try {
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb });

        // Search for "lunch" — both chunks match
        const hits = memoryDb.search("lunch", { maxResults: 10 });
        if (hits.length < 2)
          throw new Error(`expected 2+ raw hits, got ${hits.length}`);

        // Register a non-owner adapter that allows ONLY alice's chat
        registerScopeAdapter(
          mockAdapter("whatsapp", ["alice@s.whatsapp.net"])
        );

        const { results: filtered, stats } = filterScopedResults(
          hits,
          makeForegroundContext("req-1"),
          armedRuntime()
        );

        // alice's chunk passes, bob's drops
        for (const f of filtered) {
          if (f.path.includes("bob@s.whatsapp.net"))
            throw new Error(`bob's chunk leaked to alice: ${f.path}`);
        }
        const aliceFound = filtered.some((f) =>
          f.path.includes("alice@s.whatsapp.net")
        );
        if (!aliceFound) throw new Error("alice's own chunk missing");

        // Stats reflect the drop
        if (stats.dropped < 1)
          throw new Error(`expected ≥ 1 dropped, got ${stats.dropped}`);
      } finally {
        memoryDb.close();
        _resetRegistryForTests();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

await check(
  "owner (allowed === null) sees every chat's synthetic chunk",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      _resetRegistryForTests();
      const db = makeChannelDb(ch);
      const ins = db.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      );
      ins.run("m1", "alice@s.whatsapp.net", 1700000000, "in", "lunch alice");
      ins.run("m2", "bob@s.whatsapp.net", 1700000000, "in", "lunch bob");
      db.close();

      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memoryDb = new MemoryDB(ws, []);
      try {
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb });

        const hits = memoryDb.search("lunch", { maxResults: 10 });

        registerScopeAdapter(mockAdapter("whatsapp", null)); // owner

        const { results: filtered, stats } = filterScopedResults(
          hits,
          makeForegroundContext("req-2"),
          armedRuntime()
        );

        // Owner sees both
        const seen = new Set(
          filtered
            .filter((f) => f.provenance?.sourceChatId)
            .map((f) => f.provenance!.sourceChatId)
        );
        if (
          !seen.has("alice@s.whatsapp.net") ||
          !seen.has("bob@s.whatsapp.net")
        ) {
          throw new Error(
            `owner missing chats: ${JSON.stringify([...seen])}`
          );
        }
        if (stats.dropped !== 0)
          throw new Error(`owner should see all, dropped=${stats.dropped}`);
      } finally {
        memoryDb.close();
        _resetRegistryForTests();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(ch, { recursive: true, force: true });
    }
  }
);

await check(
  "fail closed: legacy daily-transcript chunk (null source_chat_id) is dropped under partial allowlist",
  async () => {
    const ws = tmpDir();
    try {
      _resetRegistryForTests();
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });

      // Simulate an OpenCLAUDE workspace that already has a chunk
      // attributed to claude-whatsapp via the daily transcript path
      // (Phase 1/2 pattern, source_chat_id = null because we never
      // backfilled). Use the synthetic upsert helper but pass a
      // logs/-style path with source_chat_id pre-derived as null —
      // we simulate this by running deriveProvenance on the path.
      const memoryDb = new MemoryDB(ws, []);
      try {
        // Insert the legacy chunk via the public sync path: write a
        // file under an `extra:` root pointing at the channel logs.
        const legacyChannelDir = path.join(ws, ".whatsapp-legacy");
        fs.mkdirSync(path.join(legacyChannelDir, "logs"), { recursive: true });
        fs.writeFileSync(
          path.join(legacyChannelDir, "logs", "2026-04-09.md"),
          "[09-04-26] ~alice: lunch tomorrow\n[09-04-26] ~bob: lunch canceled\n"
        );
        // Reconstruct MemoryDB with this extraPath so logs/2026-04-09.md gets
        // chunked.
        memoryDb.close();
        const memoryDb2 = new MemoryDB(ws, [legacyChannelDir]);
        try {
          memoryDb2.markDirty();
          memoryDb2.search("lunch", { maxResults: 10 });
          // Confirm the legacy chunk landed with source_channel=whatsapp,
          // source_chat_id=null
          const dbHandle = (memoryDb2 as any).db;
          const row = dbHandle
            .prepare(
              `SELECT source_channel, source_chat_id FROM chunks WHERE path LIKE ? LIMIT 1`
            )
            .get("extra:.whatsapp-legacy/logs/2026-04-09.md");
          // The path-pattern derivation uses CHANNEL_REGISTRY markers;
          // `.whatsapp-legacy` won't match — it'll classify as
          // legacy_unprovenanced. That actually proves the SAFE
          // default: a non-channel-attributed chunk is local-safe and
          // visible to non-owners (no leak risk). The CRITICAL we're
          // sealing is "channel-attributed but null chat_id under
          // partial allowlist". So we need a chunk with
          // source_channel="whatsapp", source_chat_id=null.

          // Force-insert that exact shape via a private DB write.
          dbHandle
            .prepare(
              `INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)`
            )
            .run(
              "extra:claude-whatsapp/logs/2026-04-09.md",
              "h",
              1700000000000,
              42
            );
          dbHandle
            .prepare(
              `INSERT OR REPLACE INTO chunks (id, path, start_line, end_line, text, hash, source_channel, source_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              "legacy-1",
              "extra:claude-whatsapp/logs/2026-04-09.md",
              1,
              2,
              "lunch tomorrow then lunch canceled",
              "h",
              "whatsapp",
              null
            );
          dbHandle
            .prepare(
              `INSERT INTO chunks_fts (text, id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              "lunch tomorrow then lunch canceled",
              "legacy-1",
              "extra:claude-whatsapp/logs/2026-04-09.md",
              1,
              2
            );

          const hits = memoryDb2.search("lunch", { maxResults: 10 });
          // The legacy chunk should be in raw hits
          const legacy = hits.find((h) => h.path.includes("logs/2026-04-09"));
          if (!legacy) throw new Error("legacy chunk not in raw hits");

          // Apply partial-allowlist filter — non-owner alice
          registerScopeAdapter(
            mockAdapter("whatsapp", ["alice@s.whatsapp.net"])
          );
          const { results: filtered } = filterScopedResults(
            hits,
            makeForegroundContext("req-3"),
            armedRuntime()
          );

          // CRITICAL: legacy chunk MUST be dropped. Otherwise non-owner
          // alice would see bob's "lunch canceled" line embedded in the
          // shared daily transcript.
          for (const f of filtered) {
            if (f.path.includes("logs/2026-04-09"))
              throw new Error(
                `LEAK: legacy daily-transcript chunk reached non-owner: ${f.path}`
              );
          }
        } finally {
          memoryDb2.close();
        }
      } finally {
        // memoryDb already closed
        _resetRegistryForTests();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "no-channel-armed runtime is no-op (synthetic chunks visible without filter)",
  async () => {
    const ws = tmpDir();
    const ch = tmpDir();
    try {
      _resetRegistryForTests();
      const db = makeChannelDb(ch);
      db.prepare(
        `INSERT INTO messages (id, chat_id, ts, direction, text) VALUES (?, ?, ?, ?, ?)`
      ).run("m1", "alice@s.whatsapp.net", 1700000000, "in", "hi");
      db.close();

      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memoryDb = new MemoryDB(ws, []);
      try {
        await runMessagesDbIndexerTick({ channelDir: ch, memoryDb });
        const hits = memoryDb.search("hi", { maxResults: 10 });
        const { results: filtered, stats } = filterScopedResults(
          hits,
          makeForegroundContext("req-4"),
          ownerRuntimeUnarmed()
        );
        if (stats.evaluated !== false)
          throw new Error("expected stats.evaluated=false when not armed");
        if (filtered.length !== hits.length)
          throw new Error("filter should be no-op when not armed");
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
// Provenance derivation sanity (the synthetic path scheme works with
// existing path-pattern logic without a special case)
// ---------------------------------------------------------------------------

await check(
  "synthetic chunk path derives sourceChannel='whatsapp' via path-pattern",
  () => {
    const prov = deriveProvenance(
      "extra:claude-whatsapp/messages-db/alice@s.whatsapp.net/2026-04-09"
    );
    if (prov.class.kind !== "channel")
      throw new Error(`expected channel, got ${prov.class.kind}`);
    if (prov.sourceChannel !== "whatsapp")
      throw new Error(`expected whatsapp, got ${prov.sourceChannel}`);
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
  console.log(`\n${pass}/${pass + fail} messages-db e2e tests passed`);
  if (fail > 0) process.exit(1);
}, 100);
