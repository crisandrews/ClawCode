/**
 * Regression tier1 for Codex 15th-pass findings on Phase 4a-2.6.
 *
 *   v14-F1 [LOW]  setIndexerCursor + advanceIndexerCursorAtomic
 *                 reject Infinity/NaN lastRowid
 *   v14-F2 [LOW]  upsertSyntheticChunk normalizes upstreamMaxTs
 *
 * Run: `npx tsx tests/scope-v15-codex-15th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MemoryDB } from "../lib/memory-db.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix = "v15-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// v14-F1 — setIndexerCursor rejects Infinity / NaN.
// ---------------------------------------------------------------------------

await check(
  "v14-F1: setIndexerCursor rejects Infinity (cursor doesn't go to Infinity)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.setIndexerCursor("whatsapp", Infinity);
        const v = memDb.getIndexerCursor("whatsapp");
        if (!Number.isFinite(v))
          throw new Error(`cursor stored as non-finite: ${v}`);
        if (v !== 0) throw new Error(`expected 0, got ${v}`);
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check("v14-F1: setIndexerCursor rejects NaN", () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      memDb.setIndexerCursor("whatsapp", NaN);
      const v = memDb.getIndexerCursor("whatsapp");
      if (v !== 0) throw new Error(`expected 0, got ${v}`);
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

await check(
  "v14-F1: advanceIndexerCursorAtomic rejects Infinity lastRowid",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.advanceIndexerCursorAtomic("whatsapp", Infinity, [
          { metric: "pairs_capped", amount: 1 },
        ]);
        const cursor = memDb.getIndexerCursor("whatsapp");
        if (!Number.isFinite(cursor))
          throw new Error(`cursor stored as Infinity: ${cursor}`);
        if (cursor !== 0)
          throw new Error(`expected cursor=0 from hostile rowid, got ${cursor}`);
        // Valid metric should still have landed.
        if (memDb.getIndexerMetric("pairs_capped") !== 1)
          throw new Error(
            "valid sibling metric was rolled back by hostile rowid"
          );
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check("v14-F1: setIndexerCursor accepts valid positive integer", () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      memDb.setIndexerCursor("whatsapp", 12345);
      const v = memDb.getIndexerCursor("whatsapp");
      if (v !== 12345) throw new Error(`expected 12345, got ${v}`);
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v14-F2 — upsertSyntheticChunk normalizes upstreamMaxTs.
// ---------------------------------------------------------------------------

await check(
  "v14-F2: upsertSyntheticChunk with Infinity upstreamMaxTs stores finite mtime",
  async () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const ok = memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/test/2026-04-09",
          sourceChannel: "whatsapp",
          sourceChatId: "test",
          text: "hello",
          upstreamMaxTs: Infinity,
        });
        if (!ok) throw new Error("upsert returned false");
        // Codex 16th-pass: actually inspect `files.mtime` to confirm
        // it's finite. Without this the test was tautological — the
        // upsert + readback could succeed even with Infinity mtime
        // because better-sqlite3 binds doubles fine.
        const Database = (await import("better-sqlite3")).default;
        const dbPath = path.join(ws, "memory", ".memory.sqlite");
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db
            .prepare(`SELECT mtime FROM files WHERE path = ?`)
            .get(
              "extra:claude-whatsapp/messages-db/test/2026-04-09"
            ) as { mtime: number } | undefined;
          if (!row) throw new Error("file row missing");
          if (!Number.isFinite(row.mtime))
            throw new Error(`mtime stored as non-finite: ${row.mtime}`);
        } finally {
          db.close();
        }
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v15-F1 (Codex 16th-pass): large finite upstreamMaxTs caps at year-9999 (no overflow to Infinity)",
  async () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Number.MAX_SAFE_INTEGER seconds * 1000 ms/s overflows to
        // Infinity in IEEE 754 double arithmetic. Pre-v16 the v15
        // guard only checked Number.isFinite at INPUT, not after
        // multiplication.
        const huge = Number.MAX_SAFE_INTEGER;
        const ok = memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/big/2026-04-09",
          sourceChannel: "whatsapp",
          sourceChatId: "big",
          text: "x",
          upstreamMaxTs: huge,
        });
        if (!ok) throw new Error("upsert returned false");
        const Database = (await import("better-sqlite3")).default;
        const dbPath = path.join(ws, "memory", ".memory.sqlite");
        const db = new Database(dbPath, { readonly: true });
        try {
          const row = db
            .prepare(`SELECT mtime FROM files WHERE path = ?`)
            .get(
              "extra:claude-whatsapp/messages-db/big/2026-04-09"
            ) as { mtime: number } | undefined;
          if (!row) throw new Error("file row missing");
          if (!Number.isFinite(row.mtime))
            throw new Error(
              `large finite ts produced non-finite mtime: ${row.mtime}`
            );
          // Year-9999-end clamp is `253_402_300_799 * 1000`.
          const MAX_MTIME_MS = 253_402_300_799 * 1000;
          if (row.mtime > MAX_MTIME_MS)
            throw new Error(
              `mtime exceeded year-9999 cap: ${row.mtime} > ${MAX_MTIME_MS}`
            );
        } finally {
          db.close();
        }
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v14-F2: upsertSyntheticChunk with NaN upstreamMaxTs doesn't corrupt",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        const ok = memDb.upsertSyntheticChunk({
          path: "extra:claude-whatsapp/messages-db/test/2026-04-09",
          sourceChannel: "whatsapp",
          sourceChatId: "test",
          text: "world",
          upstreamMaxTs: NaN,
        });
        if (!ok) throw new Error("upsert returned false");
        const text = memDb.readSyntheticChunkText(
          "extra:claude-whatsapp/messages-db/test/2026-04-09"
        );
        if (text !== "world")
          throw new Error(`expected 'world', got ${text}`);
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
console.log(`\n${pass}/${results.length} v15 Codex-15th-pass tests passed`);
if (pass !== results.length) process.exit(1);
