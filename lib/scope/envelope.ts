// Per-inbound request envelope reader (Phase 6).
//
// claude-whatsapp's envelope writer publishes `<channel-dir>/.request-envelopes/<token>.json`
// for every inbound that triggers a `notifications/claude/channel` dispatch.
// The token is embedded in the notification's meta and forwarded by the agent
// as `requestEnvelopeToken` argument to MCP tool calls. This module loads + validates
// the envelope, returning a typed payload that ForegroundContext consumes to bind
// the current tool call to the inbound that triggered it.
//
// Hardening parity with the marker reader (lib/scope/whatsapp.ts:loadInboundContext):
//   - Filename validated against TOKEN_REGEX before any FS access (path-traversal
//     defense: even `.` / `/` / `\` / NUL / overlength tokens are rejected without
//     touching disk).
//   - Pre-open `lstat` fast-reject (non-regular files).
//   - Open with O_NOFOLLOW + O_NONBLOCK (symlink + FIFO defense).
//   - Single-fd fstat (TOCTOU-free).
//   - uid match against process uid.
//   - File mode `& 0o077 === 0` (no group/world bits — should be 0o600).
//   - Size cap at ENVELOPE_MAX_BYTES (defensive DoS cap).
//   - Realpath confirmation: file's realpath must sit under the realpath'd
//     `.request-envelopes/` directory (belt-and-suspenders on top of regex).
//
// Bounded-reuse within TTL (Codex Phase 6 amendment 6a.2c):
//   The same envelope token can be loaded by multiple MCP tool calls within
//   its 60s TTL — single-use would break multi-tool agent flows (e.g.,
//   memory_search → memory_get of a hit). LRU caches the parsed payload
//   keyed by token; entries past TTL are evicted on access.

import fs from "fs";
import path from "path";

export const ENVELOPE_DIR_NAME = ".request-envelopes";
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_TTL_MS = 60_000;
export const ENVELOPE_CLOCK_SKEW_TOLERANCE_MS = 5_000;
export const ENVELOPE_TOKEN_LENGTH = 43;
export const ENVELOPE_TOKEN_REGEX = /^[A-Za-z0-9_-]{43}$/;
export const ENVELOPE_MAX_BYTES = 1024;
export const ENVELOPE_LRU_CONSUMED_TOKENS_CAP = 256;

export interface RequestEnvelopePayload {
  version: number;
  token: string;
  chatId: string;
  senderId: string;
  ts: number;
  expiresAt: number;
}

interface ConsumedEntry {
  payload: RequestEnvelopePayload;
  firstSeenMs: number;
}

export class EnvelopeReader {
  private readonly cache = new Map<string, ConsumedEntry>();

  /**
   * Resolve+validate envelope payload for the given token under the given
   * channel directory. Returns null on any failure (independence-preserving:
   * absent channel-dir → null, expired → null, etc.). Callers in `enforce`
   * mode MUST map null → guest `[]` allowlist.
   */
  load(
    channelDir: string,
    token: string,
    now: number = Date.now()
  ): RequestEnvelopePayload | null {
    if (typeof token !== "string") return null;
    if (!ENVELOPE_TOKEN_REGEX.test(token)) return null;

    // Bounded-reuse hit before any fs access — short-circuits multi-tool flows.
    const cached = this.cache.get(token);
    if (cached) {
      if (now - cached.firstSeenMs <= ENVELOPE_TTL_MS) {
        // Re-check ts/skew against current now (the file may not exist any
        // more, but the cached payload's window is what matters for reuse).
        if (
          now - cached.payload.ts <= ENVELOPE_TTL_MS &&
          cached.payload.ts <= now + ENVELOPE_CLOCK_SKEW_TOLERANCE_MS
        ) {
          // Codex round-1 LOW: promote to true LRU. Map preserves
          // insertion order, so delete + re-set bumps recency. Without
          // this, a recently-reused token can be evicted while strictly
          // older tokens that haven't been touched stay resident.
          this.cache.delete(token);
          this.cache.set(token, cached);
          return cached.payload;
        }
      }
      // Past TTL — evict and fall through to a fresh load (file is probably
      // already gone, but in case of clock skew across processes we try anyway).
      this.cache.delete(token);
    }

    const envelopeDir = path.join(channelDir, ENVELOPE_DIR_NAME);
    const filePath = path.join(envelopeDir, `${token}.json`);

    // Codex round-1 MEDIUM 2: validate the envelope DIRECTORY itself
    // (not just the file). O_NOFOLLOW protects only the final path
    // component; if `.request-envelopes` is a symlink, an attacker
    // (same-uid) could redirect every envelope read at the dir layer.
    let dirSt: fs.Stats;
    try {
      dirSt = fs.lstatSync(envelopeDir);
    } catch {
      return null;
    }
    if (dirSt.isSymbolicLink()) return null;
    if (!dirSt.isDirectory()) return null;
    if (!this.ownerMatches(dirSt.uid)) return null;
    if ((dirSt.mode & 0o077) !== 0) return null;

    // Pre-open lstat — fast-reject non-files (symlinks/FIFOs/sockets/dirs).
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(filePath);
    } catch {
      return null;
    }
    if (!lst.isFile()) return null;

    const NOFOLLOW =
      typeof (fs.constants as Record<string, number>).O_NOFOLLOW === "number"
        ? (fs.constants as Record<string, number>).O_NOFOLLOW
        : 0;
    const NONBLOCK =
      typeof (fs.constants as Record<string, number>).O_NONBLOCK === "number"
        ? (fs.constants as Record<string, number>).O_NONBLOCK
        : 0;
    const flags = fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK;

    let fd: number;
    try {
      fd = fs.openSync(filePath, flags);
    } catch {
      return null;
    }

    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return null;
      if (!this.ownerMatches(stat.uid)) return null;
      if ((stat.mode & 0o077) !== 0) return null;
      if (stat.size > ENVELOPE_MAX_BYTES) return null;
      if (stat.size <= 0) return null;

      const buf = Buffer.alloc(stat.size);
      const read = fs.readSync(fd, buf, 0, stat.size, 0);
      // Codex round-1 MEDIUM 2: reject short reads. If the file truncated
      // between `fstat` and `readSync` (race) or the disk lied about size,
      // returning the partial buffer could surface garbled JSON that
      // accidentally parses or, worse, parses to a forged subset of the
      // intended payload. Fail closed.
      if (read !== stat.size) return null;
      let raw: string;
      try {
        raw = buf.subarray(0, read).toString("utf8");
      } catch {
        return null;
      }

      const parsed = this.parseAndValidate(raw, token, now);
      if (!parsed) return null;

      // Realpath confirmation: belt-and-suspenders defense after open. Even
      // though TOKEN_REGEX already excludes path separators, an alias on
      // `.request-envelopes/` (e.g., a directory-level symlink in a hostile
      // environment) could cause the regex-clean filename to resolve outside
      // the expected dir. Reject if realpath drifts.
      try {
        const realFile = fs.realpathSync.native(filePath);
        const realDir = fs.realpathSync.native(envelopeDir);
        const expectedPrefix = realDir + path.sep;
        if (realFile !== path.join(realDir, `${token}.json`) && !realFile.startsWith(expectedPrefix)) {
          return null;
        }
        if (realFile.length <= realDir.length || !realFile.startsWith(expectedPrefix)) {
          return null;
        }
      } catch {
        return null;
      }

      // Successful first load — record in LRU for bounded-reuse window.
      this.recordConsumed(token, parsed, now);
      return parsed;
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Pure parser/validator. Exposed for tier1 testing of the validation
   * matrix without touching the filesystem.
   */
  parseAndValidate(
    raw: string,
    filenameToken: string,
    now: number = Date.now()
  ): RequestEnvelopePayload | null {
    if (!ENVELOPE_TOKEN_REGEX.test(filenameToken)) return null;
    if (raw.length > ENVELOPE_MAX_BYTES) return null;

    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;

    if (o.version !== ENVELOPE_VERSION) return null;
    if (typeof o.token !== "string" || o.token !== filenameToken) return null;
    if (typeof o.chatId !== "string" || !o.chatId) return null;
    if (typeof o.senderId !== "string" || !o.senderId) return null;
    if (typeof o.ts !== "number" || !Number.isFinite(o.ts) || o.ts <= 0)
      return null;
    if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt))
      return null;
    if (o.expiresAt !== o.ts + ENVELOPE_TTL_MS) return null;
    if (now - o.ts > ENVELOPE_TTL_MS) return null;
    if (o.ts > now + ENVELOPE_CLOCK_SKEW_TOLERANCE_MS) return null;

    return {
      version: o.version,
      token: o.token,
      chatId: o.chatId,
      senderId: o.senderId,
      ts: o.ts,
      expiresAt: o.expiresAt,
    };
  }

  private ownerMatches(uid: number): boolean {
    const procUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (procUid === null) return true; // non-POSIX (Windows) — skip check
    return uid === procUid;
  }

  private recordConsumed(
    token: string,
    payload: RequestEnvelopePayload,
    now: number
  ): void {
    // LRU eviction: oldest first if cap exceeded.
    if (this.cache.size >= ENVELOPE_LRU_CONSUMED_TOKENS_CAP) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(token, { payload, firstSeenMs: now });
  }

  /** Test hook: clear the LRU cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Test hook: inspect cache size. */
  cacheSize(): number {
    return this.cache.size;
  }
}

// Module-level default reader so handlers don't need to thread the instance.
let _defaultReader: EnvelopeReader | null = null;

export function getDefaultEnvelopeReader(): EnvelopeReader {
  if (!_defaultReader) _defaultReader = new EnvelopeReader();
  return _defaultReader;
}

/** Test hook: reset the default reader. */
export function resetDefaultEnvelopeReader(): void {
  _defaultReader = null;
}

/**
 * Convenience: load an envelope using the default reader. Most callers in
 * server.ts use this; the class form exists for tests that need isolated
 * LRU state per fixture.
 */
export function loadEnvelope(
  channelDir: string,
  token: string,
  now?: number
): RequestEnvelopePayload | null {
  return getDefaultEnvelopeReader().load(channelDir, token, now);
}
