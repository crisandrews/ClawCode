/**
 * Tier 2 tests for the SessionStart hook `hooks/scope-trust-legacy-warn.sh`.
 *
 * The hook surfaces a one-line stderr advisory when 1.6-era flat-layout
 * trust files exist in `~/.claude/agent/scope-trust/` (overridden via
 * `CLAW_SCOPE_TRUST_DIR` for testing). MUST be silent + exit-0 in all
 * other states.
 *
 * Run: `npx tsx tests/scope-trust-legacy-hook.test.ts`
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceFingerprint } from "../lib/scope/trust.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const HOOK_PATH = path.join(REPO_ROOT, "hooks/scope-trust-legacy-warn.sh");

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

interface HookRun {
  trustDir: string;
  workspaceRoot: string;
  cleanup: () => void;
}

function mkHookEnv(): HookRun {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-trust-hook-"));
  const trustDir = path.join(root, "trust");
  const workspaceRoot = path.join(root, "ws");
  fs.mkdirSync(trustDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return {
    trustDir,
    workspaceRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function runHook(env: HookRun, overrides: Record<string, string> = {}) {
  return spawnSync("bash", [HOOK_PATH], {
    env: {
      ...process.env,
      CLAW_SCOPE_TRUST_DIR: env.trustDir,
      CLAUDE_PROJECT_DIR: env.workspaceRoot,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      ...overrides,
    },
    encoding: "utf-8",
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Silent paths
// ---------------------------------------------------------------------------

check("hook: trust dir absent → exit 0, silent", () => {
  const env = mkHookEnv();
  try {
    // Remove the trust dir we just created.
    fs.rmSync(env.trustDir, { recursive: true, force: true });
    const r = runHook(env);
    assert(r.status === 0, `expected exit 0, got ${r.status} stderr=${r.stderr}`);
    assert(r.stderr === "", `expected silent stderr, got "${r.stderr}"`);
  } finally {
    env.cleanup();
  }
});

check("hook: empty trust dir → exit 0, silent", () => {
  const env = mkHookEnv();
  try {
    const r = runHook(env);
    assert(r.status === 0, `exit 0; got ${r.status} stderr=${r.stderr}`);
    assert(r.stderr === "", `silent; got "${r.stderr}"`);
  } finally {
    env.cleanup();
  }
});

check("hook: only 1.7+ fingerprint subdir → silent (subdirs are not legacy)", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    const fp = workspaceFingerprint(env.workspaceRoot);
    const wsTrust = path.join(env.trustDir, fp);
    fs.mkdirSync(wsTrust, { recursive: true, mode: 0o700 });
    fs.chmodSync(wsTrust, 0o700);
    const marker = path.join(wsTrust, "whatsapp-owner");
    fs.writeFileSync(marker, "", { mode: 0o600 });
    fs.chmodSync(marker, 0o600);
    const r = runHook(env);
    assert(r.status === 0 && r.stderr === "", `silent; got stderr="${r.stderr}"`);
  } finally {
    env.cleanup();
  }
});

check("hook: stale 0o644 legacy file → silent (Codex post-impl LOW #1 — matches doctor predicate)", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    const stale = path.join(env.trustDir, "whatsapp-owner");
    fs.writeFileSync(stale, "", { mode: 0o644 });
    fs.chmodSync(stale, 0o644);
    // Codex post-impl review noted that the hook should mirror the doctor's
    // `legacyGlobalTrustExists` predicate so stale 0o644 leftovers don't
    // produce noise that doctor would correctly suppress. The hook now does
    // the mode check inline (stat -L compatible across BSD + GNU).
    const r = runHook(env);
    assert(r.status === 0, `exit 0 always; got ${r.status}`);
    assert(
      r.stderr === "",
      `0o644 wouldn't unlock under 1.6 — hook should match doctor and stay silent. got "${r.stderr}"`
    );
  } finally {
    env.cleanup();
  }
});

check("hook: symlinked legacy file → silent (Codex post-impl LOW #1)", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    // Real file outside trust dir with valid perms; symlink to it inside.
    const real = path.join(os.tmpdir(), `real-trust-${Date.now()}`);
    fs.writeFileSync(real, "", { mode: 0o600 });
    fs.chmodSync(real, 0o600);
    const link = path.join(env.trustDir, "whatsapp-owner");
    fs.symlinkSync(real, link);
    const r = runHook(env);
    assert(r.stderr === "", `symlink rejected — hook silent. got "${r.stderr}"`);
    fs.unlinkSync(real);
  } finally {
    env.cleanup();
  }
});

check("hook: dismissal command in warning includes mkdir + chmod (Codex post-impl LOW #2)", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    const legacy = path.join(env.trustDir, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    const r = runHook(env);
    assert(/mkdir -p/.test(r.stderr), `dismiss cmd includes mkdir; got "${r.stderr}"`);
    assert(/chmod 700/.test(r.stderr), `dismiss cmd includes chmod 700 parent`);
    assert(/touch /.test(r.stderr), `dismiss cmd includes touch`);
    assert(/chmod 600/.test(r.stderr), `dismiss cmd includes chmod 600 marker`);
  } finally {
    env.cleanup();
  }
});

check("hook: missing CLAUDE_PLUGIN_ROOT → silent (fail-soft)", () => {
  const env = mkHookEnv();
  try {
    const legacy = path.join(env.trustDir, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    const r = runHook(env, { CLAUDE_PLUGIN_ROOT: "" });
    assert(r.status === 0, `fail-soft exit 0; got ${r.status}`);
    assert(r.stderr === "", `silent on misconfig; got "${r.stderr}"`);
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Active warn paths
// ---------------------------------------------------------------------------

check("hook: legacy 1.6 whatsapp-owner present → one-line stderr warn", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    const legacy = path.join(env.trustDir, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    const r = runHook(env);
    assert(r.status === 0, `exit 0; got ${r.status}`);
    const lines = r.stderr.trim().split("\n");
    assert(lines.length === 1, `expected ONE line; got ${lines.length}: ${JSON.stringify(lines)}`);
    assert(/whatsapp-owner/.test(lines[0]), `mentions the file; got "${lines[0]}"`);
    assert(/scope wizard/.test(lines[0]), `nudges wizard; got "${lines[0]}"`);
  } finally {
    env.cleanup();
  }
});

check("hook: multiple legacy files → all listed in single line", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    for (const name of ["whatsapp-owner", "whatsapp-exec", "telegram-owner"]) {
      const p = path.join(env.trustDir, name);
      fs.writeFileSync(p, "", { mode: 0o600 });
      fs.chmodSync(p, 0o600);
    }
    const r = runHook(env);
    const lines = r.stderr.trim().split("\n");
    assert(lines.length === 1, `still ONE line for N files; got ${lines.length}`);
    for (const expected of ["whatsapp-owner", "whatsapp-exec", "telegram-owner"]) {
      assert(lines[0].includes(expected), `lists ${expected}; got "${lines[0]}"`);
    }
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Workspace-scoped dismissal
// ---------------------------------------------------------------------------

check("hook: workspace-scoped dismissal silences advisory for that workspace only", () => {
  if (process.platform === "win32") return;
  const env = mkHookEnv();
  try {
    const legacy = path.join(env.trustDir, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    // Plant the dismissal marker for THIS workspace.
    const fp = workspaceFingerprint(env.workspaceRoot);
    const wsDir = path.join(env.trustDir, fp);
    fs.mkdirSync(wsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(wsDir, 0o700);
    const dismiss = path.join(wsDir, ".scope-trust-legacy-dismissed");
    fs.writeFileSync(dismiss, "", { mode: 0o600 });
    fs.chmodSync(dismiss, 0o600);
    const r = runHook(env);
    assert(r.status === 0 && r.stderr === "", `dismissed for this workspace; got "${r.stderr}"`);
    // Now switch to a different workspace — dismissal should NOT carry over.
    const otherWs = fs.mkdtempSync(path.join(os.tmpdir(), "other-ws-"));
    try {
      const r2 = spawnSync("bash", [HOOK_PATH], {
        env: {
          ...process.env,
          CLAW_SCOPE_TRUST_DIR: env.trustDir,
          CLAUDE_PROJECT_DIR: otherWs,
          CLAUDE_PLUGIN_ROOT: REPO_ROOT,
        },
        encoding: "utf-8",
        timeout: 15_000,
      });
      assert(
        r2.stderr.includes("Legacy 1.6 scope-trust file(s) detected"),
        `other workspace still warns; got "${r2.stderr}"`
      );
    } finally {
      fs.rmSync(otherWs, { recursive: true, force: true });
    }
  } finally {
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
for (const r of results) {
  if (!r.pass) console.error(`  FAIL ${r.name}: ${r.msg}`);
}
console.log(`scope-trust-legacy-hook tier2: ${passed}/${results.length} passed`);
if (failed > 0) process.exit(1);
