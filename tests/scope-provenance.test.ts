/**
 * Tier 1 tests for chunk provenance derivation (Phase 2 of channel-scope
 * compatibility plan).
 *
 * Covers:
 *  - path-pattern stage: extra: → channel hint, memory/ → local,
 *    extra-but-no-marker → legacy_unprovenanced, anything else → legacy
 *  - LRU cache: cap eviction, refresh on get, deterministic equality
 *  - enrichProvenanceWithDbRow: only enriches channel-class rows
 *  - resolveContainedPath: separator-safe (`/foo/bar` not in `/foo/barX`),
 *    symlink-resolved, fail-closed on dangling/missing, mtimeMs+size cache
 *
 * Run: `npx tsx tests/scope-provenance.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _cacheSizesForTests,
  _resetCachesForTests,
  deriveProvenance,
  enrichProvenanceWithDbRow,
  resolveContainedPath,
} from "../lib/scope/provenance.ts";

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
  workspace: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-prov-"));
  return {
    workspace: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// deriveProvenance
// ---------------------------------------------------------------------------

check("deriveProvenance handles empty/invalid input", () => {
  _resetCachesForTests();
  const r = deriveProvenance("");
  assert(r.class.kind === "legacy_unprovenanced", "empty -> legacy");
  assert(r.sourceChannel === null, "no channel");
  assert(r.sourceChatId === null, "no chat id");
});

check("deriveProvenance maps extra:claude-whatsapp/* to whatsapp channel", () => {
  _resetCachesForTests();
  const r = deriveProvenance("extra:claude-whatsapp/logs/2026-04-09.md");
  assert(r.class.kind === "channel", `expected channel, got ${r.class.kind}`);
  assert(r.sourceChannel === "whatsapp", `expected whatsapp, got ${r.sourceChannel}`);
  assert(r.sourceChatId === null, "Phase 2 leaves chat_id null");
});

check("deriveProvenance maps extra:telegram/* to telegram channel", () => {
  _resetCachesForTests();
  const r = deriveProvenance("extra:telegram-logs/foo.md");
  assert(r.class.kind === "channel", `expected channel, got ${r.class.kind}`);
  assert(r.sourceChannel === "telegram", `expected telegram, got ${r.sourceChannel}`);
});

check("deriveProvenance treats memory/ paths as local", () => {
  _resetCachesForTests();
  const a = deriveProvenance("memory/MEMORY.md");
  assert(a.class.kind === "local", `memory/MEMORY.md -> local`);
  const b = deriveProvenance("memory/foo.md");
  assert(b.class.kind === "local", `memory/foo.md -> local`);
  const c = deriveProvenance("MEMORY.md");
  assert(c.class.kind === "local", `MEMORY.md -> local`);
});

check("deriveProvenance returns legacy_unprovenanced for unknown extra", () => {
  _resetCachesForTests();
  const r = deriveProvenance("extra:some-random-channel/foo.md");
  // CHANNEL_REGISTRY markers don't include "some-random-channel".
  assert(
    r.class.kind === "legacy_unprovenanced",
    `expected legacy, got ${r.class.kind}`
  );
});

check("deriveProvenance returns legacy_unprovenanced for unrelated paths", () => {
  _resetCachesForTests();
  const r = deriveProvenance("/Users/x/random.txt");
  assert(r.class.kind === "legacy_unprovenanced", "unrelated -> legacy");
});

// ---------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------

check("provenance LRU caches repeated lookups", () => {
  _resetCachesForTests();
  deriveProvenance("memory/x.md");
  deriveProvenance("memory/x.md");
  const sizes = _cacheSizesForTests();
  assert(sizes.provenance === 1, `expected 1 entry, got ${sizes.provenance}`);
});

check("provenance LRU returns same shape on repeat", () => {
  _resetCachesForTests();
  const a = deriveProvenance("extra:claude-whatsapp/x.md");
  const b = deriveProvenance("extra:claude-whatsapp/x.md");
  assert(a.sourceChannel === b.sourceChannel, "channel matches");
  assert(a.class.kind === b.class.kind, "kind matches");
});

// ---------------------------------------------------------------------------
// enrichProvenanceWithDbRow
// ---------------------------------------------------------------------------

check("enrichProvenanceWithDbRow only attaches chat_id to channel-class", () => {
  _resetCachesForTests();
  const channel = deriveProvenance("extra:claude-whatsapp/x.md");
  const enriched = enrichProvenanceWithDbRow(channel, { chat_id: "5491155@s.whatsapp.net" });
  assert(enriched.sourceChatId === "5491155@s.whatsapp.net", "chat id attached");

  const local = deriveProvenance("memory/MEMORY.md");
  const stillLocal = enrichProvenanceWithDbRow(local, { chat_id: "should-be-ignored" });
  assert(stillLocal.sourceChatId === null, "local stays without chat_id");
});

check("enrichProvenanceWithDbRow tolerates null/missing row", () => {
  _resetCachesForTests();
  const channel = deriveProvenance("extra:claude-whatsapp/x.md");
  const a = enrichProvenanceWithDbRow(channel, null);
  assert(a.sourceChatId === null, "null row");
  const b = enrichProvenanceWithDbRow(channel, undefined);
  assert(b.sourceChatId === null, "undefined row");
  const c = enrichProvenanceWithDbRow(channel, { chat_id: "" });
  assert(c.sourceChatId === null, "empty chat_id");
});

// ---------------------------------------------------------------------------
// resolveContainedPath — separator-safe
// ---------------------------------------------------------------------------

check("resolveContainedPath rejects sibling roots that share a string prefix", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const goodRoot = path.join(f.workspace, "logs");
    const sibling = path.join(f.workspace, "logsX");
    fs.mkdirSync(goodRoot, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const evilFile = path.join(sibling, "leak.md");
    fs.writeFileSync(evilFile, "leak");

    // Trick relPath: extra:logs/../logsX/leak.md should NOT resolve into
    // logs root. We craft it as extra:logs<separator-trick>... which is
    // exercised via the "logsX" basename mismatch — only `logs` should
    // match. Use a relPath whose basename matches `logs` but whose
    // body climbs out.
    const sneaky = "extra:logs/../logsX/leak.md";
    const r = resolveContainedPath(sneaky, [goodRoot]);
    assert(r === null, `expected null (sibling out-of-cage), got ${r}`);
  } finally {
    f.cleanup();
  }
});

check("resolveContainedPath returns null for unknown root basename", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "real-root");
    fs.mkdirSync(root, { recursive: true });
    const r = resolveContainedPath("extra:other-name/foo.md", [root]);
    assert(r === null, `unknown basename should return null, got ${r}`);
  } finally {
    f.cleanup();
  }
});

check("resolveContainedPath resolves a contained extra: path", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "logs");
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, "good.md");
    fs.writeFileSync(file, "hello");
    const r = resolveContainedPath("extra:logs/good.md", [root]);
    assert(r !== null, "expected non-null");
    assert(
      r === fs.realpathSync(file),
      `expected realpath of good.md, got ${r}`
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveContainedPath — symlink resolution
// ---------------------------------------------------------------------------

check("resolveContainedPath rejects a symlink that escapes the cage", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "cage");
    const outside = path.join(f.workspace, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const target = path.join(outside, "secret.md");
    fs.writeFileSync(target, "secret");
    const symlink = path.join(root, "leak.md");
    try {
      fs.symlinkSync(target, symlink);
    } catch {
      // Some filesystems don't support symlinks; skip the assertion.
      return;
    }
    const r = resolveContainedPath("extra:cage/leak.md", [root]);
    assert(r === null, `escaping symlink should be rejected, got ${r}`);
  } finally {
    f.cleanup();
  }
});

check("resolveContainedPath fails closed on dangling symlink", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "cage");
    fs.mkdirSync(root, { recursive: true });
    const symlink = path.join(root, "dangling.md");
    try {
      fs.symlinkSync(path.join(f.workspace, "missing-target.md"), symlink);
    } catch {
      return;
    }
    const r = resolveContainedPath("extra:cage/dangling.md", [root]);
    assert(r === null, `dangling symlink should fail closed, got ${r}`);
  } finally {
    f.cleanup();
  }
});

check("resolveContainedPath returns null for nonexistent files", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "cage");
    fs.mkdirSync(root, { recursive: true });
    const r = resolveContainedPath("extra:cage/nope.md", [root]);
    assert(r === null, `missing file should return null, got ${r}`);
  } finally {
    f.cleanup();
  }
});

check("resolveContainedPath caches realpath by mtimeMs+size", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "cage");
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, "stable.md");
    fs.writeFileSync(file, "x");
    resolveContainedPath("extra:cage/stable.md", [root]);
    const sizesAfterFirst = _cacheSizesForTests().realpath;
    resolveContainedPath("extra:cage/stable.md", [root]);
    const sizesAfterSecond = _cacheSizesForTests().realpath;
    assert(
      sizesAfterFirst === sizesAfterSecond,
      `realpath cache should not grow on repeat hit; was ${sizesAfterFirst}, now ${sizesAfterSecond}`
    );
  } finally {
    f.cleanup();
  }
});

check("realpath cache invalidates when inode changes (Codex P1 2c)", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const root = path.join(f.workspace, "cage");
    const outside = path.join(f.workspace, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const file = path.join(root, "swap.md");
    const target = path.join(outside, "evil.md");

    fs.writeFileSync(file, "good");
    const r1 = resolveContainedPath("extra:cage/swap.md", [root]);
    assert(r1 !== null, "first resolve succeeds");

    // Atomic replace via rename: same name, different inode. Pre-fix
    // the cache key was mtimeMs+size only, so a same-size+same-mtime
    // swap would return the cached realPath of the now-removed file.
    fs.writeFileSync(target, "good"); // same size as `good`
    // Force the new file's mtimeMs to match the old one's so size+mtime
    // alone can't distinguish them.
    const origStat = fs.statSync(r1!);
    fs.utimesSync(target, origStat.atime, origStat.mtime);

    fs.unlinkSync(file);
    try {
      fs.symlinkSync(target, file);
    } catch {
      return; // platform without symlink support; skip
    }
    // After the swap, realpath should resolve to outside the cage —
    // resolveContainedPath must reject. Inode of the cage entry has
    // changed (file→symlink), so the cache key is invalidated.
    const r2 = resolveContainedPath("extra:cage/swap.md", [root]);
    assert(r2 === null, `expected null after swap-to-outside, got ${r2}`);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-provenance tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
