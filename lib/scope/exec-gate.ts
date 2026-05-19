/**
 * Execution-gate resolver — decides whether a PreToolUse tool call
 * should be allowed, blocked, or shadow-logged, based on whether the
 * current Claude Code turn was triggered by a non-owner inbound from
 * a paired messaging-channel plugin (today: claude-whatsapp).
 *
 * Design (post Codex round-5 v5 — envelope-window scan):
 *
 *   1. ALWAYS-ON protected-paths check. For Write/Edit/MultiEdit/
 *      NotebookEdit, refuse writes to a fixed self-protecting list
 *      (hooks, agent-config, scope-trust, ssh, credentials, shell init,
 *      LaunchAgents, etc.). Independent of mode and policy — even
 *      `mode: off` users get this protection.
 *
 *   2. If every channel's `execGate.mode === "off"` AND step 1 didn't
 *      fire → allow. Zero-overhead path for users without opt-in.
 *
 *   3. Per armed channel, scan `<channel-dir>/.request-envelopes/` for
 *      envelope files with `mtime >= now - lookbackMs`. Validate each
 *      with the hardened envelope reader; aggregate "any non-owner
 *      sender present in the lookback window" across all armed channels.
 *
 *   4. If no non-owner envelope present → allow (owner-direct or
 *      only-owner-traffic in window).
 *
 *   5. If non-owner present AND `<channel>-exec` trust file exists for
 *      that channel → allow (user explicitly out-of-band-trusted this
 *      machine for execution of channel-triggered turns).
 *
 *   6. Otherwise: apply per-channel policy. Bash is hard-denied
 *      regardless of `tool_input.command`. Other tools: denylist or
 *      allowlist over `tool_name`. Shadow mode logs but doesn't block.
 *
 * This file is pure-function: the hook script (Phase 7 Step 2) is the
 * only place that touches stdin/stdout/exit-codes. Keeping the resolver
 * pure makes the tier1 surface trivially testable without spawning hooks.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ChannelName } from "../channel-detector.ts";
import type { ScopeConfigTree } from "../config.ts";
import {
  ENVELOPE_DIR_NAME,
  EnvelopeReader,
  type RequestEnvelopePayload,
} from "./envelope.ts";
import {
  classifyProtectedPath,
  extractToolPath,
  type ProtectedPathHit,
} from "./protected-paths.ts";
import { isOwnerTrusted, legacyGlobalTrustExists, type TrustSuffix } from "./trust.ts";
import {
  appendShadowEvent,
  type ShadowEvent,
} from "./exec-gate-shadow-log.ts";

/** Bump on every breaking change to the resolver's decision contract. */
export const EXEC_GATE_HOOK_VERSION = 1;

export const EXEC_GATE_DEFAULT_LOOKBACK_MS = 60_000;

/** Tools the resolver hard-denies regardless of input contents when
 *  armed + non-owner-in-window. Two distinct reasons:
 *   - `Bash`: shell command grammar is too rich to safely parse
 *     (`tee`, `dd of=`, heredocs, process substitution).
 *   - `Task`: spawns a Claude Code subagent. Hook propagation to
 *     subagents is not guaranteed by Claude Code's PreToolUse
 *     contract — if hooks don't fire inside the subagent, every
 *     channel-triggered turn could spawn a subagent that bypasses
 *     the gate entirely. Hard-denying `Task` under armed closes
 *     the bypass unconditionally (Codex Step 2 pre-impl C: don't
 *     defer this to tier3 manual testing). */
export const HARD_DENY_TOOLS_UNDER_ARMED = new Set(["Bash", "Task"]);

/** Default destructive tools blocked by `denylist` policy when armed +
 *  non-owner-in-window. User can override via `execGate.tools`. */
export const DEFAULT_DENYLIST_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // MCP tool names use the prefix from `.mcp.json:mcpServers.<name>`.
  // ClawCode registers as `clawcode`; claude-whatsapp registers as `whatsapp`.
  "mcp__clawcode__agent_config",
  "mcp__clawcode__skill_install",
  "mcp__clawcode__skill_remove",
  "mcp__clawcode__dream",
];

/** Default safe tools allowed by `allowlist` policy when armed +
 *  non-owner-in-window. User can override via `execGate.tools`. */
export const DEFAULT_ALLOWLIST_TOOLS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "mcp__whatsapp__reply",
  "mcp__whatsapp__react",
  "mcp__clawcode__memory_search",
  "mcp__clawcode__memory_get",
  "mcp__clawcode__memory_context",
  "mcp__clawcode__voice_speak",
  "mcp__clawcode__voice_transcribe",
];

export type ExecGateMode = "off" | "shadow" | "enforce";
export type ExecGatePolicy = "denylist" | "allowlist";

export interface ExecGateConfig {
  mode: ExecGateMode;
  policy: ExecGatePolicy;
  tools: string[];
  lookbackMs: number;
}

/** Per-channel armed state passed to the resolver from the hook. */
export interface ArmedChannel {
  channel: ChannelName;
  channelDir: string;
  /** Owner JIDs from `access.json`. Empty array is the bootstrap state. */
  ownerJids: string[];
  /** Effective execGate config for this channel (post-coercion). */
  execGate: ExecGateConfig;
  /**
   * Codex Step 2 post-impl round-1 FAIL A: when a channel is
   * non-off-configured but its governance is unresolvable
   * (`access.json` absent / unreadable / runtime detect threw / config
   * load threw), the entry script sets this flag instead of silently
   * dropping the channel. The resolver then synthesizes a non-owner
   * hit so the gate fires (block under enforce, log under shadow,
   * defer to `<channel>-exec` trust). Without this, an enforce-armed
   * user whose claude-whatsapp install briefly disappeared (uninstall,
   * crash mid-write of access.json, disk hiccup) would silently
   * fall back to "all tools allowed" — re-introducing the fail-open
   * the gate was designed to close.
   */
  unresolved?: boolean;
}

/**
 * Side-effects the resolver invokes. Defaults call the real
 * implementations from `lib/scope/trust.ts` and
 * `lib/scope/exec-gate-shadow-log.ts`. Tests can inject mocks so
 * the resolver is exercised in true pure-function isolation
 * (Codex round-1 BLOCKER 2 fix — resolve() was reading trust files
 * + writing shadow logs through real FS, breaking the "pure" claim).
 */
export interface ResolverEffects {
  /**
   * Phase 8 / 1.7.0: workspace-bound trust check. `workspaceRoot` is the
   * absolute path to the workspace whose fingerprint subdir holds the
   * trust file. Returns true ONLY when the per-workspace marker exists
   * with valid uid/mode/non-symlink/regular-file (matches the resolver's
   * fail-closed posture).
   */
  isOwnerTrusted: (workspaceRoot: string, channel: ChannelName, suffix: TrustSuffix) => boolean;
  /**
   * Diagnostic helper (Codex Phase 8 round-2 Vector 3 + round-3 Q2):
   * returns true ONLY when a pre-1.7.0 legacy direct trust file exists
   * AT THE BASE (no fingerprint subdir) AND would have unlocked under
   * 1.6 semantics. Used to augment the block-reason string when a
   * workspace-scoped trust is absent but a legacy global one is present
   * — so the user sees "legacy global exec trust ignored for this
   * workspace" instead of degrading silently. NEVER consulted to unlock.
   */
  legacyGlobalTrustExists: (channel: ChannelName, suffix: TrustSuffix) => boolean;
  recordShadow: (event: ShadowEvent, logDir: string) => void;
}

export interface ResolverInput {
  toolName: string;
  toolInput: unknown;
  pluginRoot: string;
  workspaceRoot: string;
  /** Absolute path to `<workspace>/memory` (where the shadow log goes). */
  memoryDir: string;
  armed: ArmedChannel[];
  /**
   * Codex round-3 MEDIUM: every configured channel's resolved
   * channel-dir (regardless of `execGate.mode`) so writes to
   * `<channel-dir>/access.json` are refused by the always-on
   * protected-paths check even for mode=off channels.
   *
   * Falls back to `armed[].channelDir` when not provided (legacy
   * callers / tests that don't thread this explicitly).
   */
  protectedChannelDirs?: string[];
  /** Test injection — defaults to `Date.now()`. */
  now?: number;
  /** Test injection — defaults to a fresh `EnvelopeReader`. */
  reader?: EnvelopeReader;
  /** Test injection for fs operations the resolver does directly
   *  (`fs.readdirSync`, `fs.statSync` for the envelope dir scan). */
  fsImpl?: {
    readdirSync: (p: string) => string[];
    statSync: (p: string) => fs.Stats;
  };
  /** Test injection for the trust-file + shadow-log effects. */
  effects?: Partial<ResolverEffects>;
}

export type ResolverDecision =
  | { decision: "allow"; reason?: string }
  | {
      decision: "block";
      reason: string;
      channel?: ChannelName;
      senderHash?: string;
      protectedPath?: ProtectedPathHit;
    }
  | {
      decision: "shadow";
      reason: string;
      channel: ChannelName;
      senderHash: string;
    };

/**
 * Main entry point. Pure function: given the tool name, inputs, and the
 * armed-channel state, decides allow/block/shadow.
 */
export function resolve(input: ResolverInput): ResolverDecision {
  const now = input.now ?? Date.now();
  const reader = input.reader ?? new EnvelopeReader();
  const fsImpl = input.fsImpl ?? {
    readdirSync: (p) => fs.readdirSync(p),
    statSync: (p) => fs.statSync(p),
  };
  const effects: ResolverEffects = {
    isOwnerTrusted: input.effects?.isOwnerTrusted ?? isOwnerTrusted,
    legacyGlobalTrustExists:
      input.effects?.legacyGlobalTrustExists ?? legacyGlobalTrustExists,
    recordShadow:
      input.effects?.recordShadow ??
      ((event, logDir) => {
        try {
          appendShadowEvent(event, { logDir });
        } catch {
          // ignore — shadow log failure is non-fatal
        }
      }),
  };

  // Step 1: ALWAYS-ON protected-paths check (mode-independent).
  //
  // Codex round-2 MEDIUM + round-3 MEDIUM: pass channel-dirs into the
  // classifier so `<channel-dir>/access.json` is protected. Prefer
  // `protectedChannelDirs` (entry threads ALL configured channels
  // regardless of execGate.mode); fall back to `armed[].channelDir`
  // for backward compatibility with callers that don't thread the
  // explicit list.
  const toolPath = extractToolPath(input.toolName, input.toolInput);
  if (toolPath !== null) {
    const armedDirs = input.armed
      .map((a) => a.channelDir)
      .filter((d) => typeof d === "string" && d.length > 0);
    const explicit = (input.protectedChannelDirs ?? []).filter(
      (d) => typeof d === "string" && d.length > 0
    );
    // Dedupe while preserving order — armedDirs first (mode != off) then
    // explicit additions. realpath canonicalization happens inside the
    // classifier so two paths that point to the same inode collapse.
    const channelDirs = Array.from(new Set([...armedDirs, ...explicit]));
    const hit = classifyProtectedPath(toolPath, {
      pluginRoot: input.pluginRoot,
      workspaceRoot: input.workspaceRoot,
      channelDirs,
    });
    if (hit) {
      // Codex Phase 8 post-impl LOW: surface a recovery hint for the two
      // most-commonly-hit reasons during legitimate setup flows. Without
      // the hint, agents retry `Write` and produce the same block.
      let hint = "";
      if (hit.reason === "workspace-agent-config") {
        hint =
          " — use the Bash heredoc + JSON.parse + atomic tmp/mv pattern for user-driven setup; see AGENTS.md.";
      } else if (hit.reason === "channel-access-json") {
        hint =
          " — use the channel skill's Bash heredoc + JSON.parse + chmod 600 + atomic mv pattern; see its 'How to save' reference.";
      }
      return {
        decision: "block",
        reason: `exec-gate: write to protected path refused (${hit.reason})${hint}`,
        protectedPath: hit,
      };
    }
  }

  // Step 2: Mode short-circuit. If every channel is off → allow.
  const armedNonOff = input.armed.filter((c) => c.execGate.mode !== "off");
  if (armedNonOff.length === 0) {
    return { decision: "allow" };
  }

  // Step 3: Per armed channel, scan envelopes in window. Track
  //         non-owner presence PER channel — Codex round-1 BLOCKER 1
  //         fix: if WA is shadow and Telegram is enforce, and both
  //         have non-owner envelopes, the enforce channel must win
  //         (not the first one encountered).
  interface NonOwnerHit {
    armed: ArmedChannel;
    senderId: string;
    envelopeCount: number;
  }
  const nonOwnerHits: NonOwnerHit[] = [];

  for (const armed of armedNonOff) {
    // Codex Step 2 post-impl round-1 FAIL A: governance unresolvable
    // → fail-closed by injecting a synthetic non-owner hit. Sender is
    // a stable sentinel string so the resulting hash is informational
    // ("the gate fired because we couldn't verify owner status") and
    // never leaks a real JID into stderr/shadow logs.
    if (armed.unresolved) {
      nonOwnerHits.push({
        armed,
        senderId: `__unresolved__:${armed.channel}`,
        envelopeCount: 0,
      });
      continue;
    }
    const envelopes = scanEnvelopeWindow(
      armed.channelDir,
      armed.execGate.lookbackMs,
      now,
      reader,
      fsImpl
    );
    let firstNonOwnerSender: string | null = null;
    let count = 0;
    for (const env of envelopes) {
      if (!armed.ownerJids.includes(env.senderId)) {
        if (firstNonOwnerSender === null) firstNonOwnerSender = env.senderId;
        count++;
      }
    }
    if (firstNonOwnerSender !== null) {
      nonOwnerHits.push({ armed, senderId: firstNonOwnerSender, envelopeCount: count });
    }
  }

  // Step 4: No non-owner envelope present → allow.
  if (nonOwnerHits.length === 0) {
    return { decision: "allow" };
  }

  // Step 5: For each hit, check if the channel's <channel>-exec trust file
  //         unlocks it. A channel with trust drops out of the aggregation.
  //         Phase 8 / 1.7.0: trust is now workspace-bound — `input.workspaceRoot`
  //         scopes the trust lookup to this workspace's fingerprint subdir.
  const effectiveHits = nonOwnerHits.filter(
    (h) => !effects.isOwnerTrusted(input.workspaceRoot, h.armed.channel, "exec")
  );
  if (effectiveHits.length === 0) {
    return { decision: "allow" };
  }

  // Step 6: Apply MOST-RESTRICTIVE policy aggregation. enforce > shadow.
  //         Within enforce: pick the FIRST hit whose tools-list would
  //         block this tool call. Within shadow: pick the FIRST hit
  //         whose policy would would-block. If neither mode blocks
  //         this specific tool, allow.
  const inHardDeny = HARD_DENY_TOOLS_UNDER_ARMED.has(input.toolName);

  function wouldBlockUnder(h: NonOwnerHit): boolean {
    if (inHardDeny) return true;
    if (h.armed.execGate.policy === "denylist") {
      return h.armed.execGate.tools.includes(input.toolName);
    }
    // allowlist
    return !h.armed.execGate.tools.includes(input.toolName);
  }

  // Try enforce hits first.
  const enforceHits = effectiveHits.filter((h) => h.armed.execGate.mode === "enforce");
  for (const h of enforceHits) {
    if (wouldBlockUnder(h)) {
      const senderHash = shortHash(h.senderId);
      // Codex Phase 8 round-2 Vector 3: when the workspace-scoped trust
      // is missing AND a valid legacy global one exists, augment the
      // reason string so the user sees the migration hint instead of
      // a silent degradation.
      const legacy = effects.legacyGlobalTrustExists(h.armed.channel, "exec");
      const suffix = legacy
        ? "; legacy global exec trust ignored for this workspace — run /agent:scope wizard to re-grant"
        : "";
      return {
        decision: "block",
        reason: `exec-gate: ${input.toolName} blocked for non-owner inbound in window (${h.armed.channel}:${senderHash})${suffix}`,
        channel: h.armed.channel,
        senderHash,
      };
    }
  }

  // Then shadow hits.
  const shadowHits = effectiveHits.filter((h) => h.armed.execGate.mode === "shadow");
  for (const h of shadowHits) {
    if (wouldBlockUnder(h)) {
      const senderHash = shortHash(h.senderId);
      // Codex Phase 8 round-1 MEDIUM: surface the legacy-trust diagnostic
      // in shadow mode too. A 1.6 user with a global exec-trust file who
      // upgrades to 1.7+ and runs in shadow would otherwise see "shadow:
      // would block" events with no explanation that exec trust would
      // have unlocked under 1.6 but doesn't anymore.
      const legacyIgnored = effects.legacyGlobalTrustExists(
        h.armed.channel,
        "exec"
      );
      const event: ShadowEvent = {
        ts: new Date(now).toISOString(),
        channel: h.armed.channel,
        senderHash,
        toolName: input.toolName,
        decision: "would-block",
        effectiveMode: "shadow",
        policy: h.armed.execGate.policy,
        expandedTools: [...h.armed.execGate.tools],
        hookVersion: EXEC_GATE_HOOK_VERSION,
        configHash: configHash(h.armed.execGate),
        lookbackMs: h.armed.execGate.lookbackMs,
        windowEnvelopeCount: h.envelopeCount,
        legacyGlobalExecTrustIgnored: legacyIgnored,
      };
      effects.recordShadow(event, input.memoryDir);
      const suffix = legacyIgnored
        ? "; legacy global exec trust ignored for this workspace — run /agent:scope wizard to re-grant"
        : "";
      return {
        decision: "shadow",
        reason: `exec-gate (shadow): ${input.toolName} would block for non-owner inbound in window (${h.armed.channel}:${senderHash})${suffix}`,
        channel: h.armed.channel,
        senderHash,
      };
    }
  }

  // No channel's policy actually blocks this tool name. Allow.
  return { decision: "allow" };
}

/**
 * Scan a channel's `.request-envelopes/` dir for files with mtime in the
 * lookback window. Validates each with the hardened envelope reader;
 * silently skips any that fail (corrupt, symlinked, expired, etc.).
 *
 * Returns the deduped payload list (one per token; the reader's LRU
 * naturally dedupes).
 */
function scanEnvelopeWindow(
  channelDir: string,
  lookbackMs: number,
  now: number,
  reader: EnvelopeReader,
  fsImpl: NonNullable<ResolverInput["fsImpl"]>
): RequestEnvelopePayload[] {
  const envelopeDir = path.join(channelDir, ENVELOPE_DIR_NAME);
  let entries: string[];
  try {
    entries = fsImpl.readdirSync(envelopeDir);
  } catch {
    return [];
  }

  const cutoff = now - lookbackMs;
  const out: RequestEnvelopePayload[] = [];

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const token = name.slice(0, -5);
    // The reader will TOKEN_REGEX-validate; we pre-filter mtime here to
    // avoid loading payloads outside the window.
    let st: fs.Stats;
    try {
      st = fsImpl.statSync(path.join(envelopeDir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) continue;

    const payload = reader.load(channelDir, token, now);
    if (payload) out.push(payload);
  }

  return out;
}

/** 8-hex-char SHA-256 prefix of the senderId. Same pattern as
 *  `scope-denied:` so we don't leak raw JIDs into hook stderr or shadow
 *  logs. */
function shortHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/** Stable hash over the execGate config block. Lets shadow-log reviewers
 *  detect silent config drift between when an event was recorded and
 *  when enforce mode actually gets flipped. */
function configHash(cfg: ExecGateConfig): string {
  const stable = JSON.stringify({
    mode: cfg.mode,
    policy: cfg.policy,
    tools: [...cfg.tools].sort(),
    lookbackMs: cfg.lookbackMs,
  });
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

/**
 * Coerce a raw config tree's `execGate` block to a strictly-typed
 * `ExecGateConfig`. Invalid values fall back to a conservative
 * default (enforce + denylist + default tools + 60s window) — NOT
 * to `off`. This is the explicit "fail-closed on malformed config"
 * rule from the plan.
 */
export function coerceExecGateConfig(raw: unknown): ExecGateConfig {
  const enforceFallback: ExecGateConfig = {
    mode: "enforce",
    policy: "denylist",
    tools: [...DEFAULT_DENYLIST_TOOLS],
    lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
  };

  // Strict undefined → off. The user simply didn't configure the gate.
  // This is the legitimate "no opt-in" path.
  if (raw === undefined) {
    return {
      mode: "off",
      policy: "denylist",
      tools: [...DEFAULT_DENYLIST_TOOLS],
      lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
    };
  }

  // null / non-object / array — malformed at the BLOCK level. User
  // configured SOMETHING but it's not parseable. Fail-closed
  // (escalate the whole block to enforce + denylist).
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return enforceFallback;
  }

  const r = raw as Record<string, unknown>;
  let invalid = false;

  let mode: ExecGateMode;
  if (r.mode === "off" || r.mode === "shadow" || r.mode === "enforce") {
    mode = r.mode;
  } else if (r.mode === undefined) {
    mode = "off";
  } else {
    invalid = true;
    mode = enforceFallback.mode;
  }

  let policy: ExecGatePolicy;
  if (r.policy === "denylist" || r.policy === "allowlist") {
    policy = r.policy;
  } else if (r.policy === undefined) {
    policy = "denylist";
  } else {
    invalid = true;
    policy = enforceFallback.policy;
  }

  let tools: string[];
  if (Array.isArray(r.tools)) {
    // Codex round-1 WARN 4: empty array ≠ "no tools blocked". Empty
    // means user accidentally cleared the list; treat as not-provided
    // (falls back to defaults). Same defense as the v8 privileged-keys
    // pattern: missing intent shouldn't open the gate.
    if (r.tools.length === 0) {
      tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
    } else {
      const cleaned = r.tools.filter((x): x is string => typeof x === "string");
      if (cleaned.length === r.tools.length) {
        tools = cleaned;
      } else {
        invalid = true;
        tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
      }
    }
  } else if (r.tools === undefined) {
    tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
  } else {
    invalid = true;
    tools = policy === "allowlist" ? [...DEFAULT_ALLOWLIST_TOOLS] : [...DEFAULT_DENYLIST_TOOLS];
  }

  let lookbackMs: number;
  // Codex round-3 LOW 2: TS+jq agreement requires symmetric upper
  // bound. 9e12 ms ≈ 285 years — well past any plausible legitimate
  // lookback. Anything larger likely indicates a hostile/garbage value.
  const LOOKBACK_MS_MAX = 9_000_000_000_000;
  if (
    typeof r.lookbackMs === "number" &&
    Number.isFinite(r.lookbackMs) &&
    r.lookbackMs > 0 &&
    r.lookbackMs < LOOKBACK_MS_MAX
  ) {
    lookbackMs = Math.floor(r.lookbackMs);
  } else if (r.lookbackMs === undefined) {
    lookbackMs = EXEC_GATE_DEFAULT_LOOKBACK_MS;
  } else {
    invalid = true;
    lookbackMs = EXEC_GATE_DEFAULT_LOOKBACK_MS;
  }

  if (invalid) {
    // When any individual field was bad, escalate the whole block to
    // the conservative fallback (enforce). User explicitly configured
    // SOMETHING — we just can't tell what, so fail closed.
    return enforceFallback;
  }

  return { mode, policy, tools, lookbackMs };
}

/**
 * Pull the per-channel exec-gate config out of a parsed ScopeConfigTree.
 * Convenience for the hook script + wizard status display. Always
 * returns the coerced shape, never undefined.
 */
export function execGateConfigForChannel(
  scope: ScopeConfigTree | undefined,
  channel: ChannelName
): ExecGateConfig {
  const channelCfg = scope?.[channel];
  const raw = (channelCfg as { execGate?: unknown } | undefined)?.execGate;
  return coerceExecGateConfig(raw);
}
