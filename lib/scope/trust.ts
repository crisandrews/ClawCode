/**
 * Out-of-band trust primitive for scope owner unlocks.
 *
 * Codex post-impl 2nd-pass CRITICAL: the `agent_config(action='set')` MCP
 * tool accepts any dotted key from the agent without verifying caller
 * authority. If `scope.whatsapp.identity = "owner"` were honored on its
 * own, a prompt-injection attack via untrusted content (a malicious
 * email read in another tool, a webpage in WebFetch, etc.) could trick
 * the agent into writing the unlock and immediately reading scoped
 * WhatsApp memory.
 *
 * Mitigation: the unlock is gated on a **trust file** that the agent
 * cannot create through any MCP tool — it must be created via `Bash`
 * (which requires per-call user permission in Claude Code's default
 * permission model). The wizard performs the touch as a deliberate
 * user-approved step.
 *
 * Layout:
 *   ~/.claude/agent/scope-trust/<channel>-owner
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

/** Absolute path to the trust marker for a given channel. */
export function trustFilePath(channel: ChannelName): string {
  return path.join(trustDir(), `${channel}-owner`);
}

/**
 * Returns true when an owner-trust marker exists for this channel and
 * is owned by the running process (or on Windows, just exists).
 */
export function isOwnerTrusted(channel: ChannelName): boolean {
  const file = trustFilePath(channel);
  let stat: fs.Stats;
  try {
    // lstat (not stat): a symlinked trust file is suspicious and not
    // honored. The caller-of-this-fn responsibility is "is the trust
    // file legit"; symlinks shadow that.
    stat = fs.lstatSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (process.platform === "win32") return true;
  const pUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof pUid !== "number") return true; // unknown env — be lenient
  return stat.uid === pUid;
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
export function writeTrustMarker(channel: ChannelName): void {
  const file = trustFilePath(channel);
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
export function removeTrustMarker(channel: ChannelName): void {
  const file = trustFilePath(channel);
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone — ok
  }
}
