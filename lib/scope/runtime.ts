/**
 * Scope runtime detection — Phase 3 implementation.
 *
 * Replaces the Phase 0 stub. Reads `config.scope.*`, instantiates
 * registered adapters lazily, and exposes a snapshot of which
 * channels are *armed* (mode != off, adapter available, governance
 * resolvable).
 *
 * Critical invariants for users without scope opt-in:
 *   - `config.scope` undefined → returns `{ anyArmed: false }`
 *     immediately. No filesystem access, no adapter instantiation.
 *   - Every channel with `mode === "off"` is skipped.
 *   - An adapter that can't resolve governance (e.g. missing
 *     `access.json`) sets `governanceResolvable: false` and the
 *     channel stays disarmed even with `mode != off`.
 *
 * Detection results are cached per-process for `RUNTIME_TTL_MS` to
 * avoid re-statting `access.json` on every search. The TTL is
 * deliberately short (5 s) so operator config changes propagate
 * within a normal interaction window.
 *
 * The Phase 0 helpers `isChannelDerivedPath` and
 * `applyPreventivePromoteGuard` carry over unchanged so the
 * dreaming.ts call site keeps working without any rewire.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, ScopeConfigTree } from "../config.ts";
import type { ChannelName } from "../channel-detector.ts";
import { detectWhatsappProjectDir } from "../channel-detector.ts";
import {
  _resetRegistryForTests,
  getScopeAdapter,
  registerScopeAdapter,
  unregisterScopeAdapter,
} from "./index.ts";
import { createWhatsappAdapter } from "./whatsapp.ts";
import { deriveProvenance } from "./provenance.ts";

const ALL_KNOWN_SCOPE_CHANNELS: ChannelName[] = [
  "whatsapp",
  "telegram",
  "discord",
  "imessage",
  "webchat",
];

export interface ScopeRuntimeChannelState {
  mode: "off" | "shadow" | "enforce";
  configured: boolean;
  adapterAvailable: boolean;
  governanceResolvable: boolean;
  armed: boolean;
  /** Sanitized reason when the channel is configured but disarmed. */
  reason?: string;
}

export interface ScopeRuntimeState {
  anyArmed: boolean;
  /**
   * Codex round-8 ship-readiness BLOCKER fix: `anyArmed` is false when
   * a channel has `mode: enforce` but its adapter went missing
   * (governance unresolvable, plugin uninstalled, access.json deleted).
   * In that state the previous filter short-circuit served chunks
   * unfiltered. `anyEnforceConfigured` is true whenever ANY channel
   * has `mode: enforce` in config — regardless of armed state — so the
   * filter still runs and the existing "adapter missing → fail closed"
   * branch denies the chunks. Phase 4a-2.6 v19 grace-period purge
   * (24h after `messages.db` ENOENT) eventually deletes the chunks; this
   * flag covers the visibility window in between.
   */
  anyEnforceConfigured: boolean;
  channels: Partial<Record<ChannelName, ScopeRuntimeChannelState>>;
}

const RUNTIME_TTL_MS = 5_000;

interface CachedDetect {
  state: ScopeRuntimeState;
  expiresAt: number;
  /** Hash of the input config + workspace; cache invalidates when either changes. */
  configFingerprint: string;
}

let cached: CachedDetect | null = null;

/**
 * Detect armed channels from the agent config. Returns a cached
 * snapshot when called within `RUNTIME_TTL_MS` of the last call
 * with the same config fingerprint; otherwise runs full detection.
 *
 * Phase 0 callers (`dreaming.ts`, `doctor.ts`) pass no argument and
 * receive the no-armed shape — we fall back to that path when
 * `config` is undefined to preserve compatibility.
 *
 * Codex 3rd-pass MEDIUM: `workspaceRoot` (when provided) becomes the
 * "auto" base for `accessJsonPath`. Previously this used
 * `process.cwd()` unconditionally, which only matches WORKSPACE when
 * the launch wrapper successfully `cd`'d in. Background tasks /
 * detached processes / daemonized servers can have a cwd of `/` or
 * the user's home dir, missing the project-local install of
 * claude-whatsapp. Threading the actual workspace root keeps
 * auto-discovery deterministic.
 */
export function detectScopeRuntime(
  config?: AgentConfig,
  workspaceRoot?: string
): ScopeRuntimeState {
  // No-config call — Phase 0 path. Returns no-armed. Codex CRITICAL
  // fix (Phase 4a-2 adversarial review): we must NOT purge adapters
  // here. This branch is reached by legacy callers that have no view
  // into the live config (e.g. `applyPreventivePromoteGuard`'s
  // default-parameter fallback, certain doctor helpers). Purging on
  // those calls would clear adapter state mid-session even though
  // the operator's config still has scope armed — an availability
  // regression. Adapter cleanup-on-disarm lives inside `runDetection`
  // and the no-scope branch below, both of which see real config.
  if (!config) {
    return { anyArmed: false, anyEnforceConfigured: false, channels: {} };
  }
  // Absent or empty scope tree — no-armed. Caller DID provide config
  // but with no `scope` block, which is an intentional disarm (or a
  // session that never armed in the first place). Drop any adapters
  // that may still be in the registry from a prior detection round.
  if (!config.scope) {
    purgeAllScopeAdapters();
    return { anyArmed: false, anyEnforceConfigured: false, channels: {} };
  }

  const baseCwd = workspaceRoot ?? process.cwd();
  const fingerprint = JSON.stringify({ scope: config.scope, baseCwd });
  const now = Date.now();
  if (
    cached &&
    cached.configFingerprint === fingerprint &&
    cached.expiresAt > now
  ) {
    return cached.state;
  }

  const state = runDetection(config.scope, baseCwd);
  cached = {
    state,
    expiresAt: now + RUNTIME_TTL_MS,
    configFingerprint: fingerprint,
  };
  return state;
}

/** Drop every channel's adapter from the registry. */
function purgeAllScopeAdapters(): void {
  for (const ch of ALL_KNOWN_SCOPE_CHANNELS) {
    unregisterScopeAdapter(ch);
  }
}

/**
 * Returns true when the path looks like it came from a known external
 * channel via `memory.extraPaths`. Memory-db uses the `extra:` prefix
 * convention for any chunk that originated outside the workspace's
 * own `memory/` directory.
 *
 * Phase 0 invariant preserved.
 */
export function isChannelDerivedPath(p: string | undefined | null): boolean {
  return typeof p === "string" && p.startsWith("extra:");
}

/**
 * Filter dream-promote candidates ahead of writing to MEMORY.md.
 *
 * When no channel is armed, returns the input untouched (Phase 0
 * behavior; identical to today). When at least one channel is armed
 * (Phase 3+), drops candidates whose source path is derived from an
 * **armed** channel — those need to live in
 * `memory/.scoped/<channel>/...` per the dual-lane design.
 *
 * Codex Phase 4a-3 post-impl HIGH #6: previous implementation dropped
 * EVERY `extra:` path when any channel was armed, including paths
 * sourced from a different unarmed channel. Per the documented
 * behavior, unarmed-channel candidates should fall through to
 * `MEMORY.md` (preserving data) until the user explicitly arms that
 * channel and the indexer migrates them. The guard now needs the
 * runtime to know which channels are armed.
 */
export function applyPreventivePromoteGuard<
  T extends { entry: { path: string } }
>(
  candidates: T[],
  runtime: ScopeRuntimeState = detectScopeRuntime()
): { kept: T[]; skipped: number } {
  // Codex round-8 ship-readiness BLOCKER fix: same as filterScopedResults
  // — if any channel is enforce-configured (even if adapter is missing),
  // we must still run the guard so chunks from that channel get diverted
  // to the scoped lane instead of promoted to MEMORY.md.
  if (!runtime.anyArmed && !runtime.anyEnforceConfigured) {
    return { kept: candidates, skipped: 0 };
  }
  const kept: T[] = [];
  let skipped = 0;
  for (const c of candidates) {
    const p = c.entry?.path;
    if (typeof p !== "string") {
      kept.push(c);
      continue;
    }
    // Codex post-impl-round2 LOW #7: any future code path that throws
    // out of `deriveProvenance` (file-stat, realpath, registry race)
    // shouldn't abort the whole dream. Fail closed on `extra:` paths
    // (treat as armed-channel-derived) so a provenance bug can't be
    // weaponized to bypass the guard. Non-`extra:` paths keep the
    // legacy "kept" default.
    let isArmedChannel = false;
    try {
      const prov = deriveProvenance(p);
      if (prov.class.kind === "channel" && prov.sourceChannel) {
        const chState =
          runtime.channels[
            prov.sourceChannel as keyof ScopeRuntimeState["channels"]
          ];
        // Codex round-8 BLOCKER fix: also divert when channel is
        // enforce-configured but adapter went missing. Otherwise dreams
        // would silently leak the chunks into MEMORY.md.
        if (chState?.armed || chState?.mode === "enforce") {
          isArmedChannel = true;
        }
      }
    } catch {
      if (p.startsWith("extra:")) isArmedChannel = true;
    }
    if (isArmedChannel) {
      skipped++;
    } else {
      kept.push(c);
    }
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------------------
// Internal: full detection
// ---------------------------------------------------------------------------

function runDetection(
  scope: ScopeConfigTree,
  baseCwd: string
): ScopeRuntimeState {
  const channels: ScopeRuntimeState["channels"] = {};

  // WhatsApp — only channel with a real adapter in Phase 3.
  if (scope.whatsapp) {
    channels.whatsapp = detectWhatsappArmed(scope.whatsapp, baseCwd);
  }
  for (const ch of ["telegram", "discord", "imessage", "webchat"] as const) {
    const cfg = scope[ch];
    if (!cfg) continue;
    channels[ch] = {
      mode: cfg.mode ?? "off",
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "no adapter available for this channel yet",
    };
  }

  // Codex P1 fix: any channel that ended up disarmed (mode flipped
  // off, governance disappeared, etc.) must drop its adapter from
  // the registry, even when a prior detection round had armed it.
  // Otherwise Phase 4a-1 chokepoints could surface a stale adapter
  // via `getScopeAdapter` after the user disabled the channel.
  for (const ch of ALL_KNOWN_SCOPE_CHANNELS) {
    if (!channels[ch]?.armed) unregisterScopeAdapter(ch);
  }

  const anyArmed = Object.values(channels).some((c) => c?.armed);
  const anyEnforceConfigured = Object.values(channels).some(
    (c) => c?.mode === "enforce"
  );
  return { anyArmed, anyEnforceConfigured, channels };
}

function detectWhatsappArmed(
  cfg: NonNullable<ScopeConfigTree["whatsapp"]>,
  baseCwd: string
): ScopeRuntimeChannelState {
  const mode = cfg.mode ?? "off";
  if (mode === "off") {
    return {
      mode: "off",
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "mode is off",
    };
  }

  const accessPathResult = resolveAccessPath(cfg, baseCwd);
  if (!accessPathResult || !fs.existsSync(accessPathResult.accessPath)) {
    return {
      mode,
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "access.json not resolvable",
    };
  }

  const adapter = createWhatsappAdapter({
    accessPath: accessPathResult.accessPath,
    configuredIdentity: cfg.identity ?? "auto",
    // Codex 3rd-pass CRITICAL 2: bootstrap fail-open is only safe for
    // auto-discovered upstream governance. When the user (or a
    // prompt-injected agent) has set `accessJsonPath` to a custom
    // location, treat `ownerJids: []` as "malformed" rather than
    // "intentional bootstrap" — so an attacker can't point us at
    // agent-config.json (or any other writable file) and forge a
    // bootstrap-mode unlock.
    isAutoDiscovered: accessPathResult.isAutoDiscovered,
  });
  if (!adapter) {
    return {
      mode,
      configured: true,
      adapterAvailable: false,
      governanceResolvable: false,
      armed: false,
      reason: "adapter could not resolve governance",
    };
  }

  registerScopeAdapter(adapter);
  return {
    mode,
    configured: true,
    adapterAvailable: true,
    governanceResolvable: true,
    armed: mode !== "off",
  };
}

/**
 * Codex 3rd-pass CRITICAL 2: surface whether the access path was
 * auto-discovered (trusted upstream layout) or user/agent-configured
 * (treated with extra suspicion downstream).
 */
function resolveAccessPath(
  cfg: NonNullable<ScopeConfigTree["whatsapp"]>,
  baseCwd: string
): { accessPath: string; isAutoDiscovered: boolean } | null {
  if (cfg.accessJsonPath && cfg.accessJsonPath !== "auto") {
    return { accessPath: cfg.accessJsonPath, isAutoDiscovered: false };
  }
  // auto: try project-local install first, then global channel dir.
  // `baseCwd` is the workspace root threaded through from
  // `detectScopeRuntime(config, workspaceRoot)`. Falls back to
  // process.cwd() at the call boundary if no workspace was supplied.
  const home = os.homedir();
  const projectDir = detectWhatsappProjectDir(home, baseCwd, {
    cwdExactMatchOnly: cfg.cwdExactMatchOnly === true,
  });
  if (projectDir) {
    return {
      accessPath: path.join(projectDir, ".whatsapp", "access.json"),
      isAutoDiscovered: true,
    };
  }
  return {
    accessPath: path.join(home, ".claude", "channels", "whatsapp", "access.json"),
    isAutoDiscovered: true,
  };
}

// ---------------------------------------------------------------------------
// Public cache control
// ---------------------------------------------------------------------------

/**
 * Drop the cached detection result so the next `detectScopeRuntime`
 * call runs full detection. Called by the lifecycle file-watcher when
 * `~/.claude/plugins/installed_plugins.json` changes — closes the
 * Phase 4a-1 stale-armed window where a recently-disabled channel
 * could keep its armed adapter for up to RUNTIME_TTL_MS. Adapters
 * themselves live in a separate registry that the next detection
 * pass re-registers from scratch via `registerScopeAdapter` /
 * `unregisterScopeAdapter`, so dropping the cache is sufficient.
 */
export function clearScopeRuntimeCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Test surface
// ---------------------------------------------------------------------------

/** Test-only: clear runtime cache + adapter registry. */
export function _resetRuntimeForTests(): void {
  cached = null;
  _resetRegistryForTests();
}

/** Test-only: peek the cached state without forcing detection. */
export function _peekCachedRuntimeForTests(): ScopeRuntimeState | null {
  return cached?.state ?? null;
}

/**
 * Phase 4a-2.6 — resolve the WhatsApp channel directory (where
 * `access.json` and `messages.db` live) for a given config. Used by
 * the messages.db indexer in `server.ts` to know where to read from.
 * Returns `null` when scope is unset, the channel is `mode: off`, or
 * the access path can't be resolved at all.
 *
 * Mirrors the same `resolveAccessPath` logic the runtime uses
 * internally; exposed to avoid duplicating the auto-discovery path.
 */
export function resolveWhatsappChannelDir(
  config?: AgentConfig,
  workspaceRoot?: string
): string | null {
  const cfg = config?.scope?.whatsapp;
  if (!cfg || cfg.mode === "off") return null;
  const baseCwd = workspaceRoot ?? process.cwd();
  const result = resolveAccessPath(cfg, baseCwd);
  if (!result) return null;
  return path.dirname(result.accessPath);
}

/**
 * Codex round-4 MEDIUM: mode-independent channel-dir discovery for the
 * exec-gate's always-on protected-paths classifier. Unlike
 * `resolveWhatsappChannelDir`, this function:
 *   - Does NOT gate on `mode === "off"` — the protected path must fire
 *     even for read-scope-disabled channels.
 *   - Does NOT require `cfg` to exist — auto-discovers the project-local
 *     install via `detectWhatsappProjectDir` so users with a paired
 *     WhatsApp install but no `scope` block still get governance
 *     protection.
 *
 * Returns the channel-dir (parent of `access.json`) when discoverable,
 * or null. Caller passes the workspace root for `baseCwd` resolution.
 */
export function discoverAllChannelGovernanceDirs(
  config: AgentConfig | undefined,
  workspaceRoot: string
): string[] {
  const out: string[] = [];

  // WhatsApp — only channel with a real adapter today.
  const cfgWa = config?.scope?.whatsapp;
  const baseCwd = workspaceRoot;
  const tryAdd = (cfg: NonNullable<ScopeConfigTree["whatsapp"]>): void => {
    try {
      const result = resolveAccessPath(cfg, baseCwd);
      if (!result) return;
      const dir = path.dirname(result.accessPath);
      // Only protect dirs that actually exist on disk — a bogus
      // accessJsonPath shouldn't contribute a phantom protected root
      // that could confuse the classifier.
      try {
        if (!fs.existsSync(dir)) return;
      } catch {
        return;
      }
      out.push(dir);
    } catch {
      // best-effort
    }
  };

  if (cfgWa) {
    tryAdd(cfgWa);
  } else {
    // No `scope.whatsapp` block at all — try auto-discovery anyway.
    // A paired install at `~/.claude/plugins/claude-whatsapp/...` or
    // project-local still hosts an access.json that's worth protecting.
    tryAdd({});
  }

  // Telegram / Discord / iMessage / WebChat: no auto-discoverable
  // governance file today. When those channels publish access-file
  // contracts, extend this enumeration. Until then, only `accessJsonPath`
  // is honored.

  return Array.from(new Set(out));
}

// Re-export adapter accessor so callers don't need two imports.
export { getScopeAdapter };
