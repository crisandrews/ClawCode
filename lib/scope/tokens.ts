/**
 * scopeToken issuer — Phase 2 of channel-scope compatibility.
 *
 * A scopeToken is an opaque per-search UUID handed back alongside each
 * `SearchResult`. Phase 4a-2 wires the token into `voice.speak` so a
 * caller can prove "this text came from a search that was already
 * scope-checked". Phase 2 just issues + tracks them; nothing reads
 * them yet, so the token field on `SearchResult` is metadata only.
 *
 * The store is process-local. Tokens have a TTL (default 60 s) and are
 * indexed by token string. Validation is a constant-time string
 * lookup; expiry is lazy (on validate / sweep), not via timers.
 *
 * Why an opaque token instead of stamping the provenance directly?
 *   - Provenance can be relatively large (channel + chat_id strings).
 *   - The token lets us bind a result to the exact runtime context
 *     used to authorize it; if that context is reused later under a
 *     different scope, the provenance is no longer load-bearing.
 *   - It gives us a place to attach a TTL so stale results from a
 *     long-running session can't be re-played into voice/inbox.
 */

import { randomUUID } from "node:crypto";
import type { ChunkProvenance } from "./provenance.ts";

const DEFAULT_TTL_MS = 60_000;

export interface ScopeTokenRecord {
  token: string;
  provenance: ChunkProvenance;
  issuedAt: number;
  expiresAt: number;
  /** Optional caller-provided correlation ID (e.g. MCP request id). */
  requestId?: string;
}

const store = new Map<string, ScopeTokenRecord>();
let lastSweep = 0;

/**
 * Issue a new opaque token bound to `provenance`. Phase 2 callers
 * include the token in `SearchResult.scopeToken` (passive). Phase 4
 * adds validators in voice/inbox.
 */
export function issueScopeToken(
  provenance: ChunkProvenance,
  options: { ttlMs?: number; requestId?: string } = {}
): string {
  maybeSweep();
  const token = randomUUID();
  const now = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  store.set(token, {
    token,
    provenance,
    issuedAt: now,
    expiresAt: now + ttlMs,
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  });
  return token;
}

/**
 * Validate a token. Returns the bound provenance when the token is
 * known and unexpired, `null` otherwise. Side-effect: prunes the
 * record on expiry so the store doesn't grow unbounded.
 */
export function validateScopeToken(
  token: string | undefined | null
): ChunkProvenance | null {
  if (!token) return null;
  const rec = store.get(token);
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) {
    store.delete(token);
    return null;
  }
  return rec.provenance;
}

/** Test-only: clear the store. */
export function _resetTokenStoreForTests(): void {
  store.clear();
  lastSweep = 0;
}

/** Test-only: introspect store size. */
export function _tokenStoreSizeForTests(): number {
  return store.size;
}

/**
 * Periodic sweep of expired records. Triggered on issue rather than
 * via a timer so the module has no global side-effects until used.
 */
function maybeSweep(): void {
  const now = Date.now();
  // Sweep at most every TTL/2 to keep amortized cost negligible.
  if (now - lastSweep < DEFAULT_TTL_MS / 2) return;
  lastSweep = now;
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
}
