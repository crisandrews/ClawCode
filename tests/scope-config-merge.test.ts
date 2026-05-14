/**
 * Tier 1 + tier 2 tests for the Phase 3 `scope.*` deep-merge in
 * lib/config.ts.
 *
 * Covers:
 *  - omitting `scope` from agent-config.json keeps `config.scope`
 *    undefined (zero behavior change for users without opt-in)
 *  - empty `scope: {}` also stays undefined
 *  - per-channel defaults applied (mode=off, identity=auto,
 *    background.identity=deny)
 *  - whatsapp gets `accessJsonPath="auto"` and `cwdExactMatchOnly=false`
 *    when not specified
 *  - user-specified values win
 *  - unknown channel keys are ignored (forward-compat)
 *
 * Run: `npx tsx tests/scope-config-merge.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../lib/config.ts";

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

function makeFixture(configBody: object): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-cfg-"));
  fs.writeFileSync(
    path.join(root, "agent-config.json"),
    JSON.stringify(configBody, null, 2)
  );
  return {
    workspace: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Absent / empty
// ---------------------------------------------------------------------------

check("omitting scope keeps config.scope undefined", () => {
  const f = makeFixture({
    memory: { backend: "builtin", citations: "auto" },
  });
  try {
    const cfg = loadConfig(f.workspace);
    assert(cfg.scope === undefined, "no scope -> undefined");
  } finally {
    f.cleanup();
  }
});

check("empty scope:{} still resolves to undefined", () => {
  const f = makeFixture({
    memory: { backend: "builtin", citations: "auto" },
    scope: {},
  });
  try {
    const cfg = loadConfig(f.workspace);
    assert(cfg.scope === undefined, "empty -> undefined");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Per-channel defaults
// ---------------------------------------------------------------------------

check("scope.whatsapp:{} populates defaults", () => {
  const f = makeFixture({
    memory: { backend: "builtin", citations: "auto" },
    scope: { whatsapp: {} },
  });
  try {
    const cfg = loadConfig(f.workspace);
    const wa = cfg.scope?.whatsapp;
    assert(wa !== undefined, "whatsapp present");
    assert(wa!.mode === "off", `default mode off, got ${wa!.mode}`);
    assert(wa!.identity === "auto", `default identity auto, got ${wa!.identity}`);
    assert(
      wa!.background?.identity === "deny",
      "default background deny"
    );
    assert(wa!.accessJsonPath === "auto", "default accessJsonPath=auto");
    assert(wa!.cwdExactMatchOnly === false, "default cwdExactMatchOnly=false");
  } finally {
    f.cleanup();
  }
});

check("user-specified scope values win over defaults", () => {
  const f = makeFixture({
    memory: { backend: "builtin", citations: "auto" },
    scope: {
      whatsapp: {
        mode: "enforce",
        identity: "owner",
        background: { identity: "system-owner" },
        accessJsonPath: "/explicit/path/access.json",
        cwdExactMatchOnly: true,
      },
    },
  });
  try {
    const cfg = loadConfig(f.workspace);
    const wa = cfg.scope?.whatsapp;
    assert(wa!.mode === "enforce", "mode preserved");
    assert(wa!.identity === "owner", "identity preserved");
    assert(wa!.background?.identity === "system-owner", "background preserved");
    assert(
      wa!.accessJsonPath === "/explicit/path/access.json",
      "path preserved"
    );
    assert(wa!.cwdExactMatchOnly === true, "cwdExactMatchOnly preserved");
  } finally {
    f.cleanup();
  }
});

check("non-whatsapp channel gets defaults without WA-specific fields", () => {
  const f = makeFixture({
    memory: { backend: "builtin", citations: "auto" },
    scope: { telegram: { mode: "shadow" } },
  });
  try {
    const cfg = loadConfig(f.workspace);
    const tg = cfg.scope?.telegram;
    assert(tg !== undefined, "telegram present");
    assert(tg!.mode === "shadow", "mode preserved");
    assert(tg!.identity === "auto", "default identity");
    assert(tg!.background?.identity === "deny", "default background deny");
    // No accessJsonPath / cwdExactMatchOnly on non-WA channels.
    assert(
      !("accessJsonPath" in tg!),
      "no accessJsonPath on non-WA channels"
    );
  } finally {
    f.cleanup();
  }
});

check("unknown channel key is ignored (forward-compat)", () => {
  const f = makeFixture({
    memory: { backend: "builtin", citations: "auto" },
    scope: {
      whatsapp: { mode: "off" },
      mastodon: { mode: "enforce" }, // not in CHANNEL_REGISTRY
    },
  });
  try {
    const cfg = loadConfig(f.workspace);
    assert(cfg.scope?.whatsapp !== undefined, "wa kept");
    assert(
      (cfg.scope as Record<string, unknown>).mastodon === undefined,
      "unknown channel dropped"
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

console.log(`\nscope-config-merge tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
