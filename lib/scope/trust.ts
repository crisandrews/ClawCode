/**
 * Out-of-band trust primitive for scope unlocks.
 *
 * The unlock is gated on a **trust file** that the agent cannot create
 * through any MCP tool — it must be created via `Bash` (which requires
 * per-call user permission in Claude Code's default permission model).
 * The wizard performs the touch as a deliberate user-approved step.
 *
 * Two trust suffixes per channel (orthogonal):
 *   ~/.claude/agent/scope-trust/<channel>-owner  → unlocks READ scope
 *   ~/.claude/agent/scope-trust/<channel>-exec   → unlocks EXECUTE gate
 *
 * Separated so a user can opt into owner-level read access (sees all
 * indexed chats from their own machine) without also opting into
 * inbound-execution authority (granting non-owner group chats the
 * power to invoke destructive tools). The two trust files are independent
 * — neither implies the other.
 *
 * Existence + correct ownership = trust. Empty file is sufficient
 * (we don't need a payload). On Windows uid is meaningless; existence
 * alone is honored.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChannelName } from "../channel-detector.ts";

const TRUST_DIR_REL = path.join(".claude", "agent", "scope-trust");

/**
 * Test-only override. When set, the trust dir is read from this env
 * var instead of `<homedir>/.claude/agent/scope-trust`. Production
 * leaves this unset.
 */
const TRUST_DIR_ENV = "CLAW_SCOPE_TRUST_DIR";

function trustDir(): string {
  const override = process.env[TRUST_DIR_ENV];
  if (override) return override;
  return path.join(os.homedir(), TRUST_DIR_REL);
}

/** Trust suffix selector — read-scope owner vs execute-gate trust. */
export type TrustSuffix = "owner" | "exec";

/** Absolute path to the trust marker for a given channel + suffix. */
export function trustFilePath(
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): string {
  return path.join(trustDir(), `${channel}-${suffix}`);
}

/**
 * Returns true when a trust marker exists for this channel + suffix and
 * is owned by the running process (or on Windows, just exists). The
 * `<channel>-owner` and `<channel>-exec` files are independent — neither
 * implies the other.
 *
 * Validations:
 *   - lstat (not stat): a symlinked trust file is suspicious and not
 *     honored.
 *   - Regular file (rejects dirs/FIFOs/sockets).
 *   - uid matches the running process (POSIX only).
 *   - Mode `& 0o077 === 0` (no group/world bits). A trust marker that's
 *     world-readable hints at sloppy setup; reject it to keep the contract
 *     identical to scope's other privileged-file primitives.
 */
export function isOwnerTrusted(
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): boolean {
  const file = trustFilePath(channel, suffix);
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
  if (typeof pUid !== "number") return true; // unknown env — be lenient
  if (stat.uid !== pUid) return false;
  // Reject group/world-readable trust markers. Same defense as voice
  // output canonicalization + envelope reader — privileged on-disk
  // signals must be 0o600 (or stricter).
  if ((stat.mode & 0o077) !== 0) return false;
  return true;
}

/**
 * Filesystem-side helper for the wizard. Writes the trust marker
 * idempotently with `0o600` perms. Caller is responsible for invoking
 * this in a user-approved code path (e.g. `Bash` in the wizard skill).
 *
 * NOT exported for the MCP tool surface — the wizard skill calls Bash
 * directly so the user gets a permission prompt; we don't want a
 * generic "elevate trust" MCP tool that the agent could call.
 */
export function writeTrustMarker(
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): void {
  const file = trustFilePath(channel, suffix);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, "", { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
  }
}

/** Test surface: path to where the trust dir resolves *right now*. */
export function _resolvedTrustDirForTests(): string {
  return trustDir();
}

/**
 * Removes the trust marker. Used by the wizard's "disable" path.
 */
export function removeTrustMarker(
  channel: ChannelName,
  suffix: TrustSuffix = "owner"
): void {
  const file = trustFilePath(channel, suffix);
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — ok
  }
}
