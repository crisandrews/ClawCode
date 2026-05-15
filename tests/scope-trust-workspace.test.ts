/**
 * Tier 1 + tier 2 tests for the Phase 8 workspace-bound trust primitive.
 *
 * Covers:
 *   - fingerprint determinism (same workspace → same hex across calls)
 *   - realpath canonicalization (/tmp/foo vs /private/tmp/foo on macOS → same hash)
 *   - case-fold on darwin/win32 (~/Project vs ~/project → same hash)
 *   - cross-workspace isolation (workspace A trust does NOT unlock workspace B)
 *   - legacyGlobalTrustExists detects pre-1.7.0 flat-layout markers
 *   - wizard <-> TS hash parity via scripts/print-workspace-fingerprint.mjs
 *   - parent fingerprint subdir is 0o700 after writeTrustMarker
 *   - 0o755-parent rejected (defense in depth — Codex round-2 Vector 4)
 *   - nonexistent-tail edge case (canonicalize fallback)
 *   - hard-cutover semantics: legacy global file alone returns false
 *   - removeTrustMarker isolation across workspaces
 *   - doctor's checkScopeOwnerAssertion does NOT count legacy global file
 *
 * Run: `npx tsx tests/scope-trust-workspace.test.ts`
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isOwnerTrusted,
  legacyGlobalTrustExists,
  removeTrustMarker,
  trustFilePath,
  workspaceFingerprint,
  writeTrustMarker,
  _resolvedTrustDirBaseForTests,
  _resolvedTrustDirForTests,
} from "../lib/scope/trust.ts";
import { createWhatsappAdapter } from "../lib/scope/whatsapp.ts";
import {
  _resetLegacyTrustWarnedForTests,
  _legacyTrustWarnedSizeForTests,
  warnLegacyTrustMigrationOnce,
} from "../lib/scope/legacy-warn.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import {
  checkScopeOwnerAssertion,
  checkScopeTrustLegacy,
} from "../lib/doctor.ts";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const BRIDGE_SCRIPT = path.join(REPO_ROOT, "scripts/print-workspace-fingerprint.mjs");
const PLUGIN_LOCAL_TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

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

function withEnvTrustDir(fn: (base: string) => void) {
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-ws-"));
  process.env.CLAW_SCOPE_TRUST_DIR = base;
  try {
    fn(base);
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Fingerprint determinism
// ---------------------------------------------------------------------------

check("fingerprint determinism: same workspace → same hex repeatedly", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-det-"));
  try {
    const a = workspaceFingerprint(ws);
    const b = workspaceFingerprint(ws);
    const c = workspaceFingerprint(ws);
    assert(a === b && b === c, "deterministic");
    assert(/^[0-9a-f]{32}$/.test(a), `32-hex, got ${a}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Realpath canonicalization (/tmp ↔ /private/tmp on macOS)
// ---------------------------------------------------------------------------

check("realpath canonicalization: symlinked path matches its target", () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-real-"));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-linkroot-"));
  const linkDir = path.join(linkRoot, "alias");
  try {
    fs.symlinkSync(realDir, linkDir);
    const a = workspaceFingerprint(realDir);
    const b = workspaceFingerprint(linkDir);
    assert(a === b, `symlink and target should hash identically; ${a} != ${b}`);
  } finally {
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Case-fold on darwin/win32
// ---------------------------------------------------------------------------

check("case-fold on darwin/win32: Project vs project hash identically", () => {
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  // Build a path that lives on the case-insensitive filesystem then access it
  // via two different casings. On APFS both casings resolve to the same inode.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ws-case-"));
  const upper = path.join(parent, "Project");
  fs.mkdirSync(upper);
  const lower = path.join(parent, "project");
  try {
    const a = workspaceFingerprint(upper);
    const b = workspaceFingerprint(lower);
    assert(
      a === b,
      `case-insensitive fs should hash identically; ${a} != ${b}`
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Cross-workspace isolation
// ---------------------------------------------------------------------------

check("cross-workspace isolation: A trust does NOT unlock B", () => {
  withEnvTrustDir(() => {
    const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-a-"));
    const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-b-"));
    try {
      writeTrustMarker(wsA, "whatsapp");
      assert(isOwnerTrusted(wsA, "whatsapp") === true, "A unlocked");
      assert(isOwnerTrusted(wsB, "whatsapp") === false, "B isolated");
    } finally {
      fs.rmSync(wsA, { recursive: true, force: true });
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. legacyGlobalTrustExists detection (pre-1.7.0 flat layout)
// ---------------------------------------------------------------------------

check("legacyGlobalTrustExists: flat-layout legacy file detected", () => {
  withEnvTrustDir((base) => {
    if (process.platform === "win32") return;
    const legacy = path.join(base, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    assert(legacyGlobalTrustExists("whatsapp") === true, "legacy detected");
    assert(
      legacyGlobalTrustExists("telegram") === false,
      "per-channel — telegram absent"
    );
  });
});

check("legacyGlobalTrustExists: stale 0o644 file rejected (no noise)", () => {
  withEnvTrustDir((base) => {
    if (process.platform === "win32") return;
    const legacy = path.join(base, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o644 });
    fs.chmodSync(legacy, 0o644);
    assert(
      legacyGlobalTrustExists("whatsapp") === false,
      "0o644 wouldn't have unlocked under 1.6 — diagnostic shouldn't fire"
    );
  });
});

check("legacyGlobalTrustExists: symlinked file rejected", () => {
  withEnvTrustDir((base) => {
    if (process.platform === "win32") return;
    const realFile = path.join(base, "real");
    fs.writeFileSync(realFile, "", { mode: 0o600 });
    fs.chmodSync(realFile, 0o600);
    const link = path.join(base, "whatsapp-owner");
    fs.symlinkSync(realFile, link);
    assert(
      legacyGlobalTrustExists("whatsapp") === false,
      "symlink wouldn't have unlocked"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Wizard <-> TS hash parity via bridge script
// ---------------------------------------------------------------------------

check("wizard fingerprint parity: bridge script matches TS helper", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-bridge-"));
  try {
    const expected = workspaceFingerprint(ws);
    // Codex Phase 8 round-1 HIGH #2: invoke the PLUGIN-LOCAL tsx binary
    // (not `npx tsx`) so the wizard works from any user workspace cwd
    // without depending on registry availability. cwd is OS tmp — proves
    // the wizard isn't tied to running from the plugin install dir.
    const r = spawnSync(PLUGIN_LOCAL_TSX, [BRIDGE_SCRIPT, ws], {
      encoding: "utf8",
      cwd: os.tmpdir(),
    });
    assert(r.status === 0, `bridge exit ${r.status} stderr=${r.stderr}`);
    const got = r.stdout.trim();
    assert(got === expected, `bridge=${got} != ts=${expected}`);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("wizard fingerprint parity: uppercase path (darwin case-fold guard)", () => {
  // Specifically regression-targets the Codex round-1 HIGH #3 case:
  // inline Bash crypto without case-fold would diverge from TS on macOS
  // for uppercase paths. We test via the bridge instead — both sides use
  // the SAME TS helper.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ws-upper-"));
  const ws = path.join(parent, "MyProject");
  fs.mkdirSync(ws);
  try {
    const expected = workspaceFingerprint(ws);
    const r = spawnSync(PLUGIN_LOCAL_TSX, [BRIDGE_SCRIPT, ws], {
      encoding: "utf8",
      cwd: os.tmpdir(),
    });
    assert(r.status === 0, `bridge exit ${r.status} stderr=${r.stderr}`);
    assert(r.stdout.trim() === expected, "uppercase bridge matches TS");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

check("wizard fingerprint parity: invokes from non-repo cwd (recovery path)", () => {
  // Codex Phase 8 round-1 HIGH #2 regression: confirm the plugin-local
  // binary works when the user's cwd is the workspace itself, NOT the
  // plugin install dir. This is the path the wizard actually takes.
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-recovery-"));
  try {
    const expected = workspaceFingerprint(ws);
    const r = spawnSync(PLUGIN_LOCAL_TSX, [BRIDGE_SCRIPT, ws], {
      encoding: "utf8",
      cwd: ws, // mimic wizard: spawn from the user's workspace
    });
    assert(r.status === 0, `bridge exit ${r.status} stderr=${r.stderr}`);
    assert(r.stdout.trim() === expected, "recovery-path bridge matches TS");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7-8. Parent fingerprint subdir mode
// ---------------------------------------------------------------------------

check("parent dir mode: writeTrustMarker chmods fingerprint subdir to 0o700", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir(() => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-mode-"));
    try {
      writeTrustMarker(ws, "whatsapp");
      const fpDir = _resolvedTrustDirForTests(ws);
      const dirStat = fs.lstatSync(fpDir);
      assert(
        (dirStat.mode & 0o777) === 0o700,
        `parent dir should be 0o700, got 0o${(dirStat.mode & 0o777).toString(8)}`
      );
      const fileStat = fs.lstatSync(trustFilePath(ws, "whatsapp"));
      assert(
        (fileStat.mode & 0o777) === 0o600,
        `marker should be 0o600, got 0o${(fileStat.mode & 0o777).toString(8)}`
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

check("parent dir mode 0o755 rejected (defense in depth)", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir(() => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-755-"));
    try {
      // Plant marker with correct 0o600 AND set parent fp dir to 0o755.
      const fpDir = _resolvedTrustDirForTests(ws);
      fs.mkdirSync(fpDir, { recursive: true, mode: 0o755 });
      fs.chmodSync(fpDir, 0o755);
      const marker = trustFilePath(ws, "whatsapp");
      fs.writeFileSync(marker, "", { mode: 0o600 });
      fs.chmodSync(marker, 0o600);
      assert(
        isOwnerTrusted(ws, "whatsapp") === false,
        "0o755 parent should be rejected even with 0o600 marker"
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Nonexistent-tail edge case (canonicalize fallback)
// ---------------------------------------------------------------------------

check("nonexistent-tail: fingerprint stable for workspace that doesn't exist", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ws-tail-"));
  const ws = path.join(parent, "future", "child");
  try {
    // Compute fingerprint twice without ever creating the path.
    const a = workspaceFingerprint(ws);
    const b = workspaceFingerprint(ws);
    assert(a === b, "stable across calls when path doesn't exist");
    assert(/^[0-9a-f]{32}$/.test(a), "still 32-hex");
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Hard cutover: legacy global file alone returns false
// ---------------------------------------------------------------------------

check("hard cutover: legacy global file + workspace-local absent → false", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cutover-"));
    try {
      // Plant legacy global file at the flat path (the 1.5/1.6 layout).
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      assert(
        isOwnerTrusted(ws, "whatsapp") === false,
        "1.7 ignores legacy flat file — no automatic upgrade"
      );
      // But the legacy-diagnostic helper still sees it (so the user gets a hint).
      assert(
        legacyGlobalTrustExists("whatsapp") === true,
        "legacy helper detects for doctor warn"
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 11. removeTrustMarker isolation across workspaces
// ---------------------------------------------------------------------------

check("removeTrustMarker: removing A's marker does NOT touch B", () => {
  withEnvTrustDir(() => {
    const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rmA-"));
    const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rmB-"));
    try {
      writeTrustMarker(wsA, "whatsapp");
      writeTrustMarker(wsB, "whatsapp");
      assert(isOwnerTrusted(wsA, "whatsapp") === true, "A planted");
      assert(isOwnerTrusted(wsB, "whatsapp") === true, "B planted");
      removeTrustMarker(wsA, "whatsapp");
      assert(isOwnerTrusted(wsA, "whatsapp") === false, "A removed");
      assert(
        isOwnerTrusted(wsB, "whatsapp") === true,
        "B untouched — workspace isolation on disable"
      );
    } finally {
      fs.rmSync(wsA, { recursive: true, force: true });
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Doctor: legacy global file does NOT report "acting as owner"
//     (Codex Phase 8 round-1 HIGH #7 — checkScopeOwnerAssertion routed
//     through `isOwnerTrusted(workspace, ...)` instead of constructing
//     the legacy direct path)
// ---------------------------------------------------------------------------

check("doctor: legacy global owner file is NOT counted as owner unlock", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-doctor-legacy-"));
    try {
      fs.writeFileSync(path.join(ws, "agent-config.json"), JSON.stringify({
        memory: { backend: "builtin", citations: "auto" },
        scope: { whatsapp: { mode: "enforce", identity: "owner" } },
      }));
      // Plant the LEGACY flat file at the env base (the pre-1.7 location).
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      const c = checkScopeOwnerAssertion(ws);
      assert(
        c.status !== "info" || !/whatsapp/.test(c.message),
        "legacy file shouldn't surface as active owner unlock"
      );
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

check("read-scope adapter: legacy warn state SURVIVES adapter rebuild (Codex round-2 MEDIUM)", () => {
  if (process.platform === "win32") return;
  _resetLegacyTrustWarnedForTests();
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-rebuild-"));
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-rebuild-"));
    try {
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      const accessPath = path.join(channelDir, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({
          ownerJids: ["owner@s.whatsapp.net"],
          allowFrom: ["owner@s.whatsapp.net"],
          groups: {},
          dms: {},
        })
      );
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const ctx = makeForegroundContext("req-1", { env: {} });
        // Simulate runtime cache TTL expiry: build adapter, call, drop it,
        // build a NEW adapter for the same workspace, call again. Round-2
        // MEDIUM: closure-local Set would reset → two warnings. Module-
        // level Set keeps the warn at exactly 1.
        for (let i = 0; i < 3; i++) {
          const adapter = createWhatsappAdapter({
            accessPath,
            workspaceRoot: ws,
            configuredIdentity: "owner",
            isAutoDiscovered: true,
          })!;
          adapter.allowedChatIds(ctx);
        }
        const matching = warnings.filter((w) =>
          /Legacy global scope trust detected for whatsapp/.test(w)
        );
        assert(
          matching.length === 1,
          `expected exactly one warning across 3 adapter rebuilds, got ${matching.length}: ${JSON.stringify(warnings)}`
        );
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(channelDir, { recursive: true, force: true });
    }
  });
});

check("read-scope adapter: distinct workspaces each warn once (per-workspace key)", () => {
  if (process.platform === "win32") return;
  _resetLegacyTrustWarnedForTests();
  withEnvTrustDir((base) => {
    const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "ws-key-a-"));
    const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "ws-key-b-"));
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-key-"));
    try {
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      const accessPath = path.join(channelDir, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({
          ownerJids: ["owner@s.whatsapp.net"],
          allowFrom: ["owner@s.whatsapp.net"],
          groups: {},
          dms: {},
        })
      );
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const ctx = makeForegroundContext("req-1", { env: {} });
        const adapterA = createWhatsappAdapter({
          accessPath,
          workspaceRoot: wsA,
          configuredIdentity: "owner",
          isAutoDiscovered: true,
        })!;
        const adapterB = createWhatsappAdapter({
          accessPath,
          workspaceRoot: wsB,
          configuredIdentity: "owner",
          isAutoDiscovered: true,
        })!;
        adapterA.allowedChatIds(ctx);
        adapterA.allowedChatIds(ctx);
        adapterB.allowedChatIds(ctx);
        adapterB.allowedChatIds(ctx);
        const matching = warnings.filter((w) =>
          /Legacy global scope trust detected for whatsapp/.test(w)
        );
        assert(
          matching.length === 2,
          `expected one warning per workspace (2 total), got ${matching.length}: ${JSON.stringify(warnings)}`
        );
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      fs.rmSync(wsA, { recursive: true, force: true });
      fs.rmSync(wsB, { recursive: true, force: true });
      fs.rmSync(channelDir, { recursive: true, force: true });
    }
  });
});

check("legacy-warn Set is FIFO-capped (Codex round-3 LOW): unbounded growth prevented", () => {
  if (process.platform === "win32") return;
  _resetLegacyTrustWarnedForTests();
  withEnvTrustDir((base) => {
    // Plant the legacy file so the warn predicate fires.
    const legacy = path.join(base, "whatsapp-owner");
    fs.writeFileSync(legacy, "", { mode: 0o600 });
    fs.chmodSync(legacy, 0o600);
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-cap-"));
    const accessPath = path.join(channelDir, "access.json");
    fs.writeFileSync(
      accessPath,
      JSON.stringify({
        ownerJids: ["owner@s.whatsapp.net"],
        allowFrom: ["owner@s.whatsapp.net"],
        groups: {},
        dms: {},
      })
    );
    const workspaces: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => {}; // silence
    try {
      // Build 300 distinct ephemeral workspaces (over the 256 cap).
      for (let i = 0; i < 300; i++) {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), `ws-cap-${i}-`));
        workspaces.push(ws);
        const adapter = createWhatsappAdapter({
          accessPath,
          workspaceRoot: ws,
          configuredIdentity: "owner",
          isAutoDiscovered: true,
        })!;
        adapter.allowedChatIds(makeForegroundContext("req", { env: {} }));
      }
      const size = _legacyTrustWarnedSizeForTests();
      assert(
        size <= 256,
        `Set grew unbounded: size=${size} (expected ≤256)`
      );
    } finally {
      console.warn = originalWarn;
      for (const w of workspaces) fs.rmSync(w, { recursive: true, force: true });
      fs.rmSync(channelDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 13. workspaceFingerprint argument validation (Codex round-1 LOW #5)
// ---------------------------------------------------------------------------

check("workspaceFingerprint: throws on empty string", () => {
  let threw = false;
  try {
    workspaceFingerprint("");
  } catch {
    threw = true;
  }
  assert(threw, "empty string should throw");
});

check("workspaceFingerprint: throws on relative path", () => {
  let threw = false;
  try {
    workspaceFingerprint("relative/path");
  } catch {
    threw = true;
  }
  assert(threw, "relative path should throw");
});

check("workspaceFingerprint: throws on non-string", () => {
  let threw = false;
  try {
    // @ts-expect-error intentional
    workspaceFingerprint(undefined);
  } catch {
    threw = true;
  }
  assert(threw, "undefined should throw");
});

// ---------------------------------------------------------------------------
// 14. Codex round-1 MEDIUM: read-scope legacy-trust migration warning fires
//     ONCE per (workspace × channel) when workspace trust missing but legacy
//     global exists. Silent degradation without this is the upgrade trap.
// ---------------------------------------------------------------------------

check("read-scope adapter: warns once when legacy global trust exists + workspace trust absent", () => {
  if (process.platform === "win32") return;
  _resetLegacyTrustWarnedForTests();
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-warn-"));
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-warn-"));
    try {
      // Plant a valid legacy global owner trust at the flat path.
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      // Build access.json with non-empty ownerJids.
      const accessPath = path.join(channelDir, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({
          ownerJids: ["owner@s.whatsapp.net"],
          allowFrom: ["owner@s.whatsapp.net"],
          groups: {},
          dms: {},
        })
      );
      // Capture console.warn output.
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const adapter = createWhatsappAdapter({
          accessPath,
          workspaceRoot: ws,
          configuredIdentity: "owner",
          isAutoDiscovered: true,
        })!;
        const ctx = makeForegroundContext("req-1", { env: {} });
        adapter.allowedChatIds(ctx);
        adapter.allowedChatIds(ctx);
        adapter.allowedChatIds(ctx);
        const matching = warnings.filter((w) =>
          /Legacy global scope trust detected for whatsapp/.test(w)
        );
        assert(
          matching.length === 1,
          `expected exactly one warning, got ${matching.length}: ${JSON.stringify(warnings)}`
        );
        assert(
          /\/agent:scope wizard/.test(matching[0]),
          "warning should mention the wizard recovery action"
        );
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(channelDir, { recursive: true, force: true });
    }
  });
});

check("read-scope adapter: does NOT warn when no legacy file present", () => {
  if (process.platform === "win32") return;
  _resetLegacyTrustWarnedForTests();
  withEnvTrustDir(() => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-nowarn-"));
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-nowarn-"));
    try {
      const accessPath = path.join(channelDir, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({
          ownerJids: ["owner@s.whatsapp.net"],
          allowFrom: ["owner@s.whatsapp.net"],
          groups: {},
          dms: {},
        })
      );
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const adapter = createWhatsappAdapter({
          accessPath,
          workspaceRoot: ws,
          configuredIdentity: "owner",
          isAutoDiscovered: true,
        })!;
        adapter.allowedChatIds(makeForegroundContext("req-1", { env: {} }));
        const matching = warnings.filter((w) =>
          /Legacy global scope trust detected/.test(w)
        );
        assert(matching.length === 0, "no legacy file = no noise");
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(channelDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 15. checkScopeTrustLegacy doctor walk (Phase 8 Step 2 Q3)
// ---------------------------------------------------------------------------

check("checkScopeTrustLegacy: trust-dir absent → ok (clean post-1.7 install)", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-absent-"));
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  const fakeBase = path.join(os.tmpdir(), "doesnt-exist-" + Date.now());
  process.env.CLAW_SCOPE_TRUST_DIR = fakeBase;
  try {
    const c = checkScopeTrustLegacy(ws);
    assert(c.status === "ok", `expected ok, got ${c.status}: ${c.message}`);
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("checkScopeTrustLegacy: legacy flat file → warn with exact path in hint", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-warn-"));
    try {
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      const c = checkScopeTrustLegacy(ws);
      assert(c.status === "warn", `expected warn, got ${c.status}: ${c.message}`);
      assert(c.message.includes(legacy), "message lists the legacy path");
      assert(c.hint !== undefined && c.hint.includes(legacy), "hint includes literal path");
      assert(c.hint!.includes("rm "), "hint includes rm command");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

check("checkScopeTrustLegacy: stale 0o644 leftover → ok (gated by legacyGlobalTrustExists)", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-stale-"));
    try {
      const stale = path.join(base, "whatsapp-owner");
      fs.writeFileSync(stale, "", { mode: 0o644 });
      fs.chmodSync(stale, 0o644);
      const c = checkScopeTrustLegacy(ws);
      assert(c.status === "ok", `0o644 wouldn't unlock under 1.6 — no noise. got ${c.status}: ${c.message}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

check("checkScopeTrustLegacy: fingerprint subdir (1.7+ layout) NOT counted as legacy", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-mixed-"));
    try {
      // Plant a 1.7+ workspace-bound trust file (fingerprint subdir).
      writeTrustMarker(ws, "whatsapp");
      // Walk should report ok — no flat-layout files present.
      const c = checkScopeTrustLegacy(ws);
      assert(c.status === "ok", `subdir-only layout = no legacy. got ${c.status}: ${c.message}`);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

check("checkScopeTrustLegacy: symlinked trust dir → advisory warn, NOT followed", () => {
  if (process.platform === "win32") return;
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "real-trust-"));
  const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), "wrap-"));
  const linkPath = path.join(wrapper, "scope-trust");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-symlink-"));
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  try {
    fs.symlinkSync(realDir, linkPath);
    process.env.CLAW_SCOPE_TRUST_DIR = linkPath;
    const c = checkScopeTrustLegacy(ws);
    assert(c.status === "warn", `symlinked dir = advisory. got ${c.status}: ${c.message}`);
    assert(/symlink/.test(c.message), "message mentions symlink");
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(realDir, { recursive: true, force: true });
    fs.rmSync(wrapper, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

check("checkScopeTrustLegacy: mixed legacy + fingerprint subdir → only flat counted", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-both-"));
    try {
      // Plant a valid legacy flat file
      const legacy = path.join(base, "telegram-exec");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      // Plant a 1.7+ workspace subdir
      writeTrustMarker(ws, "whatsapp");
      const c = checkScopeTrustLegacy(ws);
      assert(c.status === "warn", `flat file should warn. got ${c.status}: ${c.message}`);
      assert(c.message.includes("telegram-exec"), "lists the flat file");
      assert(!c.message.includes("whatsapp-owner"), "doesn't list the 1.7+ workspace marker");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

check("checkScopeTrustLegacy: multiple legacy files → all listed in hint rm command", () => {
  if (process.platform === "win32") return;
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-legacy-many-"));
    try {
      for (const name of ["whatsapp-owner", "whatsapp-exec", "telegram-owner"]) {
        const p = path.join(base, name);
        fs.writeFileSync(p, "", { mode: 0o600 });
        fs.chmodSync(p, 0o600);
      }
      const c = checkScopeTrustLegacy(ws);
      assert(c.status === "warn", `multiple legacy = warn. got ${c.status}`);
      assert(c.message.includes("3 legacy"), `count=3 in message; got: ${c.message}`);
      const hint = c.hint ?? "";
      assert(/whatsapp-owner/.test(hint), "hint covers whatsapp-owner");
      assert(/whatsapp-exec/.test(hint), "hint covers whatsapp-exec");
      assert(/telegram-owner/.test(hint), "hint covers telegram-owner");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Runtime + adapter dedup via shared legacy-warn helper (Q4)
// ---------------------------------------------------------------------------

check("runtime + whatsapp adapter share dedup (no double warn for WA)", () => {
  if (process.platform === "win32") return;
  _resetLegacyTrustWarnedForTests();
  withEnvTrustDir((base) => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-shared-"));
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cd-shared-"));
    try {
      // Plant legacy global.
      const legacy = path.join(base, "whatsapp-owner");
      fs.writeFileSync(legacy, "", { mode: 0o600 });
      fs.chmodSync(legacy, 0o600);
      const accessPath = path.join(channelDir, "access.json");
      fs.writeFileSync(
        accessPath,
        JSON.stringify({
          ownerJids: ["owner@s.whatsapp.net"],
          allowFrom: ["owner@s.whatsapp.net"],
          groups: {},
          dms: {},
        })
      );
      // Build adapter (which calls the shared helper) AND simulate a
      // runtime detection-style call. The same key should de-dupe.
      const originalWarn = console.warn;
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      try {
        const adapter = createWhatsappAdapter({
          accessPath,
          workspaceRoot: ws,
          configuredIdentity: "owner",
          isAutoDiscovered: true,
        })!;
        adapter.allowedChatIds(makeForegroundContext("req-1", { env: {} }));
        // Simulate the runtime warn for the same (workspace, channel, owner)
        // via the same shared helper. Both surfaces route through the
        // module-scope Set so the same key dedupes naturally.
        warnLegacyTrustMigrationOnce(ws, "whatsapp", "owner");
        const matching = warnings.filter((w) =>
          /Legacy global scope trust detected for whatsapp \(owner\)/.test(w)
        );
        assert(
          matching.length === 1,
          `shared dedup should give exactly 1 warn; got ${matching.length}: ${JSON.stringify(warnings)}`
        );
      } finally {
        console.warn = originalWarn;
      }
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(channelDir, { recursive: true, force: true });
    }
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
console.log(`scope-trust-workspace tier1+tier2: ${passed}/${results.length} passed`);
if (failed > 0) process.exit(1);
