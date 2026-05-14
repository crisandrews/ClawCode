/**
 * Regression tier1 for Codex 14th-pass findings on Phase 4a-2.6.
 *
 *   v13-F1 [LOW]  doctor compound hint when both counters non-zero
 *   v13-F2 [LOW]  Infinity/NaN amounts rejected by both bump paths
 *
 * Run: `npx tsx tests/scope-v14-codex-14th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function tmpDir(prefix = "v14-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// v13-F1 — compound hint when BOTH counters are non-zero.
// ---------------------------------------------------------------------------

await check(
  "v13-F1: doctor hint includes BOTH remediations when both counters > 0",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.bumpIndexerMetric("pairs_capped", 2);
        memDb.bumpIndexerMetric("reserved_prefix_skipped", 1);
      } finally {
        memDb.close();
      }
      const c = checkScopeIndexerHealth(ws);
      if (c.status !== "warn")
        throw new Error(`expected warn, got ${c.status}`);
      if (!c.hint) throw new Error("expected hint, got none");
      if (!c.hint.includes("rename the extraPath"))
        throw new Error(`reservedPrefix hint missing: ${c.hint}`);
      if (!c.hint.includes("won't surface in memory_search"))
        throw new Error(`pairsCapped hint missing — F1 regression: ${c.hint}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// v13-F2 — Infinity / NaN amounts rejected by both bump paths.
// ---------------------------------------------------------------------------

await check("v13-F2: bumpIndexerMetric rejects Infinity", () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      memDb.bumpIndexerMetric("pairs_capped", Infinity);
      const v = memDb.getIndexerMetric("pairs_capped");
      if (v !== 0) throw new Error(`Infinity stored: got ${v}`);
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

await check("v13-F2: bumpIndexerMetric rejects NaN", () => {
  const ws = tmpDir();
  try {
    fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
    const memDb = new MemoryDB(ws, [], { quietBoot: true });
    try {
      memDb.bumpIndexerMetric("pairs_capped", NaN);
      const v = memDb.getIndexerMetric("pairs_capped");
      if (v !== 0) throw new Error(`NaN stored: got ${v}`);
    } finally {
      memDb.close();
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

await check(
  "v13-F2: advanceIndexerCursorAtomic rejects Infinity/NaN bumps but advances cursor",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        memDb.advanceIndexerCursorAtomic("whatsapp", 50, [
          { metric: "pairs_capped", amount: Infinity },
          { metric: "reserved_prefix_skipped", amount: NaN },
          { metric: "pairs_capped", amount: 3 }, // valid alongside hostile
        ]);
        if (memDb.getIndexerCursor("whatsapp") !== 50)
          throw new Error("cursor did not advance — hostile bump rolled it back");
        if (memDb.getIndexerMetric("pairs_capped") !== 3)
          throw new Error(
            `expected 3 valid bump persisted, got ${memDb.getIndexerMetric("pairs_capped")}`
          );
        if (memDb.getIndexerMetric("reserved_prefix_skipped") !== 0)
          throw new Error("NaN metric leaked through");
      } finally {
        memDb.close();
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

await check(
  "v13-F2: hostile bump alone in atomic call still advances cursor (no SQL throw)",
  () => {
    const ws = tmpDir();
    try {
      fs.mkdirSync(path.join(ws, "memory"), { recursive: true });
      const memDb = new MemoryDB(ws, [], { quietBoot: true });
      try {
        // Only-hostile bumps: Infinity + NaN. Cursor must still
        // advance; the txn must not throw.
        memDb.advanceIndexerCursorAtomic("whatsapp", 99, [
          { metric: "pairs_capped", amount: Infinity },
          { metric: "reserved_prefix_skipped", amount: NaN },
        ]);
        if (memDb.getIndexerCursor("whatsapp") !== 99)
          throw new Error("cursor did not advance");
        if (memDb.getIndexerMetric("pairs_capped") !== 0)
          throw new Error("Infinity leaked into metric");
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
console.log(`\n${pass}/${results.length} v14 Codex-14th-pass tests passed`);
if (pass !== results.length) process.exit(1);
