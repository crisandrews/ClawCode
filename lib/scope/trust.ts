/**
 * Out-of-band trust primitive for scope unlocks — workspace-bound.
 *
 * The unlock is gated on a **trust file** that the agent cannot create
 * through any MCP tool — it must be created via `Bash` (which requires
 * per-call user permission in Claude Code's default permission model).
 * The wizard performs the touch as a deliberate user-approved step.
 *
 * As of 1.7.0 the trust file lives under a **per-workspace fingerprint
 * subdirectory** so granting trust in workspace A does NOT unlock workspace
 * B. The fingerprint is a SHA256 over the realpath + case-folded form of
 * the workspace root (128-bit truncation, deterministic across processes).
 *
 * Two trust suffixes per channel (orthogonal):
 *   ~/.claude/agent/scope-trust/<workspace-hash>/<channel>-owner → READ scope
 *   ~/.claude/agent/scope-trust/<workspace-hash>/<channel>-exec  → EXEC gate
 *
 * Separated so a user can opt into owner-level read access (sees all indexed
 * chats from their own machine, this workspace) without also opting into
 * inbound-execution authority. The two trust files are independent — neither
 * implies the other.
 *
 * Validations (matches the resolver's predicate so doctor agrees):
 *   - lstat (rejects symlinks; symlinked trust file is suspicious)
 *   - Regular file (rejects dirs/FIFOs/sockets)
 *   - uid matches the running process (POSIX)
 *   - Mode `& 0o077 === 0` on the marker file (no group/world bits)
 *   - Parent fingerprint subdir is itself 0o077-clean (defense-in-depth:
 *     even if the wizard ran with a permissive umask, the resolver doesn't
 *     fall open).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChannelName } from "../channel-detector.ts";
import {
  canonicalize,
  isWorkspaceCaseInsensitive,
} from "./canonical-path.ts";

const TRUST_DIR_REL = path.join(".claude", "agent", "scope-trust");

/**
 * Test-only override. When set, the trust dir is read from this env
 * var instead of `<homedir>/.claude/agent/scope-trust`. Production
 * leaves this unset.
 */
const TRUST_DIR_ENV = "CLAW_SCOPE_TRUST_DIR";

/** Trust suffix selector — read-scope owner vs execute-gate trust. */
export type TrustSuffix = "owner" | "exec";

/**
 * SHA256(canonicalize(workspaceRoot)) truncated to 32 hex chars (128 bits).
 *
 * Realpath resolves symlinks first, then we probe the actual filesystem at
 * the realpath to decide whether to apply case-fold. Codex Phase 8 round-1
 * HIGH: using the platform default (darwin → fold, linux → don't) would
 * conflate `/Work/Foo` and `/Work/foo` on case-SENSITIVE APFS volumes —
 * breaking the cross-workspace isolation guarantee. The per-workspace
 * probe (see `isWorkspaceCaseInsensitive`) inspects a real entry inside
 * the workspace via a case-flipped lookup and compares inodes.
 *
 * Validates the workspace path: must be a non-empty absolute string.
 * An unset `CLAUDE_PROJECT_DIR` or relative cwd would otherwise produce
 * a deterministic-but-wrong fingerprint shared across unrelated paths.
 */
export function workspaceFingerprint(workspaceRoot: string): string {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError(
      `workspaceFingerprint: workspaceRoot must be a non-empty string, got ${typeof workspaceRoot}`
    );
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw new TypeError(
      `workspaceFingerprint: workspaceRoot must be absolute, got "${workspaceRoot}"`
    );
  }
  // Two-step canonicalize: first realpath WITHOUT case-fold, then probe.
  const realpathOnly = canonicalize(workspaceRoot, false);
  const insensitive = isWorkspaceCaseInsensitive(realpathOnly);
  const final = insensitive ? realpathOnly.toLowerCase() : realpathOnly;
  return crypto.createHash("sha256").update(final).digest("hex").slice(0, 32);
}

/**
 * Returns the trust-dir BASE (no fingerprint applied). Respects the
 * `CLAW_SCOPE_TRUST_DIR` env override. Exported for the doctor walk
 * that detects pre-1.7.0 flat-layout legacy markers — production scope
 * decisions should use `trustDir(workspaceRoot)` instead.
 */
export function trustDirBase(): string {
  const override = process.env[TRUST_DIR_ENV];
  if (override) return override;
  return path.join(os.homedir(), TRUST_DIR_REL);
}

/** Trust dir for THIS workspace (base + fingerprint subdir). */
export function trustDir(workspaceRoot: string): string {
  return path.join(trustDirBase(), workspaceFingerprint(workspaceRoot));
}

/** Absolute path to the trust marker for this workspace + channel + suffix. */
export function trustFilePath(
  workspaceRoot: string,
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): string {
  return path.join(trustDir(workspaceRoot), `${channel}-${suffix}`);
}

/**
 * Returns true when a trust marker exists for this workspace + channel +
 * suffix and is owned by the running process. Workspace-scoped: granting
 * trust in another workspace's fingerprint subdir does NOT unlock here.
 *
 * Parent-directory mode is also validated (Codex Phase 8 Vector 4): even
 * if the marker itself is 0o600, a 0o755 parent dir (e.g. from a wizard
 * that forgot to chmod) is treated as untrusted. Defense-in-depth.
 */
export function isOwnerTrusted(
  workspaceRoot: string,
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): boolean {
  const dir = trustDir(workspaceRoot);
  const file = path.join(dir, `${channel}-${suffix}`);

  // Marker file checks.
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") {
    // No POSIX uid/mode checks on Windows. Still require parent dir to
    // exist as a directory; existence already implies the wizard ran.
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      return false;
    }
    if (!dirStat.isDirectory()) return false;
    return true;
  }
  const pUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof pUid !== "number") return true; // unknown env — be lenient
  if (stat.uid !== pUid) return false;
  if ((stat.mode & 0o077) !== 0) return false;

  // Parent-dir checks (the fingerprint subdir). Same uid + 0o077 requirement.
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!dirStat.isDirectory()) return false;
  if (dirStat.uid !== pUid) return false;
  if ((dirStat.mode & 0o077) !== 0) return false;

  return true;
}

/**
 * Returns true when a LEGACY pre-1.7.0 global trust file exists at the
 * un-fingerprinted path (`<base>/<channel>-<suffix>`) AND would have
 * unlocked under 1.6 semantics (uid + mode + non-symlink + regular file).
 *
 * Consumed for diagnostic purposes only — the resolver augments its
 * block-reason string when this returns true so the user gets a hint to
 * re-run `/agent:scope wizard`. NEVER consulted to unlock (hard cutover).
 *
 * Codex Phase 8 round-2 Vector 3 + round-3 Q2: gating on the full 1.6
 * unlock predicate (not just lstat-presence) avoids noisy diagnostics for
 * stale 0o644 leftovers or symlinked markers that wouldn't have unlocked
 * anyway.
 */
export function legacyGlobalTrustExists(
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): boolean {
  const file = path.join(trustDirBase(), `${channel}-${suffix}`);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;
  const pUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof pUid !== "number") return true;
  if (stat.uid !== pUid) return false;
  if ((stat.mode & 0o077) !== 0) return false;
  return true;
}

/**
 * Filesystem-side helper for the wizard. Writes the trust marker
 * idempotently with `0o600` perms; fingerprint subdir at `0o700`. Caller
 * is responsible for invoking this in a user-approved code path (e.g.
 * `Bash` in the wizard skill).
 *
 * NOT exported for the MCP tool surface — the wizard skill calls Bash
 * directly so the user gets a permission prompt; we don't want a generic
 * "elevate trust" MCP tool that the agent could call.
 */
export function writeTrustMarker(
  workspaceRoot: string,
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): void {
  const file = trustFilePath(workspaceRoot, channel, suffix);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // mkdirSync's `mode` option is partial on some filesystems (umask
  // applied). Explicit chmod afterwards guarantees 0o700.
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(path.dirname(file), 0o700);
    } catch {
      // best-effort; the parent-dir mode check will catch any leak
    }
  }
  fs.writeFileSync(file, "", { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
  }
}

/** Test surface: path to where the trust dir BASE resolves right now. */
export function _resolvedTrustDirBaseForTests(): string {
  return trustDirBase();
}

/** Test surface: path to where THIS workspace's trust dir resolves right now. */
export function _resolvedTrustDirForTests(workspaceRoot: string): string {
  return trustDir(workspaceRoot);
}

/**
 * Removes the trust marker. Used by the wizard's "disable" path. Does
 * NOT remove the fingerprint subdir itself (it may contain other
 * suffixes for the same workspace).
 */
export function removeTrustMarker(
  workspaceRoot: string,
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): void {
  const file = trustFilePath(workspaceRoot, channel, suffix);
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — ok
  }
}
