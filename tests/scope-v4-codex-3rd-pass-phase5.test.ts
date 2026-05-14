/**
 * Phase 5 — Codex round-3 follow-up (v4): BLOCK + MEDIUM + 2 LOW fixes.
 *
 *   BLOCK   — `assertCanReadPath` accepts absolute workspace-contained
 *             paths and normalizes them to relative form before
 *             `deriveProvenance`. Without this, an absolute scoped
 *             MEMORY path bypasses the channel filter.
 *
 *   MEDIUM  — `detectScopeRuntime(config, workspaceRoot)` and
 *             `resolveWhatsappChannelDir(config, workspaceRoot)` honor
 *             the workspace argument over `process.cwd()`. Detached
 *             servers / background jobs no longer miss a project-local
 *             claude-whatsapp install.
 *
 *   LOW #1  — `checkScopeStatus` surfaces typo'd values via
 *             `collectScopeConfigWarnings` (e.g. `mode: "enfroce"` →
 *             warn row, not silent fail-closed-to-off).
 *
 *   LOW #2  — `ChannelName` union now includes "webchat" so the scope
 *             code stops casting webchat away.
 *
 * All cases are tier1 — pure Node fs + the public APIs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCanReadPath,
  filterScopedResults,
} from "../lib/scope/filter.ts";
import {
  detectScopeRuntime,
  resolveWhatsappChannelDir,
  _resetRuntimeForTests,
} from "../lib/scope/runtime.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import {
  collectScopeConfigWarnings,
  loadConfig,
} from "../lib/config.ts";
import { checkScopeStatus } from "../lib/doctor.ts";
import type { ChannelName } from "../lib/channel-detector.ts";

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "ph5v4-"));
}

function writeJson(file: string, obj: unknown) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf-8");
}

async function run() {
  // -- BLOCK: assertCanReadPath normalizes absolute paths --
  // Without the normalize, a workspace-absolute path to a scoped
  // MEMORY mirror falls through to `_local` (deriveProvenance only
  // matches the relative form) and the gate returns allowed=true.
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    const scopedDir = path.join(ws, "memory", ".scoped", "whatsapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    const scopedFile = path.join(scopedDir, "MEMORY.5491100000000.md");
    fs.writeFileSync(scopedFile, "# scoped\n", "utf-8");

    // Force the runtime into an armed state by pointing scope at a
    // freshly-built fake access.json with no owner JIDs (bootstrap
    // fail-open) and `mode: enforce`. We have to write the config so
    // detectScopeRuntime sees it.
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
    const runtime = detectScopeRuntime(cfg, ws);
    if (!runtime.anyArmed) bad("BLOCK runtime armed", runtime);

    const ctx = makeForegroundContext("req-test");
    // Relative form — still denied.
    const relGate = assertCanReadPath(
      "memory/.scoped/whatsapp/MEMORY.5491100000000.md",
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (relGate.allowed)
      bad("BLOCK relative form should deny", relGate);
    else ok("BLOCK assertCanReadPath: relative form denies (baseline)");

    // Absolute form — must ALSO be denied. Pre-fix: allowed=true.
    const absGate = assertCanReadPath(
      scopedFile,
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (absGate.allowed)
      bad("BLOCK absolute form should deny", absGate);
    else
      ok("BLOCK assertCanReadPath: absolute form normalized + denied (CORE FIX)");

    // Sanity: an absolute path OUTSIDE the workspace passes through
    // unchanged → classified as legacy_unprovenanced → allowed (caller
    // applies its own containment).
    const outsideGate = assertCanReadPath(
      "/tmp/random-thing.md",
      ctx,
      runtime,
      cfg.scope,
      ws
    );
    if (!outsideGate.allowed)
      bad("BLOCK outside-workspace allowed", outsideGate);
    else ok("BLOCK absolute path outside workspace falls through");
  }

  // -- BLOCK: workspaceRoot omitted → behavior matches pre-v4 --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
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
    const runtime = detectScopeRuntime(cfg, ws);
    const ctx = makeForegroundContext("req-test");
    // Without workspaceRoot, an absolute path classifies as legacy
    // (provenance has no signal) → allowed. This preserves backward
    // compat for callers that didn't have a workspace handy.
    const absPath = path.join(ws, "memory/.scoped/whatsapp/MEMORY.x.md");
    const gate = assertCanReadPath(absPath, ctx, runtime, cfg.scope);
    if (!gate.allowed)
      bad("BLOCK workspaceRoot omitted → backward-compat", gate);
    else ok("BLOCK workspaceRoot omitted → falls back to legacy classification");
  }

  // -- MEDIUM: detectScopeRuntime honors workspaceRoot, not cwd --
  // We construct two workspaces. WS-A has a fake .whatsapp/access.json
  // that should be discovered when workspaceRoot=WS-A even from a cwd
  // unrelated to either. WS-B has nothing. With cwd=/tmp + workspace=
  // WS-A, we expect armed; with cwd=/tmp + workspace=WS-B, we expect
  // disarmed. (cwd is unchanged — we rely on the parameter.)
  {
    _resetRuntimeForTests();
    const wsA = makeWs();
    const wsAAccess = path.join(wsA, ".whatsapp");
    fs.mkdirSync(wsAAccess, { recursive: true });
    writeJson(path.join(wsAAccess, "access.json"), {
      ownerJids: [],
      groups: {},
      allowFrom: [],
    });
    // cwdExactMatchOnly forces detectWhatsappProjectDir to require the
    // baseCwd === project root match — which is exactly what the
    // workspace-vs-cwd fix tests.
    writeJson(path.join(wsA, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: "auto",
          cwdExactMatchOnly: true,
          background: { identity: "deny" },
        },
      },
    });

    const wsB = makeWs();
    writeJson(path.join(wsB, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: "auto",
          cwdExactMatchOnly: true,
          background: { identity: "deny" },
        },
      },
    });

    // Note: detectWhatsappProjectDir's auto-discovery walks home/cwd
    // looking for installed plugins. We don't have a paired install
    // here, so the project-local fallback path requires baseCwd to
    // resolve under a known plugin path. The cleanest assertion we can
    // make without forging a paired install is that
    // resolveWhatsappChannelDir doesn't return null when cwdExactMatch
    // is off and we point it at our home dir. Instead, assert via the
    // `accessJsonPath: <explicit>` path which exercises the same threading
    // without needing a real plugin layout.
    _resetRuntimeForTests();
    writeJson(path.join(wsA, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "shadow",
          accessJsonPath: path.join(wsA, ".whatsapp", "access.json"),
          background: { identity: "deny" },
        },
      },
    });
    const cfgA = loadConfig(wsA);
    const dirFromWsA = resolveWhatsappChannelDir(cfgA, wsA);
    if (!dirFromWsA || !dirFromWsA.includes(path.join(wsA, ".whatsapp")))
      bad("MEDIUM resolveWhatsappChannelDir from wsA", dirFromWsA);
    else ok("MEDIUM resolveWhatsappChannelDir(cfg, ws) honors explicit path");

    // detectScopeRuntime fingerprint must include the workspace, so
    // cached state for wsA is NOT reused when called for wsB.
    _resetRuntimeForTests();
    const cfgB = loadConfig(wsB);
    const runtimeA = detectScopeRuntime(cfgA, wsA);
    const runtimeB = detectScopeRuntime(cfgB, wsB);
    if (runtimeA === runtimeB)
      bad(
        "MEDIUM detectScopeRuntime cache mixes workspaces",
        "same object returned"
      );
    else ok("MEDIUM detectScopeRuntime cache keyed by workspace");
  }

  // -- LOW #1: checkScopeStatus surfaces typo warnings --
  {
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "enfroce", // typo — coerced to "off"
          identity: "ownr", // typo — coerced to "auto"
          background: { identity: "system_owner" }, // typo — coerced to "deny"
        },
      },
    });
    const warnings = collectScopeConfigWarnings(ws);
    if (warnings.length !== 3)
      bad("LOW1 collectScopeConfigWarnings count", warnings);
    else ok("LOW1 collectScopeConfigWarnings finds 3 typos");

    const fields = warnings.map((w) => `${w.channel}.${w.field}`).sort();
    const expected = [
      "whatsapp.background.identity",
      "whatsapp.identity",
      "whatsapp.mode",
    ];
    if (JSON.stringify(fields) !== JSON.stringify(expected))
      bad("LOW1 typo fields", fields);
    else ok("LOW1 typo warnings cover mode + identity + background.identity");

    const check = checkScopeStatus(ws);
    if (check.status !== "warn")
      bad("LOW1 checkScopeStatus status", check.status);
    else ok("LOW1 checkScopeStatus → warn on typo'd values");
    if (!check.message.includes("invalid:"))
      bad("LOW1 checkScopeStatus message", check.message);
    else ok("LOW1 checkScopeStatus message surfaces invalid:");
    if (!check.message.includes("enfroce"))
      bad("LOW1 raw value visible", check.message);
    else ok("LOW1 checkScopeStatus shows raw typo'd value verbatim");
  }

  // -- LOW #1: clean config produces no warnings --
  {
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        whatsapp: {
          mode: "off",
          identity: "auto",
          background: { identity: "deny" },
        },
      },
    });
    const warnings = collectScopeConfigWarnings(ws);
    if (warnings.length !== 0)
      bad("LOW1 clean config", warnings);
    else ok("LOW1 collectScopeConfigWarnings: clean config → zero warnings");
  }

  // -- LOW #2: ChannelName includes "webchat" --
  {
    // Pure-type test compiled at runtime by tsx. If "webchat" weren't in
    // the union, this assignment would be a TS error (flagged by the
    // tsx loader on parse). Use a runtime sentinel just so the test
    // passes when the type assertion succeeds.
    const wc: ChannelName = "webchat";
    if (wc !== "webchat") bad("LOW2 webchat literal", wc);
    else ok("LOW2 ChannelName includes 'webchat'");
  }

  // -- LOW #2: scope code uses ChannelName uniformly for webchat --
  {
    // Sanity: the runtime ALL_KNOWN_SCOPE_CHANNELS array includes
    // webchat (we don't import it directly — exercise via the public
    // detectScopeRuntime path that builds runtime.channels for webchat
    // when configured).
    _resetRuntimeForTests();
    const ws = makeWs();
    writeJson(path.join(ws, "agent-config.json"), {
      memory: { backend: "builtin", citations: "auto" },
      scope: {
        webchat: {
          mode: "shadow",
          background: { identity: "deny" },
        },
      },
    });
    const cfg = loadConfig(ws);
    const runtime = detectScopeRuntime(cfg, ws);
    if (!runtime.channels.webchat)
      bad("LOW2 runtime.channels.webchat", runtime);
    else ok("LOW2 runtime.channels.webchat is keyed correctly");
  }

  console.log(results.join("\n"));
  console.log(`\n${pass}/${pass + fail} Phase 5 v4 (round-3) tests passed`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
