/**
 * Tier 1 + tier 2 tests for the Phase 3 detectScopeRuntime() impl.
 *
 * Covers:
 *  - no config arg → no-armed (Phase 0 callers preserved)
 *  - config without `scope` block → no-armed
 *  - config with `scope.whatsapp.mode=off` → no-armed
 *  - config with `scope.whatsapp.mode=enforce` BUT no access.json → not armed
 *  - config with `scope.whatsapp.mode=shadow` AND access.json present → armed
 *  - cache returns same shape within TTL
 *  - other channels stay disarmed (no adapter)
 *  - applyPreventivePromoteGuard skips channel chunks ONLY when armed
 *
 * Run: `npx tsx tests/scope-runtime-real.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  _peekCachedRuntimeForTests,
  _resetRuntimeForTests,
  applyPreventivePromoteGuard,
  detectScopeRuntime,
  getScopeAdapter,
} from "../lib/scope/runtime.ts";
import { DreamEngine } from "../lib/dreaming.ts";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-runtime-"));
  return {
    workspace: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const baseConfig = {
  memory: { backend: "builtin" as const, citations: "auto" as const },
};

// ---------------------------------------------------------------------------
// No-config / no-scope paths
// ---------------------------------------------------------------------------

check("no-arg call returns no-armed (Phase 0 callers preserved)", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime();
  assert(r.anyArmed === false, "no armed");
  assert(Object.keys(r.channels).length === 0, "no channels");
});

check("config without scope block returns no-armed", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({ ...baseConfig });
  assert(r.anyArmed === false, "no armed");
  assert(_peekCachedRuntimeForTests() === null, "no cache (early exit)");
});

check("config with scope.whatsapp.mode=off returns no-armed", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    ...baseConfig,
    scope: { whatsapp: { mode: "off" } },
  });
  assert(r.anyArmed === false, "off -> no armed");
  assert(r.channels.whatsapp?.armed === false, "wa explicitly disarmed");
  assert(r.channels.whatsapp?.mode === "off", "mode preserved");
});

check("config in shadow mode but missing access.json stays disarmed", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    ...baseConfig,
    scope: {
      whatsapp: {
        mode: "shadow",
        accessJsonPath: "/nonexistent/path/to/access.json",
      },
    },
  });
  assert(r.anyArmed === false, "no armed without governance");
  assert(r.channels.whatsapp?.armed === false, "wa not armed");
  assert(
    r.channels.whatsapp?.governanceResolvable === false,
    "governance unresolvable"
  );
  assert(
    typeof r.channels.whatsapp?.reason === "string",
    "reason explains why"
  );
});

check("config in shadow mode with valid access.json arms the channel", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const accessPath = path.join(f.workspace, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({ ownerJids: ["o@s.whatsapp.net"], allowFrom: [] })
    );
    const r = detectScopeRuntime({
      ...baseConfig,
      scope: {
        whatsapp: { mode: "shadow", accessJsonPath: accessPath },
      },
    });
    assert(r.anyArmed === true, "armed");
    assert(r.channels.whatsapp?.armed === true, "wa armed");
    assert(
      r.channels.whatsapp?.governanceResolvable === true,
      "governance resolvable"
    );
    assert(
      r.channels.whatsapp?.adapterAvailable === true,
      "adapter available"
    );
    // Adapter registered.
    const adapter = getScopeAdapter("whatsapp");
    assert(adapter !== undefined, "adapter registered in registry");
  } finally {
    f.cleanup();
  }
});

check("other channels stay disarmed (no adapter yet)", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    ...baseConfig,
    scope: { telegram: { mode: "enforce" } },
  });
  assert(r.anyArmed === false, "no armed without adapter");
  assert(r.channels.telegram?.armed === false, "telegram disarmed");
  assert(
    r.channels.telegram?.adapterAvailable === false,
    "no adapter for telegram"
  );
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

check("cache returns same state within TTL", () => {
  _resetRuntimeForTests();
  const r1 = detectScopeRuntime({
    ...baseConfig,
    scope: { whatsapp: { mode: "off" } },
  });
  const r2 = detectScopeRuntime({
    ...baseConfig,
    scope: { whatsapp: { mode: "off" } },
  });
  assert(r1 === r2, "same object reference within TTL");
});

check("cache invalidates on config fingerprint change", () => {
  _resetRuntimeForTests();
  const r1 = detectScopeRuntime({
    ...baseConfig,
    scope: { whatsapp: { mode: "off" } },
  });
  const r2 = detectScopeRuntime({
    ...baseConfig,
    scope: { whatsapp: { mode: "shadow" } },
  });
  assert(r1 !== r2, "different config -> fresh detection");
  // r2 should reflect shadow mode entry even though governance is missing.
  assert(r2.channels.whatsapp?.mode === "shadow", "shadow mode propagated");
});

// ---------------------------------------------------------------------------
// Codex P1 Item 9 — no-fs short-circuit invariants
// ---------------------------------------------------------------------------

check("config.scope undefined → never opens any file (Codex P1)", () => {
  _resetRuntimeForTests();
  // Replace lstatSync with a tripwire — the runtime must never call
  // it when scope is absent.
  const originalLstat = fs.lstatSync;
  let lstatCalls = 0;
  (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync = ((
    p: fs.PathLike,
    opts?: fs.StatSyncOptions
  ) => {
    lstatCalls++;
    return originalLstat(p, opts);
  }) as typeof fs.lstatSync;
  try {
    detectScopeRuntime({ ...baseConfig });
    assert(lstatCalls === 0, `expected 0 fs calls, got ${lstatCalls}`);
  } finally {
    (fs as unknown as { lstatSync: typeof fs.lstatSync }).lstatSync =
      originalLstat;
  }
});

check("disarm clears the previously-registered adapter (Codex P1)", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const accessPath = path.join(f.workspace, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
    );
    // First detection: armed.
    detectScopeRuntime({
      ...baseConfig,
      scope: { whatsapp: { mode: "shadow", accessJsonPath: accessPath } },
    });
    assert(getScopeAdapter("whatsapp") !== undefined, "adapter registered");
    // Second detection: mode flipped to off.
    detectScopeRuntime({
      ...baseConfig,
      scope: { whatsapp: { mode: "off" } },
    });
    assert(
      getScopeAdapter("whatsapp") === undefined,
      "stale adapter purged after disarm"
    );
  } finally {
    f.cleanup();
  }
});

check("config.scope removed entirely also drops adapter (Codex P1)", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const accessPath = path.join(f.workspace, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
    );
    detectScopeRuntime({
      ...baseConfig,
      scope: { whatsapp: { mode: "shadow", accessJsonPath: accessPath } },
    });
    assert(getScopeAdapter("whatsapp") !== undefined, "armed first");
    // No-scope follow-up.
    detectScopeRuntime({ ...baseConfig });
    assert(
      getScopeAdapter("whatsapp") === undefined,
      "adapter cleared when scope removed entirely"
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// applyPreventivePromoteGuard — Phase 0 invariant carries
// ---------------------------------------------------------------------------

check("preventive guard is no-op when no channel armed", () => {
  _resetRuntimeForTests();
  const candidates = [
    { entry: { path: "memory/MEMORY.md" } },
    { entry: { path: "extra:claude-whatsapp/x.md" } },
  ];
  const out = applyPreventivePromoteGuard(candidates);
  assert(out.kept.length === 2, "all candidates kept");
  assert(out.skipped === 0, "nothing skipped");
});

check("preventive guard drops channel chunks when armed", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const accessPath = path.join(f.workspace, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
    );
    const runtime = detectScopeRuntime({
      ...baseConfig,
      scope: {
        whatsapp: { mode: "shadow", accessJsonPath: accessPath },
      },
    });
    assert(runtime.anyArmed === true, "armed");
    const out = applyPreventivePromoteGuard(
      [
        { entry: { path: "memory/MEMORY.md" } },
        { entry: { path: "extra:claude-whatsapp/x.md" } },
      ],
      runtime
    );
    assert(out.kept.length === 1, `expected 1 kept, got ${out.kept.length}`);
    assert(out.skipped === 1, `expected 1 skipped, got ${out.skipped}`);
    assert(out.kept[0].entry.path === "memory/MEMORY.md", "local kept");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Codex CRITICAL fix (Phase 4a-2 adversarial review)
// ---------------------------------------------------------------------------

check("no-arg detect does NOT purge previously-registered adapters", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const accessPath = path.join(f.workspace, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
    );
    // First detect with armed scope: registers adapter.
    detectScopeRuntime({
      ...baseConfig,
      scope: { whatsapp: { mode: "shadow", accessJsonPath: accessPath } },
    });
    assert(getScopeAdapter("whatsapp") !== undefined, "armed");
    // Phase 0 / legacy caller passes no config — must NOT purge.
    detectScopeRuntime();
    assert(
      getScopeAdapter("whatsapp") !== undefined,
      "no-arg call must not purge adapter (would clear armed state mid-session)"
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Codex CRITICAL — dream cycle integration
// ---------------------------------------------------------------------------

check("DreamEngine.promoteToMemory drops extra: candidates when armed", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    // Use the workspace fixture as the plugin root so DreamEngine
    // points at a real dir we control. We need a real config file for
    // loadConfig to find scope.whatsapp = shadow.
    const memoryDir = path.join(f.workspace, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# Memory\n");
    const accessPath = path.join(f.workspace, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
    );
    fs.writeFileSync(
      path.join(f.workspace, "agent-config.json"),
      JSON.stringify({
        memory: { backend: "builtin", citations: "auto" },
        scope: {
          whatsapp: { mode: "shadow", accessJsonPath: accessPath },
        },
      })
    );

    // Drive the DreamEngine private promoteToMemory through reflection.
    // Cleaner test would expose a public surface, but for this regression
    // we just want to prove the wired runtime applies the guard.
    const engine = new DreamEngine(f.workspace) as unknown as {
      promoteToMemory: (promoted: unknown[]) => void;
    };

    // Two fake candidates — one local, one channel.
    const fakeEntry = (p: string) => ({
      key: `memory:${p}:1:1`,
      entry: {
        path: p,
        startLine: 1,
        endLine: 1,
        snippet: "decision: ship X",
        recallCount: 5,
        totalScore: 1,
        maxScore: 1,
        firstRecalledAt: new Date().toISOString(),
        lastRecalledAt: new Date().toISOString(),
        recallDays: ["2026-04-26"],
        conceptTags: ["x"],
      },
      signals: {
        frequency: 1,
        relevance: 1,
        queryDiversity: 1,
        recency: 1,
        consolidation: 1,
        conceptualRichness: 1,
      },
      finalScore: 1,
    });

    engine.promoteToMemory([
      fakeEntry("memory/2026-04-26.md"),
      fakeEntry("extra:claude-whatsapp/2026-04-26.md"),
    ]);

    const memoryContent = fs.readFileSync(
      path.join(memoryDir, "MEMORY.md"),
      "utf-8"
    );
    // The local candidate may or may not promote depending on rehydrate
    // (file doesn't exist). The channel candidate must NOT appear in
    // MEMORY.md. Phase 4a-3 dual-lane routes channel candidates to
    // memory/.scoped/<channel>/MEMORY.<chat>.md; the routing comment
    // must be surfaced in MEMORY.md.
    assert(
      !memoryContent.includes("extra:claude-whatsapp"),
      "channel candidate must not appear in MEMORY.md"
    );
    assert(
      memoryContent.includes("routed to memory/.scoped") ||
        memoryContent.includes("scope guard") ||
        memoryContent.includes("skipped"),
      "channel candidate must be surfaced as routed/skipped"
    );

    // Adapter must remain registered after dreams ran.
    assert(
      getScopeAdapter("whatsapp") !== undefined,
      "dream cycle must not purge the WhatsApp adapter"
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-runtime-real tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
