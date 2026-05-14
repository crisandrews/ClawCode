/**
 * Tier 1 + tier 2 regression tests for the Codex 4th-pass post-impl
 * findings on Phase 4a-2.5 v4 (2 CRITICAL + 2 HIGH).
 *
 * Coverage:
 *   - CRITICAL 1: `agent_config(action='set')` refuses ALL scope-tree
 *     writes (not just sensitive leaves). v4 allowed ancestor-object
 *     writes (`key='scope', value='{...}'`); v5 closes that surface.
 *     Also blocks prototype-pollution segments anywhere in the key.
 *   - CRITICAL 2: `voice_speak.outputPath` cannot resolve under the
 *     scope-trust directory. v4's voice_speak handler passed any path
 *     to the TTS backend, letting an agent create the trust file via
 *     audio bytes. v5 adds an `assertSafeOutputPath` gate.
 *   - HIGH 1: `skill_remove` validates skill name with `isSafeSkillName`
 *     and runs the same containment check as `install`. v4 only
 *     validated `install`, so `skill_remove(name="../agent-config.json")`
 *     could `rmSync` arbitrary workspace paths.
 *
 * Run: `npx tsx tests/scope-v5-codex-4th-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isSafeSkillName,
  remove as skillRemove,
} from "../lib/skill-manager.ts";
import {
  assertSafeOutputPath,
} from "../lib/voice.ts";
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

// ---------------------------------------------------------------------------
// CRITICAL 1: classifyAgentConfigKey is imported live from
// lib/scope/agent-config-guard.ts so the tests pin the same
// implementation server.ts uses (closes Codex 4th-pass sweep G).
// ---------------------------------------------------------------------------

check("CRITICAL 1: blocks bare `scope` (root assignment)", () => {
  if (classifyAgentConfigKey("scope") !== "scope")
    throw new Error("scope must be blocked");
});

check("CRITICAL 1: blocks `scope.whatsapp` (channel object)", () => {
  if (classifyAgentConfigKey("scope.whatsapp") !== "scope")
    throw new Error("scope.whatsapp must be blocked");
});

check("CRITICAL 1: blocks `scope.whatsapp.cwdExactMatchOnly` (any leaf)", () => {
  // v5 takes the conservative stance: ALL scope writes go through Bash,
  // including non-policy keys. The wizard consolidates the cwdExactMatchOnly
  // write into the same Bash call.
  if (classifyAgentConfigKey("scope.whatsapp.cwdExactMatchOnly") !== "scope")
    throw new Error("any scope.* must be blocked");
});

check("CRITICAL 1: blocks `scope.telegram` (any channel)", () => {
  if (classifyAgentConfigKey("scope.telegram") !== "scope")
    throw new Error("any channel scope must be blocked");
});

check("CRITICAL 1: blocks `scope.whatsapp.background.identity` (deep leaf)", () => {
  if (
    classifyAgentConfigKey("scope.whatsapp.background.identity") !== "scope"
  )
    throw new Error("background.identity still blocked");
});

check("CRITICAL 1: ALLOWS `memory.backend` (non-scope key)", () => {
  if (classifyAgentConfigKey("memory.backend") !== false)
    throw new Error("non-scope keys must pass");
});

check("CRITICAL 1: ALLOWS `voice.defaultBackend` (non-scope key)", () => {
  if (classifyAgentConfigKey("voice.defaultBackend") !== false)
    throw new Error("non-scope keys must pass");
});

// HIGH (prototype pollution)

check("HIGH (proto): blocks `__proto__` as first segment", () => {
  if (classifyAgentConfigKey("__proto__") !== "proto")
    throw new Error("__proto__ must be blocked");
});

check("HIGH (proto): blocks `__proto__` deep in path", () => {
  if (classifyAgentConfigKey("memory.__proto__.polluted") !== "proto")
    throw new Error("__proto__ must be blocked at any depth");
});

check("HIGH (proto): blocks `constructor`", () => {
  if (classifyAgentConfigKey("a.constructor.b") !== "proto")
    throw new Error("constructor must be blocked");
});

check("HIGH (proto): blocks `prototype`", () => {
  if (classifyAgentConfigKey("a.prototype") !== "proto")
    throw new Error("prototype must be blocked");
});

check("HIGH (proto): proto check beats scope check (consistent)", () => {
  // `scope.__proto__` → both blocked, but proto fires first.
  if (classifyAgentConfigKey("scope.__proto__") !== "proto")
    throw new Error("proto wins over scope");
});

// ---------------------------------------------------------------------------
// CRITICAL 2: voice_speak outputPath containment
// ---------------------------------------------------------------------------

function withTrustDir<T>(fn: (trustDir: string) => T): T {
  const dir = tmpDir("scope-v5-trust-");
  const prev = process.env.CLAW_SCOPE_TRUST_DIR;
  process.env.CLAW_SCOPE_TRUST_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check("CRITICAL 2: refuses outputPath inside trust dir", () => {
  withTrustDir((trustDir) => {
    let threw = false;
    try {
      assertSafeOutputPath(path.join(trustDir, "whatsapp-owner"));
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("trust-dir path must throw");
  });
});

check("CRITICAL 2: refuses outputPath equal to trust dir", () => {
  withTrustDir((trustDir) => {
    let threw = false;
    try {
      assertSafeOutputPath(trustDir);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("trust-dir itself must throw");
  });
});

check("CRITICAL 2: refuses tilde-expanded trust dir attack", () => {
  // The default trust dir without env override is ~/.claude/agent/scope-trust.
  // An agent passing the literal tilde path should still be caught.
  // We exercise the tilde expansion path without writing to a real
  // ~/.claude/.../whatsapp-owner — the assert just needs to compute the
  // resolved path and compare.
  const prev = process.env.CLAW_SCOPE_TRUST_DIR;
  delete process.env.CLAW_SCOPE_TRUST_DIR;
  try {
    let threw = false;
    try {
      assertSafeOutputPath("~/.claude/agent/scope-trust/whatsapp-owner");
    } catch {
      threw = true;
    }
    if (!threw) throw new Error("tilde-prefixed trust path must throw");
  } finally {
    if (prev !== undefined) process.env.CLAW_SCOPE_TRUST_DIR = prev;
  }
});

check("CRITICAL 2: ALLOWS arbitrary safe paths (e.g. /tmp/foo.mp3)", () => {
  withTrustDir(() => {
    const tmp = tmpDir("scope-v5-out-");
    try {
      // No throw expected.
      assertSafeOutputPath(path.join(tmp, "x.mp3"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

check(
  "CRITICAL 2: ALLOWS sibling of trust dir (not inside)",
  () => {
    withTrustDir((trustDir) => {
      const sibling = path.join(path.dirname(trustDir), "not-trust", "x.mp3");
      // No throw — the sibling path doesn't start with trustDir + sep.
      assertSafeOutputPath(sibling);
    });
  }
);

check(
  "CRITICAL 2: refuses path that resolves into trust dir via ../",
  () => {
    withTrustDir((trustDir) => {
      const escapeAttempt = path.join(
        trustDir,
        "..",
        path.basename(trustDir),
        "whatsapp-owner"
      );
      let threw = false;
      try {
        assertSafeOutputPath(escapeAttempt);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("../ traversal must resolve and throw");
    });
  }
);

// ---------------------------------------------------------------------------
// HIGH 1: skill_remove containment
// ---------------------------------------------------------------------------

function makeSkillsWorkspace(): string {
  const ws = tmpDir("scope-v5-skills-");
  fs.mkdirSync(path.join(ws, "skills", "ok-skill"), { recursive: true });
  fs.writeFileSync(path.join(ws, "skills", "ok-skill", "SKILL.md"), "ok");
  // Also create a sentinel file outside the skills dir to prove the
  // remove path can't reach it.
  fs.writeFileSync(path.join(ws, "agent-config.json"), "{}");
  return ws;
}

check("HIGH 1: skill_remove rejects '..' name", () => {
  const ws = makeSkillsWorkspace();
  try {
    const r = skillRemove(ws, "..", { confirm: true });
    if (r.ok) throw new Error("'..' must be rejected");
    if (!r.reason || !r.reason.includes("Invalid skill name"))
      throw new Error(`expected validation error, got: ${r.reason}`);
    // Sentinel file should still exist
    if (!fs.existsSync(path.join(ws, "agent-config.json")))
      throw new Error("sentinel destroyed");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("HIGH 1: skill_remove rejects '../agent-config.json'", () => {
  const ws = makeSkillsWorkspace();
  try {
    const r = skillRemove(ws, "../agent-config.json", { confirm: true });
    if (r.ok) throw new Error("path traversal must be rejected");
    if (!fs.existsSync(path.join(ws, "agent-config.json")))
      throw new Error("agent-config.json destroyed by traversal");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check(
  "HIGH 1: skill_remove rejects '../agent/scope-trust/whatsapp-owner'",
  () => {
    const ws = makeSkillsWorkspace();
    try {
      const r = skillRemove(
        ws,
        "../agent/scope-trust/whatsapp-owner",
        { confirm: true }
      );
      if (r.ok) throw new Error("trust-marker traversal must be rejected");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
);

check("HIGH 1: skill_remove rejects forward-slash anywhere", () => {
  const ws = makeSkillsWorkspace();
  try {
    const r = skillRemove(ws, "foo/bar", { confirm: true });
    if (r.ok) throw new Error("slash must be rejected");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("HIGH 1: skill_remove rejects NUL", () => {
  const ws = makeSkillsWorkspace();
  try {
    const r = skillRemove(ws, "foo\0bar", { confirm: true });
    if (r.ok) throw new Error("NUL must be rejected");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("HIGH 1: skill_remove ALLOWS valid slug name", () => {
  const ws = makeSkillsWorkspace();
  try {
    const r = skillRemove(ws, "ok-skill", { confirm: true });
    if (!r.ok) throw new Error(`valid name should remove: ${r.reason}`);
    if (fs.existsSync(path.join(ws, "skills", "ok-skill")))
      throw new Error("expected skill dir removed");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
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
  console.log(`\n${pass}/${pass + fail} v5 Codex-4th-pass tests passed`);
  if (fail > 0) process.exit(1);
}, 50);
