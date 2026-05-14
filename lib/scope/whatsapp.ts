/**
 * WhatsApp scope adapter — Phase 4a-2.5 (post adversarial Codex review).
 *
 * Mirrors `claude-whatsapp/scope.ts`'s `resolveScope` /
 * `scopedAllowedChats` semantics for governance state read from
 * `<channel-dir>/access.json` (state contract is stable per
 * `claude-whatsapp/docs/state-contract.md`).
 *
 * **Phase 4a-2.5 owner-unlock primitive**: `config.scope.whatsapp.identity`.
 * Setting it to `"owner"` (typically via `/agent:scope wizard`) unlocks
 * `'all'` for foreground calls without requiring `WHATSAPP_OWNER_BYPASS=1`
 * to be set in the shell. It is a declarative, persistent, per-machine
 * config — not an ephemeral signal — so it is not subject to the
 * "freshness ≠ identity" hazard Codex flagged on the original marker
 * design. `"guest"` explicitly returns `[]` (deny) for foreground; `"auto"`
 * defers to the env-var bypass / bootstrap / background path.
 *
 * **Marker file (`.last-inbound.json`) is read but not authoritative.**
 * Upstream (`claude-whatsapp` ≥ marker writer release) atomically publishes
 * a per-inbound marker. Codex post-impl review flagged that consuming the
 * marker for owner-unlock conflates "freshness within TTL" with "this MCP
 * call is bound to that inbound" — the OpenCLAUDE process handles foreground
 * calls from many sources (terminal-launched Claude Code, scripted
 * `claude -p`, WA-routed reply chains), and the marker alone cannot tell
 * which source made the current call. Therefore `loadInboundContext` stays
 * exported (with full hardening) so a future Phase 4a-2.5b can wire it once
 * upstream `claude-whatsapp` adds an env-var nonce on each WA-routed
 * `claude -p` spawn — but `allowedChatIds` does NOT consult it for
 * unlock today.
 *
 * **Phase 4a-2.5 still has a chat_id gap.** Chunks indexed before Phase
 * 4a-2.6 carry `sourceChatId === null`. Owner unlock via `identity` returns
 * `null` and `canSee` returns `true` regardless of chat_id, so the lift
 * works for owners. Per-chat enforcement for non-owner DM/group senders
 * waits for Phase 4a-2.5b (marker + env nonce) AND Phase 4a-2.6 (`messages.db`
 * indexer fills `source_chat_id`).
 *
 * Hardening notes for `loadInboundContext`: opens with `O_NOFOLLOW` (Linux/macOS;
 * skipped on Windows), rejects non-regular files, rejects mode bits that grant
 * group/world access, rejects markers owned by a UID other than the current
 * process, rejects `ts` more than `CLOCK_SKEW_MS` in the future. Cached by
 * mtimeMs+size+ino+uid+mode signature. NO last-known-good (a stale identity
 * claim would be a privilege-escalation hazard, unlike `access.json` LKG).
 */

import fs from "node:fs";
import path from "node:path";
import type { ScopeAdapter } from "./index.ts";
import type { ChunkProvenance } from "./provenance.ts";
import type { ScopeContext } from "./context.ts";
import { isOwnerTrusted } from "./trust.ts";

// ---------------------------------------------------------------------------
// access.json shape (forward-compat — tolerates unknown fields)
// ---------------------------------------------------------------------------

export type HistoryScope = "own" | "all" | string[];

export interface WhatsappAccessFile {
  ownerJids: string[];
  allowFrom: string[];
  groups: Record<string, { historyScope?: HistoryScope }>;
  dms: Record<string, { historyScope?: HistoryScope }>;
}

/** Same defaults claude-whatsapp's `loadAccess()` falls back to. */
function defaultAccess(): WhatsappAccessFile {
  return { ownerJids: [], allowFrom: [], groups: {}, dms: {} };
}

/**
 * Result of `normalizeAccess`. `hasOwnerJidsField` distinguishes a
 * legitimate `ownerJids: []` (intentional bootstrap mode) from a
 * malformed `access.json` that simply lacks the field — Codex post-
 * impl HIGH 3 fix. The two used to be conflated, so a malformed shape
 * could silently grant bootstrap fail-open.
 */
export interface NormalizedAccess {
  access: WhatsappAccessFile;
  hasOwnerJidsField: boolean;
}

/**
 * Defensive normalization. Mirrors `loadAccess()` in
 * `claude-whatsapp/server.ts:584-605`. Accepts `null`/missing array
 * fields, ignores unknown top-level fields. Phase 1 OQ-3 closure.
 *
 * Returns the raw `WhatsappAccessFile` for backward compatibility
 * with existing callers (loadAccess test fixtures, etc).
 * `normalizeAccessWithMeta` is the new entry that surfaces the
 * `hasOwnerJidsField` flag for the runtime path.
 */
export function normalizeAccess(raw: unknown): WhatsappAccessFile {
  return normalizeAccessWithMeta(raw).access;
}

export function normalizeAccessWithMeta(raw: unknown): NormalizedAccess {
  const out = defaultAccess();
  if (!raw || typeof raw !== "object") {
    return { access: out, hasOwnerJidsField: false };
  }
  const r = raw as Record<string, unknown>;
  const hasOwnerJidsField =
    Object.prototype.hasOwnProperty.call(r, "ownerJids") &&
    Array.isArray(r.ownerJids);
  if (Array.isArray(r.ownerJids))
    out.ownerJids = r.ownerJids.filter((s) => typeof s === "string") as string[];
  if (Array.isArray(r.allowFrom))
    out.allowFrom = r.allowFrom.filter((s) => typeof s === "string") as string[];
  if (r.groups && typeof r.groups === "object") {
    for (const [k, v] of Object.entries(r.groups as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const g = v as Record<string, unknown>;
      out.groups[k] = {};
      if (Array.isArray(g.historyScope)) {
        out.groups[k].historyScope = g.historyScope.filter(
          (s) => typeof s === "string"
        ) as string[];
      } else if (g.historyScope === "own" || g.historyScope === "all") {
        out.groups[k].historyScope = g.historyScope;
      }
    }
  }
  if (r.dms && typeof r.dms === "object") {
    for (const [k, v] of Object.entries(r.dms as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      out.dms[k] = {};
      if (Array.isArray(d.historyScope)) {
        out.dms[k].historyScope = d.historyScope.filter(
          (s) => typeof s === "string"
        ) as string[];
      } else if (d.historyScope === "own" || d.historyScope === "all") {
        out.dms[k].historyScope = d.historyScope;
      }
    }
  }
  return { access: out, hasOwnerJidsField };
}

// ---------------------------------------------------------------------------
// access.json loader with cache + last-known-good
// ---------------------------------------------------------------------------

interface AccessCacheEntry {
  access: WhatsappAccessFile;
  /** Codex post-impl HIGH 3: distinguishes intentional `[]` from missing field. */
  hasOwnerJidsField: boolean;
  /** mtimeMs+size+ino at the time of cache. */
  signature: { mtimeMs: number; size: number; ino: number };
  /** True when the most recent parse failed and we're using LKG. */
  staleParseFailure: boolean;
  /**
   * Codex P1 (Phase 3 review): Date.now() of the first stat failure
   * AFTER a successful load. Bounds how long we keep returning the
   * LKG when the file has disappeared. Cleared on the next
   * successful stat. Undefined while the file is healthy.
   */
  missingSince?: number;
}

/**
 * Maximum time we keep serving a last-known-good `access.json`
 * after it disappears from disk. Beyond this grace, the loader
 * returns `resolvable: false` so the runtime can disarm the
 * channel — better than running enforcement against governance
 * that no longer exists.
 *
 * 5 minutes balances "transient race during atomic save" (a few ms
 * window where rename can briefly leave the file invisible to
 * another process) against "user uninstalled claude-whatsapp and
 * we shouldn't act like nothing changed for hours".
 */
const MISSING_GRACE_MS = 5 * 60 * 1000;

/**
 * Read + parse `access.json` with cache + last-known-good fallback.
 *
 * Returns `null` when the file is missing AND we have no LKG —
 * caller treats that as "governance unresolvable" → adapter not
 * armed.
 */
export function loadAccess(
  accessPath: string,
  cache: Map<string, AccessCacheEntry>
): {
  access: WhatsappAccessFile | null;
  /** Codex post-impl HIGH 3 surface for the runtime path. */
  hasOwnerJidsField: boolean;
  resolvable: boolean;
  lastKnownGood: boolean;
} {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(accessPath);
  } catch {
    const cached = cache.get(accessPath);
    if (!cached) {
      return {
        access: null,
        hasOwnerJidsField: false,
        resolvable: false,
        lastKnownGood: false,
      };
    }
    // Codex P1 fix: bound how long we serve the LKG after the file
    // disappears. Set `missingSince` on the first miss; after
    // MISSING_GRACE_MS, give up and return unresolvable so the
    // runtime can disarm the channel.
    const now = Date.now();
    const missingSince = cached.missingSince ?? now;
    if (now - missingSince >= MISSING_GRACE_MS) {
      return {
        access: null,
        hasOwnerJidsField: false,
        resolvable: false,
        lastKnownGood: false,
      };
    }
    if (cached.missingSince === undefined) {
      cache.set(accessPath, { ...cached, missingSince: now });
    }
    return {
      access: cached.access,
      hasOwnerJidsField: cached.hasOwnerJidsField,
      resolvable: true,
      lastKnownGood: true,
    };
  }

  const cached = cache.get(accessPath);
  if (
    cached &&
    cached.signature.mtimeMs === stat.mtimeMs &&
    cached.signature.size === stat.size &&
    cached.signature.ino === stat.ino &&
    !cached.staleParseFailure
  ) {
    // Successful stat — clear any missingSince watermark so a later
    // disappearance starts a fresh grace window.
    if (cached.missingSince !== undefined) {
      cache.set(accessPath, { ...cached, missingSince: undefined });
    }
    return {
      access: cached.access,
      hasOwnerJidsField: cached.hasOwnerJidsField,
      resolvable: true,
      lastKnownGood: false,
    };
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(accessPath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    if (cached) {
      // Parse failed — keep the prior good value, mark stale so we
      // retry on the next mtime change.
      cache.set(accessPath, { ...cached, staleParseFailure: true });
      return {
        access: cached.access,
        hasOwnerJidsField: cached.hasOwnerJidsField,
        resolvable: true,
        lastKnownGood: true,
      };
    }
    return {
      access: null,
      hasOwnerJidsField: false,
      resolvable: false,
      lastKnownGood: false,
    };
  }

  const { access, hasOwnerJidsField } = normalizeAccessWithMeta(parsed);
  cache.set(accessPath, {
    access,
    hasOwnerJidsField,
    signature: { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
    staleParseFailure: false,
  });
  return { access, hasOwnerJidsField, resolvable: true, lastKnownGood: false };
}

// ---------------------------------------------------------------------------
// Inbound marker loader (.last-inbound.json) — Phase 4a-2.5
//
// Mirrors the contract in `claude-whatsapp/marker.ts`. Stricter than
// `loadAccess` in two ways:
//   (1) NO last-known-good — a stale marker would be a privilege-
//       escalation hazard, since `senderId` claims identity.
//   (2) The in-payload `ts` is checked against the TTL on every call,
//       even when the file signature hasn't changed; future-dated `ts`
//       beyond CLOCK_SKEW_MS are rejected (Codex post-impl HIGH 2).
//
// Hardening (Codex post-impl HIGH 2):
//   - Open with O_NOFOLLOW where supported (POSIX) so a symlink swap
//     cannot redirect us to an attacker-controlled file.
//   - fstat the open fd (not lstat → readFile separately), then read
//     through the same fd so identity-of-stat-target == identity-of-
//     read-target.
//   - Reject non-regular files (FIFOs, sockets, dirs).
//   - Reject group/world readable+writable bits (`mode & 0o077`),
//     mirroring the `0o600` perms upstream's writer uses.
//   - Reject when `stat.uid !== process.getuid()` (Linux/macOS; Windows
//     reports uid 0 universally so this skips on win32).
//
// Currently NOT consumed by `allowedChatIds` (Codex post-impl HIGH 1):
// freshness within TTL does not prove the current MCP call is bound to
// the recorded inbound. Reader stays exported as future infra; callers
// must combine this with a per-spawn nonce (Phase 4a-2.5b) before
// granting unlock based on `senderId`.
// ---------------------------------------------------------------------------

export const MARKER_FILENAME = ".last-inbound.json";
export const MARKER_VERSION = 1;
export const MARKER_TTL_MS = 60_000;
/**
 * Maximum tolerated clock skew between the writer (claude-whatsapp's
 * process) and reader (this process). 5s catches typical NTP jitter
 * without leaving a meaningful future-dated marker as a long-lived
 * unlock. Codex post-impl HIGH 2 fix.
 */
export const CLOCK_SKEW_MS = 5_000;

export interface InboundContext {
  chatId: string;
  senderId: string;
  ts: number;
}

interface InboundCacheEntry {
  inbound: InboundContext;
  signature: {
    mtimeMs: number;
    size: number;
    ino: number;
    uid: number;
    mode: number;
  };
}

/**
 * Cross-platform "is the stat owner the running process". Returns
 * `true` on Windows where uid is meaningless. Codex post-impl HIGH 2.
 */
function ownerMatchesProcess(uid: number): boolean {
  if (process.platform === "win32") return true;
  const pUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (typeof pUid !== "number") return true; // unknown env — don't gate on uid
  return uid === pUid;
}

/**
 * Read + validate `<channelDir>/.last-inbound.json`. Returns null on
 * any failure mode (missing, partial write, parse error, version
 * mismatch, missing fields, non-finite ts, expired by TTL, future
 * ts beyond clock skew, symlink, non-regular file, wrong owner,
 * permissive mode bits).
 *
 * Codex post-impl HIGH 1: this loader is NOT consumed for unlock by
 * `allowedChatIds` — see the file-level docstring. Owner unlock is
 * delivered via `config.scope.whatsapp.identity = "owner"` instead.
 */
export function loadInboundContext(
  channelDir: string,
  cache: Map<string, InboundCacheEntry>,
  now: number = Date.now()
): InboundContext | null {
  const markerPath = path.join(channelDir, MARKER_FILENAME);

  // Codex HIGH 2 (1st pass): open through a single fd with O_NOFOLLOW
  // where supported. Read + stat are then guaranteed to refer to the
  // same inode the open succeeded on, closing the lstat→read TOCTOU.
  // Codex HIGH 2 (2nd pass): also include O_NONBLOCK so a FIFO planted
  // at the marker path can't make `openSync` block waiting for a
  // writer (which would hang every memory_search/get path that
  // invokes `loadInboundContext` for cache-eviction side effects).
  const NOFOLLOW =
    typeof (fs.constants as Record<string, number>).O_NOFOLLOW === "number"
      ? (fs.constants as Record<string, number>).O_NOFOLLOW
      : 0;
  const NONBLOCK =
    typeof (fs.constants as Record<string, number>).O_NONBLOCK === "number"
      ? (fs.constants as Record<string, number>).O_NONBLOCK
      : 0;
  const flags = fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK;

  // Pre-open lstat fast reject so a non-regular file is rejected
  // before openSync. With O_NONBLOCK this is belt-and-suspenders —
  // the open won't hang either way — but fail-fast is cheaper than
  // an open+fstat round trip on the unhappy path.
  try {
    const lst = fs.lstatSync(markerPath);
    if (!lst.isFile()) {
      cache.delete(markerPath);
      return null;
    }
  } catch {
    cache.delete(markerPath);
    return null;
  }

  let fd: number;
  try {
    fd = fs.openSync(markerPath, flags);
  } catch {
    cache.delete(markerPath);
    return null;
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (!ownerMatchesProcess(stat.uid)) return null;
    // Reject any group/world bit. Upstream writes 0o600. Even
    // 0o644 here would be suspicious — could mean the file was
    // copied from elsewhere or tampered.
    if ((stat.mode & 0o077) !== 0) return null;

    const signature = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      ino: stat.ino,
      uid: stat.uid,
      mode: stat.mode,
    };
    const cached = cache.get(markerPath);
    if (
      cached &&
      cached.signature.mtimeMs === signature.mtimeMs &&
      cached.signature.size === signature.size &&
      cached.signature.ino === signature.ino &&
      cached.signature.uid === signature.uid &&
      cached.signature.mode === signature.mode
    ) {
      if (
        now - cached.inbound.ts > MARKER_TTL_MS ||
        cached.inbound.ts > now + CLOCK_SKEW_MS
      ) {
        // Same file, but ts is out of bounds (aged or future-dated).
        // Don't drop cache: a future rewrite will change the signature.
        return null;
      }
      return cached.inbound;
    }

    // Cap read at MAX_MARKER_BYTES to prevent a swap-to-huge-file DoS.
    const MAX_MARKER_BYTES = 4096;
    const cap = Math.min(stat.size, MAX_MARKER_BYTES);
    const buf = Buffer.alloc(cap);
    const read = fs.readSync(fd, buf, 0, cap, 0);

    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.subarray(0, read).toString("utf8"));
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") return null;
    const o = parsed as Record<string, unknown>;
    if (o.version !== MARKER_VERSION) return null;
    if (typeof o.chatId !== "string" || !o.chatId) return null;
    if (typeof o.senderId !== "string" || !o.senderId) return null;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return null;
    if (now - o.ts > MARKER_TTL_MS) return null;
    // Codex HIGH 2: reject future-dated markers beyond clock skew.
    if (o.ts > now + CLOCK_SKEW_MS) return null;

    const inbound: InboundContext = {
      chatId: o.chatId,
      senderId: o.senderId,
      ts: o.ts,
    };
    cache.set(markerPath, { inbound, signature });
    return inbound;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export type ConfiguredIdentity = "auto" | "owner" | "guest";

export interface WhatsappAdapterOptions {
  /** Absolute path to `access.json`. Resolved by runtime detection. */
  accessPath: string;
  /**
   * `config.scope.whatsapp.identity` — declarative per-machine owner
   * proof. `"owner"` unlocks `'all'` for foreground calls without
   * needing the `WHATSAPP_OWNER_BYPASS=1` env var. `"guest"` denies
   * foreground (explicit non-owner posture). `"auto"` (default) keeps
   * the Phase 3 ceiling — env bypass / bootstrap / system-owner are
   * the only unlock paths.
   *
   * This is the Phase 4a-2.5 owner-unlock primitive (post Codex
   * post-impl review). The marker file is NOT consulted for unlock
   * because freshness within TTL doesn't bind a marker to the
   * current MCP request.
   */
  configuredIdentity?: ConfiguredIdentity;
  /**
   * Codex 3rd-pass CRITICAL 2: true when `accessPath` came from
   * runtime auto-discovery of an upstream `claude-whatsapp` install
   * (the canonical `<project>/.whatsapp/access.json` or
   * `~/.claude/channels/whatsapp/access.json` paths). False when the
   * user (or a prompt-injected agent) supplied a custom path via
   * `config.scope.whatsapp.accessJsonPath`. When false, bootstrap
   * fail-open (`ownerJids === []`) is NOT honored — the unlock
   * requires the trust file even in the bootstrap branch — so an
   * attacker can't point us at a writable file with forged contents.
   */
  isAutoDiscovered?: boolean;
}

/**
 * Build a WhatsApp adapter. Returns `null` when access.json isn't
 * resolvable — caller marks the channel disarmed.
 */
export function createWhatsappAdapter(
  options: WhatsappAdapterOptions
): ScopeAdapter | null {
  const accessCache = new Map<string, AccessCacheEntry>();
  const inboundCache = new Map<string, InboundCacheEntry>();
  const channelDir = path.dirname(options.accessPath);
  const configuredIdentity: ConfiguredIdentity =
    options.configuredIdentity ?? "auto";
  const isAutoDiscovered = options.isAutoDiscovered ?? false;

  // Initial load — if it fails, the adapter is not armed.
  const probe = loadAccess(options.accessPath, accessCache);
  if (!probe.resolvable) return null;

  const adapter: ScopeAdapter = {
    channel: "whatsapp",
    /**
     * Per-chunk granularity stays off. canSee uses the same
     * allowedChatIds bulk decision; per-chunk would only be needed
     * if we wanted to apply different rules per provenance sub-
     * class (e.g. legacy_unprovenanced extras), which we don't.
     */
    requiresPerChunkCheck: false,

    canSee(provenance: ChunkProvenance, context: ScopeContext): boolean {
      // Non-channel chunks are not the WA adapter's concern.
      if (provenance.class.kind !== "channel") return true;
      if (provenance.class.sourceChannel !== "whatsapp") return true;
      const allowed = adapter.allowedChatIds(context);
      if (allowed === null) return true;
      if (allowed.length === 0) return false;
      // With per-chunk granularity disabled and an explicit allowlist
      // present, deny unless the chunk has a known chat_id IN the list.
      // Phase 4a-2.5 chunks still have sourceChatId === null until
      // the Phase 4a-2.6 messages.db indexer lands; documented gap.
      if (provenance.sourceChatId === null) return false;
      return allowed.includes(provenance.sourceChatId);
    },

    allowedChatIds(context: ScopeContext): string[] | null {
      const { access, hasOwnerJidsField } = loadAccess(
        options.accessPath,
        accessCache
      );
      if (!access) return []; // governance dropped mid-session — fail closed
      // Marker is read for hardening side-effects only (cache eviction
      // on disappearance, future infra). NOT consumed for the unlock
      // decision — see file docstring + Codex post-impl HIGH 1.
      void loadInboundContext(channelDir, inboundCache);
      return resolveAllowed(
        context,
        access,
        hasOwnerJidsField,
        configuredIdentity,
        // Codex post-impl 2nd-pass CRITICAL: out-of-band trust file
        // gates the `identity = "owner"` (and background system-owner)
        // unlocks so the agent can't escalate via agent_config alone.
        isOwnerTrusted("whatsapp"),
        // Codex 3rd-pass CRITICAL 2: bootstrap fail-open only honored
        // for auto-discovered upstream paths.
        isAutoDiscovered
      );
    },
  };

  return adapter;
}

/**
 * Compute the allowed-chats list for a given context.
 *
 * Resolution order (Phase 4a-2.5 v3, post Codex 2nd-pass review):
 *   1. `WHATSAPP_OWNER_BYPASS=1` env (foreground only) → null.
 *      (Out-of-band proof — the agent can't set this in-process.)
 *   2. Foreground `configuredIdentity = "guest"` → []. Explicit deny
 *      WINS over bootstrap (Codex 2nd-pass HIGH 3 fix).
 *   3. Background context → `identity` decides ('system-owner' AND
 *      trust file → null, otherwise []). Background `deny` (default)
 *      wins over bootstrap (Codex 2nd-pass HIGH 3).
 *   4. `hasOwnerJidsField = false` → governance malformed, fail closed
 *      (Codex 2nd-pass HIGH 3 — distinguishes intentional `[]` from a
 *      missing/invalid `ownerJids` field).
 *   5. Bootstrap (`ownerJids === []` AND field WAS present) → null.
 *      Mirrors upstream's intentional fail-open before owner pairing.
 *   6. Foreground `configuredIdentity = "owner"` AND trust file → null.
 *      Out-of-band trust file is the Codex 2nd-pass CRITICAL fix —
 *      `agent_config` alone (which the agent can call) cannot escalate.
 *   7. Foreground "auto" or "owner-without-trust-file" → [] (Phase 3
 *      ceiling). User must set `WHATSAPP_OWNER_BYPASS=1` or run the
 *      wizard which both writes the config and creates the trust file
 *      via `Bash` (user permission gate).
 *
 * The inbound marker file is NOT consulted here: per Codex 1st-pass
 * HIGH 1, freshness within TTL doesn't bind a marker to the current
 * MCP request.
 */
function resolveAllowed(
  context: ScopeContext,
  access: WhatsappAccessFile,
  hasOwnerJidsField: boolean,
  configuredIdentity: ConfiguredIdentity,
  trusted: boolean,
  isAutoDiscovered: boolean
): string[] | null {
  // 1. Owner bypass via env (matches upstream `WHATSAPP_OWNER_BYPASS=1`).
  //    Out-of-band — agent cannot set this in-process.
  if (context.kind === "foreground" && context.ownerBypass) return null;

  // 2. Explicit foreground guest — Codex 2nd-pass HIGH 3 fix. Beats
  //    bootstrap so a user with a malformed access.json doesn't get
  //    fail-open access despite explicitly opting into guest.
  if (context.kind === "foreground" && configuredIdentity === "guest") {
    return [];
  }

  // 3. Background lane — Codex 2nd-pass HIGH 3 fix: deny beats
  //    bootstrap. system-owner requires the trust file (out-of-band)
  //    so a prompt-injected agent can't set background.identity =
  //    "system-owner" via agent_config and escalate.
  if (context.kind === "background") {
    if (context.identity === "system-owner" && trusted) return null;
    return [];
  }

  // 4. Codex 2nd-pass HIGH 3 fix: malformed access.json (missing
  //    `ownerJids` field, even though it parsed as an object) is NOT
  //    bootstrap. Fail closed.
  if (!hasOwnerJidsField) return [];

  // 5. Bootstrap: legitimate empty `ownerJids`. Mirrors
  //    `claude-whatsapp/scope.ts:51-54`. Codex 3rd-pass CRITICAL 2:
  //    only honor bootstrap fail-open when the access path was
  //    auto-discovered. A user-configured `accessJsonPath` could
  //    point at a file the agent controls (e.g. agent-config.json),
  //    so bootstrap on such a path requires the trust file as
  //    additional out-of-band proof.
  if (access.ownerJids.length === 0) {
    if (isAutoDiscovered) return null;
    if (trusted) return null;
    // User-configured path + no trust file → potential forgery,
    // fail closed.
    return [];
  }

  // 6. Foreground owner — requires both the declared config AND the
  //    out-of-band trust file. Without the file, the agent could
  //    self-escalate via agent_config; with it, only an interactive
  //    `Bash` flow (the wizard) can grant.
  if (configuredIdentity === "owner" && trusted) return null;

  // 7. Phase 6: envelope-bound per-chat scope. Mirror byte-exact of
  //    claude-whatsapp/scope.ts:45-81 `resolveScope` + `scopedAllowedChats`.
  //    Without envelope, fall through to the Phase 3 ceiling (guest).
  if (context.kind === "foreground" && context.envelope) {
    return scopedAllowedChatsFromEnvelope(context.envelope, access);
  }

  // 8. Foreground "auto" / "owner without trust" / no envelope → Phase 3 ceiling.
  return [];
}

/**
 * Mirror of `claude-whatsapp/scope.ts:71` `scopedAllowedChats` for an
 * envelope-bound foreground context. Returns:
 *  - `null` when envelope.senderId is in ownerJids (owner via envelope) or
 *    when historyScope === "all" (unlimited within universe).
 *  - `string[]` for restricted scopes — intersected with universe per
 *    upstream's filter so phantom chat IDs are dropped.
 *
 * Forward-compat: unknown historyScope values fall back to "own" (chat
 * only) per scope.ts:60 default + the Phase 6 type-guard.
 */
function scopedAllowedChatsFromEnvelope(
  envelope: { chatId: string; senderId: string; ts: number },
  access: WhatsappAccessFile
): string[] | null {
  // Owner check via envelope sender. Upstream returns 'all' here.
  if (access.ownerJids.includes(envelope.senderId)) return null;

  const isGroup = envelope.chatId.endsWith("@g.us");
  const rawScope = isGroup
    ? access.groups[envelope.chatId]?.historyScope
    : access.dms[envelope.chatId]?.historyScope;
  const scope = rawScope ?? "own";

  // 'all' → unlimited within universe. Caller's SQL prefilter constrains
  // via `source_channel != ?` (drop other channels' chunks only).
  if (scope === "all") return null;

  // Universe = top-level allowFrom ∪ keys(groups). Phantom IDs dropped.
  const universe = new Set<string>([
    ...access.allowFrom,
    ...Object.keys(access.groups),
  ]);

  // 'own' (default) → just envelope.chatId, universe-filtered.
  if (scope === "own") {
    return [...new Set([envelope.chatId])].filter((id) => universe.has(id));
  }

  // string[] → envelope.chatId + extras, deduped via Set then universe-filtered.
  // Codex round-1 LOW: upstream `scope.ts:63` uses `new Set([ctx.chatId, ...scope])`
  // so duplicates collapse before filtering. Mirror byte-exact.
  if (Array.isArray(scope)) {
    return [...new Set([envelope.chatId, ...scope])].filter((id) =>
      universe.has(id)
    );
  }

  // Unknown historyScope value (forward-compat / schema drift): mirror
  // claude-whatsapp's defensive fallback to 'own'.
  return [...new Set([envelope.chatId])].filter((id) => universe.has(id));
}
