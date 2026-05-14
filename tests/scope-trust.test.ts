/**
 * Tier 1 tests for the out-of-band trust primitive (Phase 4a-2.5 v3,
 * Codex 2nd-pass CRITICAL fix).
 *
 * The trust file at `~/.claude/agent/scope-trust/<channel>-owner` (or
 * the `CLAW_SCOPE_TRUST_DIR` override) is the proof that an owner
 * declaration in `config.scope.<channel>.identity = "owner"` was
 * intentional and not a prompt-injection escalation via
 * `agent_config`. This test file validates the helper itself and its
 * test-override seam.
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

function withTmpTrustDir(fn: (tmp: string) => void) {
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-test-"));
  process.env.CLAW_SCOPE_TRUST_DIR = tmp;
  try {
    fn(tmp);
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

check("trust dir override via CLAW_SCOPE_TRUST_DIR env", () => {
  withTmpTrustDir((tmp) => {
    assert(_resolvedTrustDirForTests() === tmp, "env override applies");
    assert(
      trustFilePath("whatsapp") === path.join(tmp, "whatsapp-owner"),
      "trustFilePath uses override"
    );
  });
});

check("isOwnerTrusted: false when no file present", () => {
  withTmpTrustDir(() => {
    assert(isOwnerTrusted("whatsapp") === false, "no file → false");
  });
});

check("isOwnerTrusted: true after writeTrustMarker", () => {
  withTmpTrustDir(() => {
    writeTrustMarker("whatsapp");
    assert(isOwnerTrusted("whatsapp") === true, "after touch → true");
  });
});

check("removeTrustMarker clears trust", () => {
  withTmpTrustDir(() => {
    writeTrustMarker("whatsapp");
    removeTrustMarker("whatsapp");
    assert(isOwnerTrusted("whatsapp") === false, "after remove → false");
  });
});

check("removeTrustMarker is idempotent", () => {
  withTmpTrustDir(() => {
    // No file exists yet; remove should not throw.
    removeTrustMarker("whatsapp");
    assert(isOwnerTrusted("whatsapp") === false, "still false");
  });
});

check("isOwnerTrusted: false for symlink (lstat path)", () => {
  if (process.platform === "win32") return; // symlinks vary on Windows
  withTmpTrustDir((tmp) => {
    // Make a real file elsewhere, then symlink the trust path to it.
    // lstat-based check should reject the symlink.
    const realFile = path.join(tmp, "real");
    fs.writeFileSync(realFile, "");
    const linkPath = trustFilePath("whatsapp");
    fs.symlinkSync(realFile, linkPath);
    assert(
      isOwnerTrusted("whatsapp") === false,
      "symlinked trust file rejected"
    );
  });
});

check("isOwnerTrusted: false for directory at trust path", () => {
  withTmpTrustDir(() => {
    // Place a directory where the trust file should be.
    fs.mkdirSync(trustFilePath("whatsapp"));
    assert(
      isOwnerTrusted("whatsapp") === false,
      "directory at trust path rejected"
    );
  });
});

check("trust per-channel isolation: whatsapp vs telegram", () => {
  withTmpTrustDir(() => {
    writeTrustMarker("whatsapp");
    assert(isOwnerTrusted("whatsapp") === true, "whatsapp trusted");
    assert(
      isOwnerTrusted("telegram") === false,
      "telegram not trusted (independent file)"
    );
  });
});

check("writeTrustMarker creates parent dir if missing", () => {
  withTmpTrustDir((tmp) => {
    // Trust dir is the override itself; writeTrustMarker creates
    // `dirname(trustFilePath)` which IS the override. But verify
    // mkdir recursive works under nested override too.
    const nested = path.join(tmp, "deeper", "still-deeper");
    process.env.CLAW_SCOPE_TRUST_DIR = nested;
    writeTrustMarker("whatsapp");
    assert(
      fs.existsSync(path.join(nested, "whatsapp-owner")),
      "trust file created in nested override"
    );
  });
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-trust tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
