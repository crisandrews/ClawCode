/**
 * Phase 5 — Codex round-5 follow-up (v6 + v7): HIGH Unicode case-fold +
 * MEDIUM textual fallback non-canonical + MEDIUM two-occurrence path
 * + MEDIUM case-sensitive APFS volume + LOW symlink-pointing-outside
 * fallback + LOW NUL/control-char hard-deny.
 *
 * v5 had: slice-by-length bug; non-canonical textual output; two-
 * occurrence indexOf collision; over-broad case-fold; soft-pass on
 * control chars.
 *
 * v6 fixes (closed in v6 round): path.relative for tail; regex-capture
 * canonical; per-workspace inode probe; realpath-success flag for
 * textual fallback; control-char early reject.
 *
 * v7 fixes (Codex 6th-pass): probe inside workspace (not via parent);
 * hard-deny on control chars at the gate; two-occurrence test now
 * exercises textual fallback (uses missing path so realpath fails).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCanReadPath,
  _resetWsCaseInsensitiveCacheForTests,
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "ph5v6-"));
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
  // -- HIGH #1: Unicode case-fold expansion (Turkish I) --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ph5v6-uni-"));
    const wsParent = path.join(tmpRoot, "İstanbul");
    let wsParentCreated = false;
    try {
      fs.mkdirSync(wsParent);
      wsParentCreated = true;
    } catch {
      ok("HIGH#1 Unicode case-fold expansion SKIPPED (mkdir fail)");
    }
    if (wsParentCreated) {
      const ws = path.join(wsParent, "ws");
      fs.mkdirSync(ws);
      const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
      fs.mkdirSync(scopedDir, { recursive: true });
      const scopedFile = path.join(scopedDir, "MEMORY.UNI.md");
      fs.writeFileSync(scopedFile, "# scoped\n", "utf-8");

      const { cfg, runtime } = buildArmedRuntime(ws);
      const ctx = makeForegroundContext("req-test");

      const gate = assertCanReadPath(scopedFile, ctx, runtime, cfg.scope, ws);
      if (gate.allowed)
        bad("HIGH#1 Unicode-expanding workspace prefix slice bypassed", gate);
      else
        ok(
          "HIGH#1 Unicode-expanding workspace prefix denied (path.relative tail)"
        );
    }
  }

  // -- MEDIUM #1: textual fallback emits canonical form (mixed case + missing file) --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const ws = makeWs();
    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const ghostMixed = path.join(
      ws,
      "MEMORY",
      ".SCOPED",
      "whatsapp",
      "MEMORY.GHOST.md"
    );

    const gate = assertCanReadPath(ghostMixed, ctx, runtime, cfg.scope, ws);
    if (gate.allowed)
      bad(
        "MEDIUM#1 mixed-case textual fallback bypassed (non-canonical output)",
        gate
      );
    else
      ok(
        "MEDIUM#1 mixed-case textual fallback denied (canonical regex captures)"
      );
  }

  // -- MEDIUM #2: two-occurrence path forces textual fallback (v7 fix) --
  // The path is missing on disk so realpath fails. Path string contains
  // two `memory/.scoped/` substrings. v6's regex-capture rebuild picks
  // the LAST match (the one anchored to `$`), independent of the first
  // occurrence in the string.
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const outer = makeWs();
    const innerWs = path.join(
      outer,
      "memory",
      ".scoped",
      "whatsapp",
      "fake-inner-workspace"
    );
    fs.mkdirSync(innerWs, { recursive: true });
    const ghostTwo = path.join(
      innerWs,
      "memory",
      ".scoped",
      "whatsapp",
      "MEMORY.TWO.md"
    );

    const { cfg, runtime } = buildArmedRuntime(innerWs);
    const ctx = makeForegroundContext("req-test");

    const gate = assertCanReadPath(ghostTwo, ctx, runtime, cfg.scope, innerWs);
    if (gate.allowed)
      bad(
        "MEDIUM#2 two-occurrence textual fallback bypassed (indexOf bug)",
        gate
      );
    else
      ok("MEDIUM#2 two-occurrence textual fallback denied (regex-capture)");
  }

  // -- LOW #1: symlink inside workspace pointing outside --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const ws = makeWs();
    const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });

    const externalTarget = path.join(
      os.tmpdir(),
      `ph5v6-external-${Date.now()}.md`
    );
    fs.writeFileSync(externalTarget, "# external secret\n", "utf-8");

    const linked = path.join(scopedDir, "MEMORY.LINKED.md");
    let linkedCreated = false;
    try {
      fs.symlinkSync(externalTarget, linked, "file");
      linkedCreated = true;
    } catch {
      ok("LOW#1 symlink-out SKIPPED (no symlink permission)");
    }
    if (linkedCreated) {
      const { cfg, runtime } = buildArmedRuntime(ws);
      const ctx = makeForegroundContext("req-test");

      const gate = assertCanReadPath(linked, ctx, runtime, cfg.scope, ws);
      if (!gate.allowed)
        bad(
          "LOW#1 symlink-out gate over-denied — should be pass-through (caller denies via containment)",
          gate
        );
      else
        ok(
          "LOW#1 symlink-out gate passes through (caller's containment denies)"
        );
      try {
        fs.unlinkSync(externalTarget);
      } catch {
        /* ignore */
      }
    }
  }

  // -- LOW #2: NUL embedded in path (v7 hard-deny) --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const ws = makeWs();
    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const nulPath =
      path.join(ws, "memory/.scoped/whatsapp/MEMORY.") +
      String.fromCharCode(0) +
      "bad.md";

    let gate;
    try {
      gate = assertCanReadPath(nulPath, ctx, runtime, cfg.scope, ws);
    } catch (e) {
      bad("LOW#2 NUL-embedded path threw", e);
      gate = null;
    }
    if (gate && !gate.allowed)
      ok("LOW#2 NUL-embedded path hard-denied at gate (v7)");
    else if (gate)
      bad("LOW#2 NUL-embedded path allowed (should be denied)", gate);
  }

  // -- LOW #2: low control char (0x01) (v7 hard-deny) --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const ws = makeWs();
    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const ctrlPath =
      path.join(ws, "memory/.scoped/whatsapp/MEMORY.") +
      String.fromCharCode(1) +
      "bad.md";

    let gate;
    try {
      gate = assertCanReadPath(ctrlPath, ctx, runtime, cfg.scope, ws);
    } catch (e) {
      bad("LOW#2 control-char path threw", e);
      gate = null;
    }
    if (gate && !gate.allowed)
      ok("LOW#2 control-char path hard-denied at gate (v7)");
    else if (gate)
      bad("LOW#2 control-char path allowed (should be denied)", gate);
  }

  // -- WATCH (traversal): `..` in absolute path --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const ws = makeWs();
    const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    fs.writeFileSync(
      path.join(scopedDir, "MEMORY.TRAVERSAL.md"),
      "# scoped\n",
      "utf-8"
    );

    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const traversal = path.join(
      ws,
      "memory/.scoped/whatsapp/../../../etc/passwd"
    );
    const gate = assertCanReadPath(traversal, ctx, runtime, cfg.scope, ws);
    if (!gate.allowed)
      bad("WATCH traversal over-denied (should pass through)", gate);
    else ok("WATCH traversal: collapses outside-ws -> pass-through");
  }

  // -- Sanity: regression on linux behavior of textual fallback --
  {
    _resetWsCaseInsensitiveCacheForTests();
    _resetRuntimeForTests();
    const ws = makeWs();
    const { cfg, runtime } = buildArmedRuntime(ws);
    const ctx = makeForegroundContext("req-test");

    const ghost = path.join(
      ws,
      "memory/.scoped/whatsapp/MEMORY.SANITY.md"
    );
    const gate = assertCanReadPath(ghost, ctx, runtime, cfg.scope, ws);
    if (gate.allowed)
      bad("regression: ghost lowercase scoped path bypassed", gate);
    else ok("regression: ghost lowercase scoped path denied (textual)");
  }

  console.log(results.join("\n"));
  console.log(`\n${pass}/${pass + fail} Phase 5 v6+v7 (round-5+6) tests passed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
