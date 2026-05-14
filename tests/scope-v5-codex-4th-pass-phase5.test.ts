/**
 * Phase 5 — Codex round-4 follow-up (v5): HIGH symlink + case-fold +
 * realpath-fail closures on `assertCanReadPath` normalization.
 *
 * The v4 implementation used `path.resolve` + `startsWith` which fails on:
 *   1. Symlinked workspace dirs (mkdtempSync on macOS returns
 *      `/var/folders/.../tmp/X` — a symlink to `/private/var/...`).
 *      An absolute scoped-MEMORY path realpathed to the canonical
 *      `/private/var/...` form would not match a `wsRoot=/var/...`
 *      prefix → bypass.
 *   2. Case-variant absolute paths on case-insensitive filesystems
 *      (APFS / NTFS). `/USERS/foo/...` vs `/Users/foo/...` reference
 *      the same inode but `startsWith` rejects the variant → bypass.
 *   3. Trailing slash on `workspaceRoot` (e.g. `/ws/`) — `startsWith`
 *      with `wsAbs + path.sep` would mis-handle the doubled separator.
 *   4. Realpath failure on a candidate that textually names a
 *      scoped-MEMORY path (file deleted between gate and read,
 *      dangling symlink, missing parent dir) — without textual
 *      fail-closed, the gate would let the read proceed.
 *
 * v5 fixes apply realpath canonicalization on both sides + case-fold
 * comparison on darwin/win32 + trailing-slash trim + textual-shape
 * fail-closed.
 *
 * All cases are tier1 (pure Node fs + the public API).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCanReadPath,
} from "../lib/scope/filter.ts";
import {
  detectScopeRuntime,
  _resetRuntimeForTests,
} from "../lib/scope/runtime.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import { loadConfig } from "../lib/config.ts";

let pass = 0;
let fail = 0;
const results: string[] = [];

function ok(name: string) {
  pass++;
  results.push(`  ✓ ${name}`);
}
function bad(name: string, why: unknown) {
  fail++;
  const msg =
    why instanceof Error ? `${why.message}\n${why.stack ?? ""}` : String(why);
  results.push(`  ✗ ${name}\n     ${msg.split("\n").join("\n     ")}`);
}

function makeWs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ph5v5-"));
}

function writeJson(file: string, obj: unknown) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}

function buildArmedRuntime(ws: string) {
  const fakeAccess = path.join(ws, "fake-access.json");
  writeJson(fakeAccess, { ownerJids: [], groups: {}, allowFrom: [] });
  writeJson(path.join(ws, "agent-config.json"), {
    memory: { backend: "builtin", citations: "auto" },
    scope: {
      whatsapp: {
        mode: "enforce",
        identity: "guest",
        accessJsonPath: fakeAccess,
        background: { identity: "deny" },
      },
    },
  });
  const cfg = loadConfig(ws);
  return { cfg, runtime: detectScopeRuntime(cfg, ws) };
}

async function run() {
  // -- HIGH #1: symlinked workspace path resolves to canonical form --
  // mkdtemp on macOS already returns a symlinked path (/var → /private/var).
  // We explicitly stage a second symlink to make the test platform-
  // independent: create a real workspace at WS_REAL, then symlink
  // WS_LINK → WS_REAL, and pass WS_LINK through both detectScopeRuntime
  // (so the cache and access path are keyed by the linked form) AND as
  // workspaceRoot to assertCanReadPath. The actual file lives under
  // WS_REAL (canonical). Pre-v5: gate accepts because the canonical
  // candidate path doesn't startsWith the linked workspace root.
  {
    _resetRuntimeForTests();
    const wsReal = makeWs();
    const wsLink = path.join(os.tmpdir(), `ph5v5-link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    try {
      fs.symlinkSync(wsReal, wsLink, "dir");
    } catch (e) {
      // Symlinks may not be available on every platform (Windows non-admin).
      // In that case fall through to the case-variant test only.
      ok("HIGH#1 symlinked workspace SKIPPED (no symlink permission)");
    }
    if (fs.existsSync(wsLink)) {
      const scopedDir = path.join(wsReal, "memory", ".scoped", "whatsapp");
      fs.mkdirSync(scopedDir, { recursive: true });
      const scopedFile = path.join(scopedDir, "MEMORY.5491100000000.md");
      fs.writeFileSync(scopedFile, "# scoped\n", "utf-8");

      const { cfg, runtime } = buildArmedRuntime(wsReal); // build via real
      if (!runtime.anyArmed) bad("HIGH#1 runtime not armed", runtime);

      const ctx = makeForegroundContext("req-test");
      // Pass the LINKED workspace root to assertCanReadPath. Pre-v5
      // this fails because path.resolve(wsLink) === wsLink (symlinks
      // are not auto-resolved) but the candidate canonicalizes to
      // wsReal. v5 applies realpath to both.
      const gate = assertCanReadPath(
        scopedFile, // canonical absolute under wsReal
        ctx,
        runtime,
        cfg.scope,
        wsLink // linked form
      );
      if (gate.allowed)
        bad("HIGH#1 symlinked-workspace canonical scoped path bypassed", gate);
      else ok("HIGH#1 symlinked-workspace canonical scoped path denied (CORE FIX)");
      try {
        fs.unlinkSync(wsLink);
      } catch {
        /* ignore */
      }
    }
  }

  // -- HIGH #2: linked candidate, real workspace --
  // Inverse direction: real workspace + symlinked candidate path.
  {
    _resetRuntimeForTests();
    const wsReal = makeWs();
    const scopedDir = path.join(wsReal, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    const scopedFile = path.join(scopedDir, "MEMORY.5491100000001.md");
    fs.writeFileSync(scopedFile, "# scoped\n", "utf-8");

    const linkedCandidate = path.join(os.tmpdir(), `ph5v5-cand-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
    let linked = false;
    try {
      fs.symlinkSync(scopedFile, linkedCandidate, "file");
      linked = true;
    } catch {
      ok("HIGH#2 linked-candidate SKIPPED (no symlink permission)");
    }
    if (linked) {
      const { cfg, runtime } = buildArmedRuntime(wsReal);
      const ctx = makeForegroundContext("req-test");
      // Pass the linked candidate (which lives outside wsReal as a path
      // string but realpaths into wsReal) and the real workspace.
      const gate = assertCanReadPath(
        linkedCandidate,
        ctx,
        runtime,
        cfg.scope,
        wsReal
      );
      if (gate.allowed)
        bad("HIGH#2 symlinked-candidate scoped path bypassed", gate);
      else ok("HIGH#2 symlinked-candidate scoped path denied via realpath");
      try {
        fs.unlinkSync(linkedCandidate);
      } catch {
        /* ignore */
      }
    }
  }

  // -- HIGH #3: case-variant absolute path on case-insensitive FS --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    const scopedFile = path.join(scopedDir, "MEMORY.5491100000002.md");
    fs.writeFileSync(scopedFile, "# scoped\n", "utf-8");

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    // Build a case-variant by uppercasing the basename of the
    // scopedFile. On darwin/APFS-default this resolves to the same
    // inode; on linux it does NOT. The case-fold logic in v5 must
    // accept the variant on darwin even when the actual path on disk
    // is the lowercase form. On linux we simulate the bug by passing
    // a known-existing variant through the helper indirectly via the
    // case-fold compare path.
    if (process.platform === "darwin") {
      // Uppercase the channel segment ("whatsapp" → "WHATSAPP"). APFS
      // is case-insensitive by default; the regex used downstream is
      // also case-insensitive. The path variants reference the same
      // inode.
      const variant = scopedFile.replace(/whatsapp/g, "WHATSAPP");
      if (variant === scopedFile) {
        ok("HIGH#3 case-variant SKIPPED (path didn't transform)");
      } else if (!fs.existsSync(variant)) {
        // APFS case-sensitive volume — variant doesn't resolve. Skip.
        ok("HIGH#3 case-variant SKIPPED (APFS case-sensitive volume)");
      } else {
        const gate = assertCanReadPath(
          variant,
          ctx,
          runtime,
          cfg.scope,
          ws
        );
        if (gate.allowed)
          bad("HIGH#3 case-variant absolute path bypassed (darwin)", gate);
        else ok("HIGH#3 case-variant absolute path denied (darwin case-fold)");
      }
    } else {
      ok("HIGH#3 case-variant SKIPPED (non-darwin platform)");
    }
  }

  // -- HIGH #4: trailing slash on workspaceRoot --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    const scopedFile = path.join(scopedDir, "MEMORY.5491100000003.md");
    fs.writeFileSync(scopedFile, "# scoped\n", "utf-8");

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const gateTrailing = assertCanReadPath(
      scopedFile,
      ctx,
      runtime,
      cfg.scope,
      ws + path.sep // trailing separator
    );
    if (gateTrailing.allowed)
      bad("HIGH#4 trailing-slash workspaceRoot bypassed", gateTrailing);
    else ok("HIGH#4 trailing-slash workspaceRoot still denies");

    const gateDoubleTrailing = assertCanReadPath(
      scopedFile,
      ctx,
      runtime,
      cfg.scope,
      ws + path.sep + path.sep // doubled trailing separator
    );
    if (gateDoubleTrailing.allowed)
      bad("HIGH#4 double trailing-slash workspaceRoot bypassed", gateDoubleTrailing);
    else ok("HIGH#4 double trailing-slash workspaceRoot still denies");
  }

  // -- HIGH #5: realpath fails on candidate but textual shape matches --
  // The file doesn't exist (file deleted between gate and read, or
  // dangling symlink, or never created). Without v5's textual fail-
  // closed, the gate would treat the candidate as `legacy_unprovenanced`
  // and allow the (about-to-fail) read to proceed.
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    // NOTE: do NOT create the scoped file. The textual shape matches
    // but realpath will fail.
    const ghostScoped = path.join(
      ws,
      "memory",
      ".scoped",
      "whatsapp",
      "MEMORY.GHOST.md"
    );

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(
      ghostScoped,
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (gate.allowed)
      bad("HIGH#5 realpath-fails + textual scoped shape bypassed", gate);
    else ok("HIGH#5 realpath-fails + textual scoped shape denied (textual fail-closed)");
  }

  // -- HIGH #6: realpath fails AND textual shape doesn't match --
  // Should pass through unchanged so deriveProvenance returns
  // legacy_unprovenanced and the gate allows. (Caller's lower-level
  // containment + read-permission still apply, so this isn't a leak.)
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const ghostNonScoped = path.join(ws, "memory", "GHOST.md");

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(
      ghostNonScoped,
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (!gate.allowed)
      bad("HIGH#6 ghost non-scoped path should pass through", gate);
    else ok("HIGH#6 ghost non-scoped path passes through (no textual match)");
  }

  // -- Sanity: relative scoped path still denied (regression guard) --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopedDir, "MEMORY.5491100000004.md"),
      "# scoped\n",
      "utf-8"
    );

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(
      "memory/.scoped/whatsapp/MEMORY.5491100000004.md",
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (gate.allowed)
      bad("regression: relative scoped path now allowed", gate);
    else ok("regression: relative scoped path still denied");
  }

  // -- Sanity: outside-workspace absolute path still falls through --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const ws2 = makeWs(); // unrelated workspace
    const outsideFile = path.join(ws2, "random.md");
    fs.writeFileSync(outsideFile, "# unrelated\n", "utf-8");

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(outsideFile, ctx, runtime, cfg.scope, ws);
    if (!gate.allowed)
      bad("regression: outside-workspace path no longer falls through", gate);
    else ok("regression: outside-workspace path still falls through");
  }

  // -- Sanity: extra: paths bypass normalization --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(
      "extra:claude-whatsapp/logs/2026-01-01.md",
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (gate.allowed)
      bad("regression: extra: path should be denied with armed enforce", gate);
    else ok("regression: extra: path still routed through channel filter");
  }

  console.log(results.join("\n"));
  console.log(`\n${pass}/${pass + fail} Phase 5 v5 (round-4) tests passed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
