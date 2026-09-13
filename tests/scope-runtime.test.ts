/**
 * Tier 1 tests for the scope runtime stub + preventive promote guard
 * (Phase 0 of channel-scope compat plan).
 *
 * Covers:
 *  - `detectScopeRuntime()` stub returns no-armed (Phase 0 invariant)
 *  - `isChannelDerivedPath` recognizes the `extra:` prefix
 *  - `applyPreventivePromoteGuard` is a no-op when no channel is armed
 *    (zero behavior change for users without opt-in)
 *  - `applyPreventivePromoteGuard` filters channel-derived candidates
 *    when at least one channel is armed (Phase 3+ behavior, exercised
 *    here with a synthetic runtime state)
 *
 * Run: `npx tsx tests/scope-runtime.test.ts`
 */

import path from "node:path";
import {
  detectScopeRuntime,
  isChannelDerivedPath,
  applyPreventivePromoteGuard,
  type ScopeRuntimeState,
} from "../lib/scope/runtime.ts";
import {
  detectRuntime,
  pluginManifestPaths,
  projectSkillsDir,
  resolvePluginRoot,
  resolveWorkspaceRoot,
  runtimeInfo,
} from "../lib/runtime.ts";
import { scopeDir } from "../lib/skill-manager.ts";
import {
  cronMatchesDate,
  dueEntries,
} from "../bin/clawcode-codex-cron-runner.mjs";

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

interface FakeCandidate {
  entry: { path: string };
}

function cand(p: string): FakeCandidate {
  return { entry: { path: p } };
}

const armedRuntime: ScopeRuntimeState = {
  anyArmed: true,
  anyEnforceConfigured: true,
  channels: {
    whatsapp: {
      mode: "enforce",
      configured: true,
      adapterAvailable: true,
      governanceResolvable: true,
      armed: true,
    },
  },
};

// ---------------------------------------------------------------------------
// detectScopeRuntime() Phase 0 stub
// ---------------------------------------------------------------------------

check("detectScopeRuntime stub returns no-armed", () => {
  const r = detectScopeRuntime();
  assert(r.anyArmed === false, "anyArmed must be false in Phase 0");
  assert(
    Object.keys(r.channels).length === 0,
    "channels must be empty in Phase 0"
  );
});

// ---------------------------------------------------------------------------
// isChannelDerivedPath
// ---------------------------------------------------------------------------

check("isChannelDerivedPath recognizes extra: prefix", () => {
  assert(
    isChannelDerivedPath("extra:claude-whatsapp/logs/x.md") === true,
    "extra:whatsapp"
  );
  assert(isChannelDerivedPath("extra:telegram/y.md") === true, "extra:telegram");
});

check("isChannelDerivedPath rejects local paths", () => {
  assert(
    isChannelDerivedPath("memory/MEMORY.md") === false,
    "memory/ is not channel-derived"
  );
  assert(
    isChannelDerivedPath("memory/note.md") === false,
    "regular memory file"
  );
  assert(isChannelDerivedPath("") === false, "empty string");
  assert(isChannelDerivedPath(undefined) === false, "undefined");
  assert(isChannelDerivedPath(null) === false, "null");
});

// ---------------------------------------------------------------------------
// applyPreventivePromoteGuard — Phase 0 no-op invariant
// ---------------------------------------------------------------------------

check("guard is no-op when no channel armed (Phase 0 stub)", () => {
  const candidates = [
    cand("memory/MEMORY.md"),
    cand("extra:claude-whatsapp/logs/x.md"),
    cand("extra:telegram/y.md"),
  ];
  // Use the stub directly: anyArmed=false
  const { kept, skipped } = applyPreventivePromoteGuard(candidates);
  assert(
    kept.length === 3,
    `Phase 0 must keep all candidates; got ${kept.length}`
  );
  assert(skipped === 0, `Phase 0 must skip none; got ${skipped}`);
});

check("guard preserves candidate order when armed=false", () => {
  const candidates = [
    cand("a"),
    cand("extra:b"),
    cand("c"),
    cand("extra:d"),
  ];
  const { kept } = applyPreventivePromoteGuard(candidates);
  assert(kept[0].entry.path === "a", "order preserved [0]");
  assert(kept[1].entry.path === "extra:b", "order preserved [1]");
  assert(kept[3].entry.path === "extra:d", "order preserved [3]");
});

// ---------------------------------------------------------------------------
// applyPreventivePromoteGuard — armed behavior (synthetic runtime)
// ---------------------------------------------------------------------------

// Codex Phase 4a-3 post-impl HIGH #6: the guard is channel-aware now.
// Only paths whose channel hint matches an ARMED channel are dropped;
// unarmed-channel paths fall through to the local lane so the user
// keeps that data until they opt-in.
check("guard skips ARMED-channel paths only when a channel is armed", () => {
  const candidates = [
    cand("memory/MEMORY.md"),
    cand("extra:claude-whatsapp/logs/x.md"), // whatsapp armed → dropped
    cand("extra:telegram/y.md"), // telegram unarmed → kept
    cand("memory/note.md"),
  ];
  const { kept, skipped } = applyPreventivePromoteGuard(
    candidates,
    armedRuntime
  );
  assert(kept.length === 3, `expected 3 kept, got ${kept.length}`);
  assert(skipped === 1, `expected 1 skipped, got ${skipped}`);
  // The dropped one must be the whatsapp path.
  const keptPaths = kept.map((k) => k.entry.path);
  assert(
    !keptPaths.includes("extra:claude-whatsapp/logs/x.md"),
    "armed-channel path should be dropped"
  );
  assert(
    keptPaths.includes("extra:telegram/y.md"),
    "unarmed-channel path should be kept"
  );
});

check("guard keeps unarmed-channel paths when only an UNRELATED channel armed", () => {
  // All candidates are extra: paths; only whatsapp is armed in the
  // synthetic runtime. The two non-whatsapp paths must survive.
  const candidates = [
    cand("extra:claude-whatsapp/x.md"),
    cand("extra:telegram/y.md"),
  ];
  const { kept, skipped } = applyPreventivePromoteGuard(
    candidates,
    armedRuntime
  );
  assert(kept.length === 1, `expected 1 kept, got ${kept.length}`);
  assert(skipped === 1, `expected 1 skipped, got ${skipped}`);
  assert(
    kept[0].entry.path === "extra:telegram/y.md",
    "telegram should be kept (unarmed channel)"
  );
});

check("guard handles missing entry.path defensively", () => {
  const candidates = [
    { entry: { path: undefined as unknown as string } },
    cand("memory/x.md"),
  ];
  const { kept } = applyPreventivePromoteGuard(candidates, armedRuntime);
  // Both kept: undefined path can't be channel-derived (and is also a
  // non-channel candidate by virtue of not matching extra:).
  assert(kept.length === 2, `expected 2 kept on undefined path, got ${kept.length}`);
});

// ---------------------------------------------------------------------------
// ClawCode host runtime detection — Claude Code vs Codex
// ---------------------------------------------------------------------------

check("detectRuntime honors explicit override", () => {
  assert(detectRuntime({ CLAWCODE_RUNTIME: "codex" } as NodeJS.ProcessEnv) === "codex", "codex override failed");
  assert(
    detectRuntime({ CLAWCODE_RUNTIME: "claude", CODEX_HOME: "/tmp/codex" } as NodeJS.ProcessEnv) === "claude",
    "claude override failed"
  );
});

check("detectRuntime falls back to CODEX_HOME", () => {
  assert(detectRuntime({ CODEX_HOME: "/tmp/codex" } as NodeJS.ProcessEnv) === "codex", "CODEX_HOME did not select codex");
  assert(detectRuntime({} as NodeJS.ProcessEnv) === "claude", "empty env should default to claude");
});

check("resolvePluginRoot prefers ClawCode env before Claude env", () => {
  const root = resolvePluginRoot({
    CLAWCODE_PLUGIN_ROOT: "/tmp/claw",
    CLAUDE_PLUGIN_ROOT: "/tmp/claude",
  } as NodeJS.ProcessEnv, "/tmp/cwd");
  assert(root === path.resolve("/tmp/claw"), `wrong plugin root: ${root}`);
});

check("resolveWorkspaceRoot prefers explicit Codex workspace", () => {
  const root = resolveWorkspaceRoot("/tmp/plugin", {
    CODEX_PROJECT_DIR: "/tmp/project",
    OLDPWD: "/tmp/old",
  } as NodeJS.ProcessEnv, "/tmp/plugin");
  assert(root === path.resolve("/tmp/project"), `wrong workspace: ${root}`);
});

check("resolveWorkspaceRoot uses OLDPWD when cwd is plugin root", () => {
  const root = resolveWorkspaceRoot("/tmp/plugin", {
    OLDPWD: "/tmp/workspace",
  } as NodeJS.ProcessEnv, "/tmp/plugin");
  assert(root === path.resolve("/tmp/workspace"), `wrong workspace: ${root}`);
});

check("runtimeInfo uses Codex paths", () => {
  const info = runtimeInfo("codex", { CODEX_HOME: "/tmp/codex-home" } as NodeJS.ProcessEnv);
  assert(info.projectSkillsDirName === ".codex", "wrong project skills dir name");
  assert(info.userSkillsDir === path.join("/tmp/codex-home", "skills"), "wrong user skills dir");
  assert(info.reloadInstruction.includes("Restart Codex"), "reload instruction should mention Codex");
});

check("scopeDir is runtime aware", () => {
  assert(scopeDir("/tmp/work", "project", "codex") === path.join("/tmp/work", ".codex", "skills"), "wrong codex project scope");
  assert(scopeDir("/tmp/work", "project", "claude") === path.join("/tmp/work", ".claude", "skills"), "wrong claude project scope");
});

check("projectSkillsDir and manifest order are runtime aware", () => {
  assert(projectSkillsDir("/tmp/work", "codex") === path.join("/tmp/work", ".codex", "skills"), "wrong codex project skills path");
  const manifests = pluginManifestPaths("/tmp/plugin", "codex");
  assert(manifests[0].endsWith(path.join(".codex-plugin", "plugin.json")), "codex manifest should be first");
  assert(manifests[1].endsWith(path.join(".claude-plugin", "plugin.json")), "claude manifest should be fallback");
});

check("Codex cron runner matches generated cron expressions", () => {
  const date = new Date(2026, 0, 5, 9, 30, 0);
  assert(cronMatchesDate("30 9 * * *", date), "daily cron should match");
  assert(cronMatchesDate("*/15 * * * *", date), "step cron should match");
  assert(cronMatchesDate("30 9 * * 1", date), "weekly cron should match Monday");
  assert(!cronMatchesDate("31 9 * * *", date), "wrong minute should not match");
});

check("Codex cron runner identifies due registry entries", () => {
  const now = new Date(2026, 0, 5, 9, 30, 0);
  const registry = {
    entries: [
      { key: "daily", cron: "30 9 * * *", prompt: "daily", recurring: true, paused: false, tombstone: null },
      { key: "paused", cron: "30 9 * * *", prompt: "paused", recurring: true, paused: true, tombstone: null },
      { key: "done", cron: "30 9 * * *", prompt: "done", recurring: true, paused: false, tombstone: null },
      { key: "oneshot", cron: "0 0 1 1 *", prompt: "one", recurring: false, targetEpoch: 1, paused: false, tombstone: null },
    ],
  };
  const state = { fired: { done: Math.floor(now.getTime() / 60000) } };
  const due = dueEntries(registry, state, now).map((e: { key: string }) => e.key);
  assert(due.includes("daily"), "daily entry should be due");
  assert(due.includes("oneshot"), "expired one-shot should be due once");
  assert(!due.includes("paused"), "paused entry should not be due");
  assert(!due.includes("done"), "already-fired minute should not be due");
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-runtime tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
