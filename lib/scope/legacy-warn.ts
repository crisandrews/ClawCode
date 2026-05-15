/**
 * Shared "warn-once-per-workspace" helper for the 1.6 → 1.7 trust-file
 * migration. Codex Phase 8 Step 2 round-pre-impl Q4: two independent
 * surfaces (the WhatsApp adapter and `detectScopeRuntime`) both want to
 * surface the migration hint when a 1.6 legacy global trust file exists
 * AND the workspace-scoped one doesn't. If each kept its own dedup Set,
 * users on WhatsApp would see the warning twice on first armed detect.
 *
 * This module owns the single source of truth — both callers funnel
 * through `warnLegacyTrustMigrationOnce`, keyed by
 * `${workspaceFingerprint}:${channel}:${suffix}`. The Set is FIFO-capped
 * at 256 entries so a long-running process cycling through ephemeral
 * workspaces (test runners) doesn't accumulate.
 *
 * Predicate semantics match `legacyGlobalTrustExists`: only fires when
 * the legacy file would have unlocked under 1.6 semantics (full mode/uid
 * check), so stale 0o644 leftovers or symlinked markers don't produce
 * noise.
 */

import type { ChannelName } from "../channel-detector.ts";
import {
  isOwnerTrusted,
  legacyGlobalTrustExists,
  workspaceFingerprint,
  type TrustSuffix,
} from "./trust.ts";

const WARNED_CAP = 256;
const warnedKeys = new Set<string>();

function remember(key: string): void {
  if (warnedKeys.size >= WARNED_CAP) {
    const oldest = warnedKeys.values().next().value;
    if (oldest !== undefined) warnedKeys.delete(oldest);
  }
  warnedKeys.add(key);
}

/**
 * Surface the 1.7 migration hint to stderr ONCE per
 * (workspaceFingerprint × channel × suffix). No-op when:
 *   - workspace trust file already exists (the unlock works)
 *   - no legacy global file exists (clean post-1.7 state)
 *   - workspaceRoot is malformed (fingerprint throws; we swallow)
 *   - this combo already warned in the current process
 */
export function warnLegacyTrustMigrationOnce(
  workspaceRoot: string,
  channel: ChannelName,
  suffix: TrustSuffix
): void {
  let fp: string;
  try {
    fp = workspaceFingerprint(workspaceRoot);
  } catch {
    return;
  }
  const key = `${fp}:${channel}:${suffix}`;
  if (warnedKeys.has(key)) return;
  if (isOwnerTrusted(workspaceRoot, channel, suffix)) return;
  if (!legacyGlobalTrustExists(channel, suffix)) return;
  remember(key);
  console.warn(
    `[clawcode] Legacy global scope trust detected for ${channel} (${suffix}). ` +
      "After upgrading to 1.7+, trust is per-workspace — run /agent:scope wizard " +
      "in this workspace to re-grant, or scope features will silently degrade."
  );
}

/** @internal Test-only: reset state between tests. */
export function _resetLegacyTrustWarnedForTests(): void {
  warnedKeys.clear();
}

/** @internal Test-only: inspect Set size to verify the FIFO cap. */
export function _legacyTrustWarnedSizeForTests(): number {
  return warnedKeys.size;
}
