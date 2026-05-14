/**
 * Scope adapter registry — Phase 3 of channel-scope compatibility.
 *
 * Adapters are per-channel objects that answer two questions:
 *
 *   1. `canSee(provenance, context) -> boolean` — given a chunk's
 *      provenance and the current scope context, is the operator
 *      allowed to read it?
 *   2. `allowedChatIds(context) -> string[] | null` — when the
 *      adapter can answer in bulk (i.e., per-chunk evaluation isn't
 *      needed), what chat IDs is the operator allowed to read?
 *      `null` = no restriction (e.g. the operator is the owner);
 *      `[]` = denied (no chats accessible).
 *
 * Phase 4a-1 wires these into `searchMemory`, `memory_get`,
 * `memory_context`, and the QMD post-process. Phase 3 only ships
 * the registry + the WhatsApp adapter implementation; nothing reads
 * `canSee` yet.
 *
 * **Critical invariant**: an adapter is only instantiated when its
 * channel has `mode != "off"` AND the channel governance is
 * resolvable (e.g. `access.json` is parseable). Users without
 * `scope.<channel>` declared in config never reach this code path.
 *
 * The registry is a process-local singleton populated lazily by
 * `lib/scope/runtime.ts`. Tests can call `_resetRegistryForTests()`
 * between cases.
 */

import type { ChannelName } from "../channel-detector.ts";
import type { ChunkProvenance } from "./provenance.ts";
import type { ScopeContext } from "./context.ts";

/**
 * Per-channel adapter contract. All methods must be **pure** with
 * respect to the registry — i.e., never modify shared state. They
 * may read filesystem state (`access.json`) but must use their own
 * caching layer (see `whatsapp.ts`'s mtime+size+ino cache).
 */
export interface ScopeAdapter {
  /** Channel name this adapter serves. */
  readonly channel: ChannelName;

  /**
   * `true` when `canSee` must be evaluated per chunk (e.g. the
   * underlying access model is per-row). `false` when the result of
   * `allowedChatIds(context)` is authoritative for every chunk in
   * the matching channel — that lets the search SQL pre-filter via
   * `WHERE source_chat_id IN (...)`.
   */
  readonly requiresPerChunkCheck: boolean;

  /**
   * Authoritative read decision for a single chunk's provenance
   * given the current context. Phase 4a-1 calls this from every
   * chokepoint when the adapter's channel is armed.
   */
  canSee(provenance: ChunkProvenance, context: ScopeContext): boolean;

  /**
   * Bulk allowed-chats. Returns:
   *   - `null` — no restriction, operator may read any chat in the
   *     channel (e.g. owner bypass, or claude-whatsapp's `'all'` scope).
   *   - `string[]` — explicit allowlist of chat ids; SQL pre-filter
   *     uses `source_chat_id IN (...)` for efficiency.
   *   - `[]` — denied; no chats accessible.
   *
   * MUST be cheap (no syscalls past the adapter's own cache).
   */
  allowedChatIds(context: ScopeContext): string[] | null;
}

const registry = new Map<ChannelName, ScopeAdapter>();

/**
 * Register an adapter. Called by `runtime.ts` during detection.
 * Replaces any existing adapter for the same channel — adapter
 * upgrades in long-running processes are supported, e.g. when
 * `access.json` has been edited and the runtime decides to swap in
 * a fresh instance.
 */
export function registerScopeAdapter(adapter: ScopeAdapter): void {
  registry.set(adapter.channel, adapter);
}

/**
 * Look up an adapter by channel. Returns `undefined` when no
 * adapter is registered (channel disarmed or never detected).
 */
export function getScopeAdapter(
  channel: ChannelName
): ScopeAdapter | undefined {
  return registry.get(channel);
}

/**
 * Remove the adapter for a channel. Called by the runtime when a
 * channel transitions from armed → disarmed (mode flipped to off,
 * governance disappeared, etc.) so a stale adapter cannot be
 * surfaced to Phase 4a-1+ chokepoints.
 */
export function unregisterScopeAdapter(channel: ChannelName): void {
  registry.delete(channel);
}

/** Snapshot of registered adapters (read-only view). */
export function listRegisteredAdapters(): ScopeAdapter[] {
  return Array.from(registry.values());
}

/** Test-only: clear the registry. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
