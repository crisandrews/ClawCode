/**
 * Tier 1 + tier 2 regression tests for the Codex 7th-pass post-impl
 * findings on Phase 4a-2.5 v7 (2 HIGH + 1 MEDIUM + 1 LOW).
 *
 * Coverage:
 *   - HIGH F1 (V7-7P-F1): `memory.extraPaths` is on the privileged
 *     blocklist (provenance deception via flipped extraPaths).
 *   - HIGH F2 (V7-7P-F2): `memory.qmd.command` is on the privileged
 *     blocklist (arbitrary code exec via flipped QMD binary path).
 *   - MEDIUM F3 (V7-7P-F3): live-config hot-reload preserves the
 *     prior in-memory value of every privileged key when the on-disk
 *     value changes. The user is notified via the critical-change
 *     callback so they can `/mcp` consciously.
 *   - LOW F4 (V7-7P-F4): descendant of a privileged leaf is also
 *     refused (e.g. `voice.outputDir.weirdKey` → no type-poison).
 *
 * Run: `npx tsx tests/scope-v8-codex-7th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PRIVILEGED_PATH_KEYS,
  classifyAgentConfigKey,
} from "../lib/scope/agent-config-guard.ts";
import {
  __testReload,
  __testReset,
  getLiveConfig,
  initLiveConfig,
  startConfigWatcher,
} from "../lib/live-config.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// HIGH F1 + F2: privileged-set widening
// ---------------------------------------------------------------------------

check("HIGH F1: blocks `memory.extraPaths` (provenance deception)", () => {
  if (classifyAgentConfigKey("memory.extraPaths") !== "privileged")
    throw new Error("memory.extraPaths must be privileged");
});

check("HIGH F1: blocks `memory` (ancestor of extraPaths)", () => {
  if (classifyAgentConfigKey("memory") !== "privileged")
    throw new Error("memory ancestor must be privileged");
});

check("HIGH F2: blocks `memory.qmd.command` (spawnSync target)", () => {
  if (classifyAgentConfigKey("memory.qmd.command") !== "privileged")
    throw new Error("memory.qmd.command must be privileged");
});

check("HIGH F2: blocks `memory.qmd` (ancestor)", () => {
  if (classifyAgentConfigKey("memory.qmd") !== "privileged")
    throw new Error("memory.qmd ancestor must be privileged");
});

check("HIGH: ALLOWS `memory.backend` (non-path-bearing)", () => {
  if (classifyAgentConfigKey("memory.backend") !== false)
    throw new Error("memory.backend must remain non-privileged");
});

check("HIGH: ALLOWS `memory.builtin.mmrLambda` (non-path nested)", () => {
  if (classifyAgentConfigKey("memory.builtin.mmrLambda") !== false)
    throw new Error("non-path memory keys must remain non-privileged");
});

// ---------------------------------------------------------------------------
// LOW F4: descendant of privileged leaf
// ---------------------------------------------------------------------------

check("LOW F4: blocks `voice.outputDir.weirdKey` (descendant)", () => {
  if (classifyAgentConfigKey("voice.outputDir.weirdKey") !== "privileged")
    throw new Error("descendants of privileged leaves must be refused");
});

check(
  "LOW F4: blocks `memory.qmd.command.subkey` (descendant of spawnSync target)",
  () => {
    if (
      classifyAgentConfigKey("memory.qmd.command.subkey") !== "privileged"
    )
      throw new Error("descendant of qmd.command must be refused");
  }
);

check("LOW F4: blocks `memory.extraPaths.0` (descendant of array)", () => {
  // A user might attempt index-style access. The descendant check
  // catches it identically.
  if (classifyAgentConfigKey("memory.extraPaths.0") !== "privileged")
    throw new Error("descendant of extraPaths must be refused");
});

// ---------------------------------------------------------------------------
// MEDIUM F3: live-config freeze of privileged keys on hot-reload
// ---------------------------------------------------------------------------

check("MEDIUM F3: privileged value frozen across disk reload", () => {
  const ws = tmpDir("scope-v8-livefreeze-");
  try {
    // Initial config — voice.outputDir = /tmp/initial-out
    const cfgPath = path.join(ws, "agent-config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          memory: { backend: "builtin" },
          voice: { outputDir: "/tmp/initial-out" },
        },
        null,
        2
      )
    );
    __testReset();
    initLiveConfig(ws);
    let live = getLiveConfig();
    if (live.voice?.outputDir !== "/tmp/initial-out")
      throw new Error("initial outputDir not loaded");

    // Wire the watcher (with a callback) and simulate an attacker-edit
    // of agent-config.json.
    const fired: Array<{ key: string; from: unknown; to: unknown }> = [];
    startConfigWatcher(ws, (changes) => {
      for (const c of changes) fired.push(c);
    });

    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          memory: { backend: "builtin" },
          voice: { outputDir: "/tmp/attacker-controlled" },
        },
        null,
        2
      )
    );
    __testReload();

    live = getLiveConfig();
    if (live.voice?.outputDir !== "/tmp/initial-out") {
      throw new Error(
        `expected outputDir frozen at /tmp/initial-out, got ${live.voice?.outputDir}`
      );
    }

    // Callback should have fired with the rejected change.
    const matched = fired.find(
      (c) => c.key === "voice.outputDir" && c.to === "/tmp/attacker-controlled"
    );
    if (!matched)
      throw new Error("expected callback to surface the rejected change");
  } finally {
    __testReset();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("MEDIUM F3: non-privileged value reloads normally", () => {
  const ws = tmpDir("scope-v8-livenormal-");
  try {
    const cfgPath = path.join(ws, "agent-config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          memory: { backend: "builtin", builtin: { mmrLambda: 0.5 } },
        },
        null,
        2
      )
    );
    __testReset();
    initLiveConfig(ws);
    let live = getLiveConfig();
    if (live.memory?.builtin?.mmrLambda !== 0.5)
      throw new Error("initial mmrLambda not loaded");

    startConfigWatcher(ws);

    // Edit a non-privileged key and reload.
    fs.writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          memory: { backend: "builtin", builtin: { mmrLambda: 0.8 } },
        },
        null,
        2
      )
    );
    __testReload();

    live = getLiveConfig();
    if (live.memory?.builtin?.mmrLambda !== 0.8)
      throw new Error(
        `non-privileged key should reload, got ${live.memory?.builtin?.mmrLambda}`
      );
  } finally {
    __testReset();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check(
  "MEDIUM F3: memory.extraPaths frozen across reload (provenance-critical)",
  () => {
    const ws = tmpDir("scope-v8-extraPaths-");
    try {
      const cfgPath = path.join(ws, "agent-config.json");
      const initialPaths = ["~/Desktop/whatsapp-channel/messages"];
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            memory: { backend: "builtin", extraPaths: initialPaths },
          },
          null,
          2
        )
      );
      __testReset();
      initLiveConfig(ws);
      let live = getLiveConfig();
      if (
        !Array.isArray(live.memory?.extraPaths) ||
        live.memory!.extraPaths![0] !== initialPaths[0]
      ) {
        throw new Error("initial extraPaths not loaded");
      }

      startConfigWatcher(ws);

      // Attacker tries to swap to an empty array (would bypass
      // mapAbsoluteToLogical for voice_transcribe).
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            memory: { backend: "builtin", extraPaths: [] },
          },
          null,
          2
        )
      );
      __testReload();

      live = getLiveConfig();
      if (
        !Array.isArray(live.memory?.extraPaths) ||
        live.memory!.extraPaths![0] !== initialPaths[0]
      ) {
        throw new Error(
          `expected extraPaths frozen, got ${JSON.stringify(live.memory?.extraPaths)}`
        );
      }
    } finally {
      __testReset();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Sanity: privileged set hasn't lost any v7-era keys
// ---------------------------------------------------------------------------

check("Sanity: voice.outputDir + voice.config.outputDir still privileged", () => {
  if (!PRIVILEGED_PATH_KEYS.has("voice.outputDir"))
    throw new Error("voice.outputDir lost from set");
  if (!PRIVILEGED_PATH_KEYS.has("voice.config.outputDir"))
    throw new Error("voice.config.outputDir lost from set");
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
  console.log(`\n${pass}/${pass + fail} v8 Codex-7th-pass tests passed`);
  if (fail > 0) process.exit(1);
}, 50);
