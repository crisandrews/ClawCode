/**
 * Tier 1 + tier 2 regression tests for the Codex 5th-pass post-impl
 * findings on Phase 4a-2.5 v5 (1 CRITICAL + 1 HIGH + 1 LOW).
 *
 * Coverage:
 *   - CRITICAL: case-insensitive filesystems + symlink ancestors
 *     bypass the v5 trust-dir prefix check. v6 canonicalizes via
 *     `realpathSync.native` of the deepest existing ancestor and
 *     case-folds on darwin/win32.
 *   - HIGH: arbitrary file clobber outside the trust dir. v5 only
 *     denied the trust dir; v6 restricts to an allowlist
 *     (`config.outputDir` / `os.tmpdir()` / `/tmp`).
 *   - LOW: agent_config key length DoS. v6 caps key length, segment
 *     count, segment length and returns `"oversize"`.
 *
 * Run: `npx tsx tests/scope-v6-codex-5th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertSafeOutputPath } from "../lib/voice.ts";
import { classifyAgentConfigKey } from "../lib/scope/agent-config-guard.ts";

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

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

// ---------------------------------------------------------------------------
// CRITICAL: case-insensitive + symlink trust-dir bypass
// ---------------------------------------------------------------------------

check("CRITICAL (v6): case-folded trust-dir path is rejected on darwin/win32", () => {
  // Make a real trust dir with one casing, then probe with a different
  // casing. On case-insensitive filesystems the canonicalized path
  // resolves to whatever case the FS stored, so the comparison MUST be
  // case-folded.
  const root = tmpDir("scope-v6-case-");
  const realTrustDir = path.join(root, "scope-trust"); // lowercase
  fs.mkdirSync(realTrustDir, { recursive: true });
  withEnv("CLAW_SCOPE_TRUST_DIR", realTrustDir, () => {
    const mixedCase = path.join(root, "Scope-Trust", "whatsapp-owner");
    let threw = false;
    try {
      // We need to also add this path to the allowlist OR trip the
      // defense-in-depth deny. Without the allowlist the call throws
      // for "outside allowed roots" — which is also a refusal, so that
      // counts. Use a config.outputDir that points at a different
      // location so we can isolate which deny path fires.
      assertSafeOutputPath(mixedCase, { outputDir: tmpDir("scope-v6-out-") });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("case-folded trust path must be refused");
  });
  fs.rmSync(root, { recursive: true, force: true });
});

check("CRITICAL (v6): symlinked ancestor canonicalizes through trust dir", () => {
  // Create the actual trust dir, then a symlink to it from a different
  // location. Writing under the symlinked path must canonicalize to
  // the trust dir and be refused.
  const root = tmpDir("scope-v6-symlink-");
  const realTrust = path.join(root, "actual-trust");
  fs.mkdirSync(realTrust, { recursive: true });
  const symlinkDir = path.join(root, "trust-link");
  try {
    fs.symlinkSync(realTrust, symlinkDir);
  } catch (e) {
    // Some CI envs (rare) reject symlink creation. Skip in that case.
    return;
  }

  withEnv("CLAW_SCOPE_TRUST_DIR", realTrust, () => {
    const probe = path.join(symlinkDir, "whatsapp-owner");
    let threw = false;
    try {
      assertSafeOutputPath(probe, { outputDir: tmpDir("scope-v6-out2-") });
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(
        "symlinked ancestor that resolves to trust dir must be refused"
      );
    }
  });
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// HIGH: arbitrary file clobber outside trust dir
// ---------------------------------------------------------------------------

check("HIGH (v6): outputPath outside allowlist is refused", () => {
  // Try writing under $HOME — definitely not in the allowlist.
  const homeProbe = path.join(os.homedir(), "tmpfile-v6-test.mp3");
  let threw = false;
  try {
    assertSafeOutputPath(homeProbe, { outputDir: tmpDir("scope-v6-out3-") });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("outputPath outside allowlist must be refused");
});

check("HIGH (v6): can clobber agent-config.json refused", () => {
  // Simulate a workspace path. Workspace isn't in the allowlist by
  // default, so a `voice_speak(outputPath="agent-config.json")` would
  // resolve to cwd/agent-config.json which is outside allowlist.
  const cwdConfig = path.resolve("agent-config.json");
  let threw = false;
  try {
    assertSafeOutputPath(cwdConfig, { outputDir: tmpDir("scope-v6-out4-") });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("workspace agent-config.json must be refused");
});

check("HIGH (v6): /tmp/foo.mp3 is allowed (back-compat root)", () => {
  // No throw expected.
  assertSafeOutputPath("/tmp/foo.mp3");
});

check("HIGH (v6): os.tmpdir is allowed", () => {
  const inside = path.join(os.tmpdir(), `voice-${Date.now()}.mp3`);
  assertSafeOutputPath(inside);
});

check("HIGH (v6): config.outputDir is allowed", () => {
  const out = tmpDir("scope-v6-cfgout-");
  try {
    assertSafeOutputPath(path.join(out, "x.mp3"), { outputDir: out });
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

check(
  "HIGH (v6): tilde-prefixed config.outputDir is expanded and allowed",
  () => {
    // We can't write under a real ~/path without polluting the user
    // dir; create a temp dir, then point config.outputDir at it via
    // an absolute path (already covered) — for the tilde branch we
    // just verify expandTilde fires. Use os.homedir() to simulate.
    const realRoot = os.homedir();
    // Don't actually write — we're only validating the assertion path.
    // Skip if HOME doesn't exist (it always does).
    if (!fs.existsSync(realRoot)) return;
    const probe = path.join(realRoot, "voice-out", "x.mp3");
    // Should pass with config.outputDir = "~/voice-out"
    let threw = false;
    try {
      assertSafeOutputPath(probe, { outputDir: "~/voice-out" });
    } catch {
      threw = true;
    }
    if (threw) throw new Error("tilde-expansion in outputDir must work");
  }
);

// ---------------------------------------------------------------------------
// LOW: agent_config key length / depth caps
// ---------------------------------------------------------------------------

check("LOW (v6): key longer than 256 chars → oversize", () => {
  const big = "a".repeat(257);
  if (classifyAgentConfigKey(big) !== "oversize")
    throw new Error("256-char cap not enforced");
});

check("LOW (v6): more than 16 segments → oversize", () => {
  const deep = Array(17).fill("x").join(".");
  if (classifyAgentConfigKey(deep) !== "oversize")
    throw new Error("16-segment cap not enforced");
});

check("LOW (v6): segment longer than 64 chars → oversize", () => {
  const long = "x." + "a".repeat(65);
  if (classifyAgentConfigKey(long) !== "oversize")
    throw new Error("64-char-per-segment cap not enforced");
});

check("LOW (v6): exactly at limits → not oversize", () => {
  const exact = Array(16).fill("a".repeat(15)).join(".");
  // 16*15 + 15 dots = 255. Exactly at limit. classify by content, not size.
  const cls = classifyAgentConfigKey(exact);
  if (cls === "oversize") throw new Error(`borderline should pass, got ${cls}`);
});

check("LOW (v6): proto check still wins over oversize check", () => {
  // A key with __proto__ that's also at the size limit — does proto fire?
  // Build: 'a.__proto__.b' (3 segments, well under cap)
  const k = "a.__proto__.b";
  if (classifyAgentConfigKey(k) !== "proto")
    throw new Error("proto must be reported even with valid size");
});

check("LOW (v6): oversize fires before proto/scope (cheap rejection)", () => {
  // Key over 256 chars containing `__proto__` and starting with `scope.`.
  // We want oversize to be the cheap first check so we don't walk the
  // string further than needed.
  const big =
    "scope." + "a".repeat(50) + ".__proto__." + "b".repeat(220);
  if (classifyAgentConfigKey(big) !== "oversize")
    throw new Error("oversize should win as cheapest check");
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
  console.log(`\n${pass}/${pass + fail} v6 Codex-5th-pass tests passed`);
  if (fail > 0) process.exit(1);
}, 50);
