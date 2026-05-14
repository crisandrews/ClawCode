/**
 * Tier 1 tests for the scope-cache.json atomic writer (Phase 3).
 *
 * Covers:
 *  - writeScopeCache then readScopeCache round-trips
 *  - envelope has version + updatedAt + data
 *  - parse failure yields null (caller falls back to LKG)
 *  - file is created with 0600 perms
 *  - rename is atomic — interrupted writes never leave a partial file
 *    visible at the canonical path (we exercise this by writing a
 *    .tmp ourselves and confirming cachePath isn't touched)
 *  - advisory lock — concurrent writers that hold the lock get false
 *
 * Run: `npx tsx tests/scope-cache.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readScopeCache, writeScopeCache } from "../lib/scope/cache.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, msg: (err as Error).message });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface Fixture {
  dir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-cache-"));
  return {
    dir: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

check("writeScopeCache + readScopeCache round-trip", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "scope-cache.json");
    const ok = writeScopeCache(cachePath, { whatsapp: { armed: true } });
    assert(ok === true, "write succeeded");
    const env = readScopeCache<{ whatsapp: { armed: boolean } }>(cachePath);
    assert(env !== null, "envelope present");
    assert(env!.version === 1, "version 1");
    assert(typeof env!.updatedAt === "string", "updatedAt is string");
    assert(env!.data.whatsapp.armed === true, "data preserved");
  } finally {
    f.cleanup();
  }
});

check("readScopeCache returns null for missing file", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "missing.json");
    const env = readScopeCache(cachePath);
    assert(env === null, "missing -> null");
  } finally {
    f.cleanup();
  }
});

check("readScopeCache returns null for corrupt JSON", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "corrupt.json");
    fs.writeFileSync(cachePath, "{ this is not valid json");
    const env = readScopeCache(cachePath);
    assert(env === null, "corrupt -> null");
  } finally {
    f.cleanup();
  }
});

check("readScopeCache rejects payload without envelope shape", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "bare.json");
    fs.writeFileSync(cachePath, JSON.stringify({ whatsapp: { armed: true } }));
    const env = readScopeCache(cachePath);
    assert(env === null, "bare object rejected (no envelope)");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

check("cache file is created with 0600 perms", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "secure.json");
    writeScopeCache(cachePath, { x: 1 });
    const stat = fs.statSync(cachePath);
    // Mask out file-type bits; compare lower 9 (perm) bits.
    const perm = stat.mode & 0o777;
    assert(perm === 0o600, `expected 0o600, got ${perm.toString(8)}`);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Atomicity (no partial visible)
// ---------------------------------------------------------------------------

check("interrupted writes leave canonical path untouched", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "atom.json");
    writeScopeCache(cachePath, { v: "first" });

    // Simulate an interrupted write: drop a `.tmp` file at the same
    // path the writer would use, but never call rename. The canonical
    // path must still hold the prior value.
    const tmp = `${cachePath}.tmp.fake.0`;
    fs.writeFileSync(tmp, "{ this would have replaced first }");

    const env = readScopeCache<{ v: string }>(cachePath);
    assert(env !== null, "still present");
    assert(env!.data.v === "first", "old value preserved");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Advisory lock
// ---------------------------------------------------------------------------

check("advisory lock blocks concurrent writers", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "locked.json");
    const lockPath = path.join(f.dir, "scope-cache.lock");

    // Take the lock manually to simulate a peer holding it.
    fs.writeFileSync(lockPath, "1234", { mode: 0o600, flag: "wx" });
    try {
      const ok = writeScopeCache(
        cachePath,
        { v: "blocked" },
        { lockPath }
      );
      assert(ok === false, "blocked writer returned false");
      // Cache file must not be created.
      assert(
        !fs.existsSync(cachePath),
        "cache file should not have been written"
      );
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  } finally {
    f.cleanup();
  }
});

check("advisory lock cleared after successful write", () => {
  const f = makeFixture();
  try {
    const cachePath = path.join(f.dir, "released.json");
    const lockPath = path.join(f.dir, "released.lock");
    const ok = writeScopeCache(cachePath, { v: 1 }, { lockPath });
    assert(ok === true, "wrote ok");
    assert(!fs.existsSync(lockPath), "lock removed after write");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-cache tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
