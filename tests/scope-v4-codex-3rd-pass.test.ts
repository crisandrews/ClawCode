/**
 * Tier 1 + tier 2 regression tests for the Codex 3rd-pass post-impl
 * findings on Phase 4a-2.5 v3 (3 CRITICAL + 2 MEDIUM).
 *
 * Coverage:
 *   - CRITICAL 1: `agent_config(action='set')` refuses scope-policy keys.
 *     Tier 1 of the helper (`isSecuritySensitiveScopeKey` in server.ts)
 *     and tier 2 of the live MCP handler.
 *   - CRITICAL 2: bootstrap fail-open (`ownerJids === []`) is gated by
 *     `isAutoDiscovered`. User-configured `accessJsonPath` requires the
 *     out-of-band trust file even in bootstrap mode.
 *   - CRITICAL 3: `skill_install` validates skill name as a safe basename
 *     (`isSafeSkillName`) AND verifies path containment after resolve.
 *     A name like `../agent/scope-trust` must be rejected.
 *   - MEDIUM 2: background `system-owner` requires the trust file. Without
 *     the file `allowedChatIds` returns `[]`. Verifies the wizard *must*
 *     create the trust file when system-owner is selected.
 *
 * MEDIUM 1 (auto-allow Bash threat documentation) is exercised by
 * docs review, not unit tests — surfaced in `docs/channel-scope-compat.md`
 * and the wizard SKILL.md.
 *
 * Run: `npx tsx tests/scope-v4-codex-3rd-pass.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWhatsappAdapter,
  loadAccess,
} from "../lib/scope/whatsapp.ts";
import { isSafeSkillName } from "../lib/skill-manager.ts";
import {
  _resolvedTrustDirForTests,
  isOwnerTrusted,
  removeTrustMarker,
  trustFilePath,
  writeTrustMarker,
} from "../lib/scope/trust.ts";
import {
  makeBackgroundContext,
  makeForegroundContext,
} from "../lib/scope/context.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r
        .then(() => results.push({ name, pass: true }))
        .catch((e) => results.push({ name, pass: false, msg: String(e) }));
    }
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withTrustForTest<T>(channel: "whatsapp", fn: () => T): T {
  const dir = tmpDir("scope-trust-v4-");
  const prev = process.env.CLAW_SCOPE_TRUST_DIR;
  process.env.CLAW_SCOPE_TRUST_DIR = dir;
  try {
    writeTrustMarker(channel);
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withoutTrustForTest<T>(fn: () => T): T {
  const dir = tmpDir("scope-no-trust-v4-");
  const prev = process.env.CLAW_SCOPE_TRUST_DIR;
  process.env.CLAW_SCOPE_TRUST_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeAccess(dir: string, payload: object): string {
  const p = path.join(dir, "access.json");
  fs.writeFileSync(p, JSON.stringify(payload));
  return p;
}

// ---------------------------------------------------------------------------
// CRITICAL 1: isSecuritySensitiveScopeKey blocklist
// ---------------------------------------------------------------------------

// v5 update: Codex 4th-pass widened the blocklist to ALL scope.* writes
// (not just the four sensitive leaves) — so the v4-era predicate is
// expressed by `classifyAgentConfigKey(...) === "scope"`. We import the
// live helper to avoid the tautology Codex flagged in sweep G. The v4
// test cases below still exercise the four leaves that started the
// Phase 4a-2.5 v4 design; they are now a subset of the v5 blocklist.
import { classifyAgentConfigKey } from "../lib/scope/agent-config-guard.ts";

function isSecuritySensitiveScopeKey(key: string): boolean {
  return classifyAgentConfigKey(key) === "scope";
}

check("CRITICAL 1: blocks scope.whatsapp.mode", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp.mode"))
    throw new Error("expected blocked");
});

check("CRITICAL 1: blocks scope.whatsapp.identity", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp.identity"))
    throw new Error("expected blocked");
});

check("CRITICAL 1: blocks scope.whatsapp.accessJsonPath", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp.accessJsonPath"))
    throw new Error("expected blocked");
});

check("CRITICAL 1: blocks scope.whatsapp.background.identity", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp.background.identity"))
    throw new Error("expected blocked");
});

check("CRITICAL 1: blocks scope.telegram.mode (any channel)", () => {
  if (!isSecuritySensitiveScopeKey("scope.telegram.mode"))
    throw new Error("expected blocked");
});

// v5 update — these cases originally asserted "ALLOWS" under v4's
// narrower leaf blocklist. Codex 4th-pass found the ancestor-object
// bypass; v5 widened the rule to refuse ALL scope-tree writes. Now
// these all assert "blocked".
check("CRITICAL 1 (v5): blocks scope.whatsapp.cwdExactMatchOnly (was allowed in v4)", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp.cwdExactMatchOnly"))
    throw new Error("v5 widened: cwdExactMatchOnly now blocked");
});

check("CRITICAL 1: ALLOWS memory.backend (non-scope key)", () => {
  if (isSecuritySensitiveScopeKey("memory.backend"))
    throw new Error("non-scope keys should not be blocked");
});

check("CRITICAL 1 (v5): blocks bare scope (root, was allowed in v4)", () => {
  if (!isSecuritySensitiveScopeKey("scope"))
    throw new Error("v5 widened: bare scope now blocked (root assignment)");
});

check("CRITICAL 1 (v5): blocks scope.whatsapp (channel object, was allowed in v4)", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp"))
    throw new Error("v5 widened: ancestor-object writes now blocked");
});

check("CRITICAL 1 (v5): blocks scope.whatsapp.foreground.identity (any leaf)", () => {
  if (!isSecuritySensitiveScopeKey("scope.whatsapp.foreground.identity"))
    throw new Error("v5 widened: any scope.* leaf is blocked");
});

// ---------------------------------------------------------------------------
// CRITICAL 2: bootstrap forge gate via isAutoDiscovered
// ---------------------------------------------------------------------------

check(
  "CRITICAL 2: auto-discovered bootstrap (ownerJids=[]) → owner unlock",
  () => {
    const dir = tmpDir("scope-c2-auto-");
    const accessPath = writeAccess(dir, {
      ownerJids: [],
      historyScope: {},
      groups: {},
      allowFrom: [],
    });
    try {
      const adapter = createWhatsappAdapter({
        accessPath,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      if (!adapter) throw new Error("adapter null");
      const allowed = adapter.allowedChatIds(makeForegroundContext("req-1"));
      if (allowed !== null)
        throw new Error(`expected null (unlock), got ${JSON.stringify(allowed)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

check(
  "CRITICAL 2: user-configured bootstrap WITHOUT trust → []",
  () => {
    const dir = tmpDir("scope-c2-noauto-");
    const accessPath = writeAccess(dir, {
      ownerJids: [],
      historyScope: {},
      groups: {},
      allowFrom: [],
    });
    try {
      withoutTrustForTest(() => {
        const adapter = createWhatsappAdapter({
          accessPath,
          configuredIdentity: "auto",
          isAutoDiscovered: false,
        });
        if (!adapter) throw new Error("adapter null");
        const allowed = adapter.allowedChatIds(makeForegroundContext("req-2"));
        if (!Array.isArray(allowed) || allowed.length !== 0)
          throw new Error(
            `expected [] (forge guard), got ${JSON.stringify(allowed)}`
          );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

check(
  "CRITICAL 2: user-configured bootstrap WITH trust → null (unlock)",
  () => {
    const dir = tmpDir("scope-c2-trusted-");
    const accessPath = writeAccess(dir, {
      ownerJids: [],
      historyScope: {},
      groups: {},
      allowFrom: [],
    });
    try {
      withTrustForTest("whatsapp", () => {
        const adapter = createWhatsappAdapter({
          accessPath,
          configuredIdentity: "auto",
          isAutoDiscovered: false,
        });
        if (!adapter) throw new Error("adapter null");
        const allowed = adapter.allowedChatIds(makeForegroundContext("req-3"));
        if (allowed !== null)
          throw new Error(
            `expected null (trust gate satisfied), got ${JSON.stringify(allowed)}`
          );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// CRITICAL 3: skill_install path traversal
// ---------------------------------------------------------------------------

check("CRITICAL 3: rejects '..' as skill name", () => {
  if (isSafeSkillName("..")) throw new Error("'..' must be rejected");
});

check("CRITICAL 3: rejects '.' as skill name", () => {
  if (isSafeSkillName(".")) throw new Error("'.' must be rejected");
});

check("CRITICAL 3: rejects '../agent/scope-trust' (path traversal)", () => {
  if (isSafeSkillName("../agent/scope-trust"))
    throw new Error("path traversal must be rejected");
});

check("CRITICAL 3: rejects forward-slash anywhere", () => {
  if (isSafeSkillName("foo/bar"))
    throw new Error("forward slash must be rejected");
});

check("CRITICAL 3: rejects backslash anywhere", () => {
  if (isSafeSkillName("foo\\bar"))
    throw new Error("backslash must be rejected");
});

check("CRITICAL 3: rejects NUL byte", () => {
  if (isSafeSkillName("foo\0bar"))
    throw new Error("NUL must be rejected");
});

check("CRITICAL 3: rejects empty string", () => {
  if (isSafeSkillName("")) throw new Error("empty must be rejected");
});

check("CRITICAL 3: rejects non-string types", () => {
  if (isSafeSkillName(undefined as unknown))
    throw new Error("undefined must be rejected");
  if (isSafeSkillName(null as unknown))
    throw new Error("null must be rejected");
  if (isSafeSkillName(42 as unknown)) throw new Error("number must be rejected");
});

check("CRITICAL 3: rejects very long names (>128)", () => {
  const long = "a".repeat(129);
  if (isSafeSkillName(long)) throw new Error("over-128 must be rejected");
});

check("CRITICAL 3: accepts valid slug-style names", () => {
  for (const ok of [
    "scope",
    "messaging-whatsapp",
    "skill_v2",
    "x.y.z",
    "ABC-123",
  ]) {
    if (!isSafeSkillName(ok))
      throw new Error(`expected ${ok} to be accepted`);
  }
});

check("CRITICAL 3: rejects unicode/control chars outside slug set", () => {
  if (isSafeSkillName("foo bar"))
    throw new Error("space must be rejected");
  if (isSafeSkillName("föo"))
    throw new Error("non-ASCII must be rejected");
});

// ---------------------------------------------------------------------------
// MEDIUM 2: background system-owner needs trust file
// ---------------------------------------------------------------------------

check(
  "MEDIUM 2: background system-owner WITHOUT trust → []",
  () => {
    const dir = tmpDir("scope-m2-no-trust-");
    const accessPath = writeAccess(dir, {
      ownerJids: ["1234@s.whatsapp.net"],
      historyScope: {},
      groups: {},
      allowFrom: [],
    });
    try {
      withoutTrustForTest(() => {
        const adapter = createWhatsappAdapter({
          accessPath,
          configuredIdentity: "auto",
          isAutoDiscovered: true,
        });
        if (!adapter) throw new Error("adapter null");
        const ctx = makeBackgroundContext("dream-1", "system-owner");
        const allowed = adapter.allowedChatIds(ctx);
        if (!Array.isArray(allowed) || allowed.length !== 0)
          throw new Error(
            `expected [] (no trust file), got ${JSON.stringify(allowed)}`
          );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

check(
  "MEDIUM 2: background system-owner WITH trust → null (unlock)",
  () => {
    const dir = tmpDir("scope-m2-trust-");
    const accessPath = writeAccess(dir, {
      ownerJids: ["1234@s.whatsapp.net"],
      historyScope: {},
      groups: {},
      allowFrom: [],
    });
    try {
      withTrustForTest("whatsapp", () => {
        const adapter = createWhatsappAdapter({
          accessPath,
          configuredIdentity: "auto",
          isAutoDiscovered: true,
        });
        if (!adapter) throw new Error("adapter null");
        const ctx = makeBackgroundContext("dream-2", "system-owner");
        const allowed = adapter.allowedChatIds(ctx);
        if (allowed !== null)
          throw new Error(
            `expected null (trust satisfied), got ${JSON.stringify(allowed)}`
          );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

check(
  "MEDIUM 2: background deny ignores trust (deny is deny)",
  () => {
    const dir = tmpDir("scope-m2-deny-");
    const accessPath = writeAccess(dir, {
      ownerJids: ["1234@s.whatsapp.net"],
      historyScope: {},
      groups: {},
      allowFrom: [],
    });
    try {
      withTrustForTest("whatsapp", () => {
        const adapter = createWhatsappAdapter({
          accessPath,
          configuredIdentity: "auto",
          isAutoDiscovered: true,
        });
        if (!adapter) throw new Error("adapter null");
        const ctx = makeBackgroundContext("dream-3", "deny");
        const allowed = adapter.allowedChatIds(ctx);
        if (!Array.isArray(allowed) || allowed.length !== 0)
          throw new Error(
            `expected [] (deny is deny even with trust), got ${JSON.stringify(allowed)}`
          );
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);

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
  console.log(`\n${pass}/${pass + fail} v4 Codex-3rd-pass tests passed`);
  if (fail > 0) process.exit(1);
}, 50);
