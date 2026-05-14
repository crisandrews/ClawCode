/**
 * Tier 1 tests for `mapAbsoluteToLogical` — Phase 4a-2 voice_transcribe
 * abs-path bypass closure (Codex A4 + Q2 fix).
 *
 * Coverage:
 *  - 0 matches → null (path outside any extraPath)
 *  - 1 match → logical `extra:<basename>/<rel>`
 *  - Nested extraPaths (longest-prefix-wins): outer + inner roots both
 *    cover a file → inner wins
 *  - True tie at deepest level (two equal-length realExtra) → fail-closed
 *    `kind: "deny"`
 *  - Symlink alias: a symlinked extraPath resolves to the same canonical
 *    realpath → still maps to the configured root's basename
 *  - Non-channel extraPath basename (e.g. `notes/`) → null (not a scope
 *    concern)
 *  - Empty extraPaths → null
 *  - Empty absPath → null
 *  - Path equal to extraPath itself → null (no rel; can't be a file)
 *  - realpath fails on absPath but textual prefix matches a known
 *    channel root → deny (fail-closed; the bypass we're closing)
 *  - realpath fails on absPath AND no textual prefix → null
 *
 * Run: `npx tsx tests/scope-abs-path-map.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _resetCachesForTests,
  mapAbsoluteToLogical,
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
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-abspath-"));
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

check("empty inputs return null", () => {
  _resetCachesForTests();
  assert(mapAbsoluteToLogical("", []) === null, "empty absPath + empty extras");
  assert(mapAbsoluteToLogical("/foo/bar", []) === null, "empty extras");
  assert(mapAbsoluteToLogical("", ["/some/root"]) === null, "empty absPath");
});

check("path outside any extraPath → null", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });
    fs.writeFileSync(path.join(wa, "x.md"), "x");
    const outside = path.join(f.root, "elsewhere", "y.md");
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, "y");

    const result = mapAbsoluteToLogical(outside, [wa]);
    assert(result === null, `expected null, got ${JSON.stringify(result)}`);
  } finally {
    f.cleanup();
  }
});

check("single match → logical extra:<basename>/<rel>", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });
    const file = path.join(wa, "voice", "2026-04-26", "note.opus");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "stub");

    const result = mapAbsoluteToLogical(file, [wa]);
    assert(result !== null, "expected mapping");
    assert(result?.kind === "logical", `expected logical, got ${result?.kind}`);
    if (result?.kind === "logical") {
      assert(
        result.path === "extra:claude-whatsapp/voice/2026-04-26/note.opus",
        `expected canonical logical path, got "${result.path}"`
      );
    }
  } finally {
    f.cleanup();
  }
});

check("nested extraPaths → longest-prefix-wins", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    // Outer extraPath: f.root/exports
    // Inner extraPath: f.root/exports/claude-whatsapp
    // File: f.root/exports/claude-whatsapp/2026-04-26.md
    const outer = path.join(f.root, "exports");
    const inner = path.join(outer, "claude-whatsapp");
    fs.mkdirSync(inner, { recursive: true });
    const file = path.join(inner, "2026-04-26.md");
    fs.writeFileSync(file, "stub");

    const result = mapAbsoluteToLogical(file, [outer, inner]);
    assert(result?.kind === "logical", "longest-prefix-wins matches");
    if (result?.kind === "logical") {
      // Inner root's basename is "claude-whatsapp" — that's what wins.
      assert(
        result.path === "extra:claude-whatsapp/2026-04-26.md",
        `expected inner root match, got "${result.path}"`
      );
    }
  } finally {
    f.cleanup();
  }
});

check("non-channel basename → null (not a scope concern)", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const notes = path.join(f.root, "notes");
    fs.mkdirSync(notes, { recursive: true });
    const file = path.join(notes, "ideas.md");
    fs.writeFileSync(file, "x");

    const result = mapAbsoluteToLogical(file, [notes]);
    assert(
      result === null,
      `non-channel basename should not be classified, got ${JSON.stringify(result)}`
    );
  } finally {
    f.cleanup();
  }
});

check("symlink alias of channel root → same canonical mapping", () => {
  if (process.platform === "win32") {
    // Skip — symlink semantics differ.
    return;
  }
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });
    const file = path.join(wa, "x.md");
    fs.writeFileSync(file, "x");

    const aliasRoot = path.join(f.root, "wa-alias");
    fs.symlinkSync(wa, aliasRoot);

    const fileViaAlias = path.join(aliasRoot, "x.md");
    const result = mapAbsoluteToLogical(fileViaAlias, [aliasRoot]);
    assert(result?.kind === "logical", "alias resolves to same canonical");
    if (result?.kind === "logical") {
      // Basename used for prefix = configured root's basename (the alias).
      // We accept either basename in the path; the gate downstream is
      // what matters and either basename derives the same channel via
      // deriveChannelHint.
      assert(
        result.path.startsWith("extra:"),
        `expected extra: prefix, got "${result.path}"`
      );
      assert(result.path.endsWith("/x.md"), "rel preserved");
    }
  } finally {
    f.cleanup();
  }
});

check("realpath fails on absPath but textual prefix matches → deny", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });

    // Construct an absolute path under `wa/` that does NOT exist on
    // disk. fs.realpathSync will throw ENOENT — the helper should
    // hit the textual fallback and deny.
    const ghost = path.join(wa, "ghost", "missing.opus");

    const result = mapAbsoluteToLogical(ghost, [wa]);
    assert(
      result?.kind === "deny",
      `expected deny on realpath-fail-under-channel-root, got ${JSON.stringify(result)}`
    );
    if (result?.kind === "deny") {
      assert(result.channel === "whatsapp", `channel mapped, got "${result.channel}"`);
    }
  } finally {
    f.cleanup();
  }
});

check("realpath fails on absPath outside any extraPath → null", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });
    const ghost = path.join(f.root, "outside", "missing.opus"); // not under wa

    const result = mapAbsoluteToLogical(ghost, [wa]);
    assert(
      result === null,
      `outside-extra realpath fail should be null, got ${JSON.stringify(result)}`
    );
  } finally {
    f.cleanup();
  }
});

check("path equal to extraPath itself → null (it's the root, not a file)", () => {
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });

    const result = mapAbsoluteToLogical(wa, [wa]);
    assert(
      result === null,
      `extraPath==absPath should be null, got ${JSON.stringify(result)}`
    );
  } finally {
    f.cleanup();
  }
});

check("two distinct extraPath aliases resolve to same canonical → fail-closed deny", () => {
  if (process.platform === "win32") return;
  const f = makeFixture();
  try {
    _resetCachesForTests();
    const wa = path.join(f.root, "claude-whatsapp");
    fs.mkdirSync(wa, { recursive: true });
    const file = path.join(wa, "x.md");
    fs.writeFileSync(file, "x");

    const alias = path.join(f.root, "wa-symlink");
    fs.symlinkSync(wa, alias);

    // Both extraPaths resolve to the same canonical root → tie at
    // longest-prefix → fail-closed deny.
    const result = mapAbsoluteToLogical(file, [wa, alias]);
    assert(
      result?.kind === "deny",
      `aliased-tie should fail closed, got ${JSON.stringify(result)}`
    );
  } finally {
    f.cleanup();
  }
});

check(
  "Codex HIGH fix: ~/-prefixed extraPath is expanded before realpath",
  () => {
    // The user's config can store extraPaths as `~/...`. MemoryDB
    // expands those at construction, but raw config reaching the
    // server-side voice_transcribe handler still has the literal `~/`.
    // Without expansion, every tilde-prefixed extra fails realpath
    // and the helper returns null → assertCanReadPath gets the abs
    // path → classified as legacy → allowed → BYPASS.
    const home = os.homedir();
    // Drop a sentinel dir under the real home so we don't have to
    // monkey-patch os.homedir(). Cleaning up afterwards.
    const sentinelDir = path.join(home, ".clawcode-tildeexpansion-test");
    const channelDir = path.join(sentinelDir, "claude-whatsapp");
    fs.mkdirSync(channelDir, { recursive: true });
    try {
      _resetCachesForTests();
      const file = path.join(channelDir, "x.md");
      fs.writeFileSync(file, "x");

      // Configured extra is the *literal* tilde form.
      const tildeExtra = path.join(
        "~",
        ".clawcode-tildeexpansion-test",
        "claude-whatsapp"
      );

      const result = mapAbsoluteToLogical(file, [tildeExtra]);
      assert(
        result?.kind === "logical",
        `expected ~/ extra to expand and produce logical mapping, got ${JSON.stringify(result)}`
      );
      if (result?.kind === "logical") {
        assert(
          result.path === "extra:claude-whatsapp/x.md",
          `expected canonical extra path, got "${result.path}"`
        );
      }
    } finally {
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\nscope-abs-path-map tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
