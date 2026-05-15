/**
 * Tier 1 tests for the out-of-band trust primitive (workspace-bound).
 *
 * Phase 8 / 1.7.0: trust file lives at
 *   `<CLAW_SCOPE_TRUST_DIR>/<workspace-fingerprint>/<channel>-<suffix>`
 * (was: `<CLAW_SCOPE_TRUST_DIR>/<channel>-<suffix>` flat in 1.5/1.6).
 *
 * The trust file is the proof that an owner declaration in
 * `config.scope.<channel>.identity = "owner"` (or the execGate analog)
 * was intentional and not a prompt-injection escalation via `agent_config`.
 *
 * Run: `npx tsx tests/scope-trust.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isOwnerTrusted,
  removeTrustMarker,
  trustFilePath,
  writeTrustMarker,
  workspaceFingerprint,
  _resolvedTrustDirBaseForTests,
  _resolvedTrustDirForTests,
} from "../lib/scope/trust.ts";

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

function withTmpTrustDir(fn: (base: string, workspace: string) => void) {
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-test-"));
  // Use a stable workspace path for the duration of the test.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-ws-"));
  process.env.CLAW_SCOPE_TRUST_DIR = base;
  try {
    fn(base, workspace);
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

check("trust dir base override via CLAW_SCOPE_TRUST_DIR env", () => {
  withTmpTrustDir((base, workspace) => {
    assert(
      _resolvedTrustDirBaseForTests() === base,
      "env override applies to BASE"
    );
    const fp = workspaceFingerprint(workspace);
    assert(
      _resolvedTrustDirForTests(workspace) === path.join(base, fp),
      "trust dir nests under fingerprint subdir"
    );
    assert(
      trustFilePath(workspace, "whatsapp") === path.join(base, fp, "whatsapp-owner"),
      "trustFilePath uses workspace fingerprint + override"
    );
  });
});

check("isOwnerTrusted: false when no file present", () => {
  withTmpTrustDir((_base, workspace) => {
    assert(
      isOwnerTrusted(workspace, "whatsapp") === false,
      "no file → false"
    );
  });
});

check("isOwnerTrusted: true after writeTrustMarker", () => {
  withTmpTrustDir((_base, workspace) => {
    writeTrustMarker(workspace, "whatsapp");
    assert(
      isOwnerTrusted(workspace, "whatsapp") === true,
      "after touch → true"
    );
  });
});

check("removeTrustMarker clears trust", () => {
  withTmpTrustDir((_base, workspace) => {
    writeTrustMarker(workspace, "whatsapp");
    removeTrustMarker(workspace, "whatsapp");
    assert(
      isOwnerTrusted(workspace, "whatsapp") === false,
      "after remove → false"
    );
  });
});

check("removeTrustMarker is idempotent", () => {
  withTmpTrustDir((_base, workspace) => {
    removeTrustMarker(workspace, "whatsapp");
    assert(
      isOwnerTrusted(workspace, "whatsapp") === false,
      "still false"
    );
  });
});

check("isOwnerTrusted: false for symlink (lstat path)", () => {
  if (process.platform === "win32") return;
  withTmpTrustDir((base, workspace) => {
    // Make a real file at the base, then symlink the trust path to it.
    // lstat-based check should reject the symlink.
    const realFile = path.join(base, "real");
    fs.writeFileSync(realFile, "");
    fs.chmodSync(realFile, 0o600);
    // Ensure the fingerprint subdir exists before planting the symlink.
    const dir = _resolvedTrustDirForTests(workspace);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const linkPath = trustFilePath(workspace, "whatsapp");
    fs.symlinkSync(realFile, linkPath);
    assert(
      isOwnerTrusted(workspace, "whatsapp") === false,
      "symlinked trust file rejected"
    );
  });
});

check("isOwnerTrusted: false for directory at trust path", () => {
  withTmpTrustDir((_base, workspace) => {
    // Place a directory where the trust file should be.
    const dir = _resolvedTrustDirForTests(workspace);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.mkdirSync(trustFilePath(workspace, "whatsapp"));
    assert(
      isOwnerTrusted(workspace, "whatsapp") === false,
      "directory at trust path rejected"
    );
  });
});

check("trust per-channel isolation: whatsapp vs telegram", () => {
  withTmpTrustDir((_base, workspace) => {
    writeTrustMarker(workspace, "whatsapp");
    assert(
      isOwnerTrusted(workspace, "whatsapp") === true,
      "whatsapp trusted"
    );
    assert(
      isOwnerTrusted(workspace, "telegram") === false,
      "telegram not trusted (independent file)"
    );
  });
});

check("writeTrustMarker creates parent dir if missing", () => {
  withTmpTrustDir((base, workspace) => {
    // Nest the override deeper than expected; writeTrustMarker must
    // create the fingerprint subdir too.
    const nestedBase = path.join(base, "deeper", "still-deeper");
    process.env.CLAW_SCOPE_TRUST_DIR = nestedBase;
    writeTrustMarker(workspace, "whatsapp");
    const fp = workspaceFingerprint(workspace);
    assert(
      fs.existsSync(path.join(nestedBase, fp, "whatsapp-owner")),
      "trust file created in nested override + fingerprint subdir"
    );
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
for (const r of results) {
  if (!r.pass) console.error(`  FAIL ${r.name}: ${r.msg}`);
}
console.log(`scope-trust tier1: ${passed}/${results.length} passed`);
if (failed > 0) process.exit(1);
