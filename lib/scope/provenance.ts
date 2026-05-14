/**
 * Chunk provenance derivation — Phase 2 of channel-scope compatibility.
 *
 * Two-stage derivation. Pure passive metadata; no enforcement happens
 * here. Phase 4a-1 wires the runtime checks; until then this module
 * just attaches `source_channel` / `source_chat_id` to chunks so they
 * can be filtered later without re-deriving on every search.
 *
 *   Stage 1 (path-pattern, first-class)
 *   -----------------------------------
 *   `extra:<root>/...` paths come from `memory.extraPaths`. We map the
 *   root basename + path body to a known channel via `deriveChannelHint`
 *   from `lib/scope-audit.ts`. This is the **first-class** signal: any
 *   chunk whose path matches a known channel pattern is channel-
 *   attributable, regardless of record-level fields.
 *
 *   `memory/...` and root `MEMORY.md` are positive-evidence local. They
 *   resolve to `source_channel = null` (local, not legacy_unprovenanced).
 *
 *   Anything else falls through to `legacy_unprovenanced` — used only
 *   for path-ambiguous chunks (e.g. a backup imported from a different
 *   machine where the path pattern doesn't match the workspace's
 *   `memory/` root or any configured `extraPath`).
 *
 *   Stage 2 (record-level, secondary detail)
 *   ----------------------------------------
 *   When a `messages.db` row is available for the chunk (Phase 3+), use
 *   `chat_id` from the row as `source_chat_id`. Phase 2 leaves this as
 *   `null` for all chunks (no DB row mapping yet) — the column is wired
 *   but unfilled. Phase 4a-1's owner-only ceiling does NOT need
 *   `source_chat_id` to deny channel content; only the per-chat scope
 *   path (`historyScope=all` / CSV) needs it, and that path waits on
 *   the upstream context capability anyway.
 *
 * Containment helper
 * ------------------
 * `resolveContainedPath(relPath, allowedRoots)` resolves an `extra:`
 * path to an absolute filesystem path while enforcing:
 *   - **Separator-safe** containment: `/foo/bar` is NOT inside
 *     `/foo/barX` (string-prefix bug in the original `memory-db.ts`).
 *   - **Symlink-resolved**: `fs.realpathSync` is applied to both the
 *     candidate and the root so a symlink can't escape the cage.
 *   - **Fail-closed on realpath errors**: a dangling symlink, missing
 *     file, or permission denial returns `null` — never resolves.
 *
 * Resolved paths are cached keyed by `path + mtimeMs + size` so a
 * realpath miss only happens on first access or after a file changes.
 *
 * LRU cache
 * ---------
 * Provenance derivation itself is cached `path → ChunkProvenance` with
 * a soft cap of 10k entries to avoid recomputing the channel hint on
 * every chunk in a hot search loop. The cache stores ONLY the
 * provenance shape; runtime decisions (deny / allow) are re-evaluated
 * per call from the runtime state, never cached.
 *
 * Contract reference: `docs/channel-scope-compat.md` Phase 1 findings,
 * "Provenance derivation — corrected closure (P0 fix)" section.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveChannelHint } from "../scope-audit.ts";
import type { ChannelName } from "../channel-detector.ts";
import { parseScopedMemoryPath } from "./scoped-paths.ts";

export type ProvenanceClass =
  | { kind: "channel"; sourceChannel: ChannelName; sourceChatId: string | null }
  | { kind: "local" }
  | { kind: "legacy_unprovenanced" };

export interface ChunkProvenance {
  /** Raw class — channel / local / legacy_unprovenanced. */
  class: ProvenanceClass;
  /** The exact source channel when class.kind === "channel". */
  sourceChannel: ChannelName | null;
  /**
   * Per-chat identifier when known. Null in Phase 2 for all chunks
   * (no `messages.db` row mapping yet). Phase 3 fills this in.
   */
  sourceChatId: string | null;
}

const PROVENANCE_LRU_CAP = 10_000;
const REALPATH_LRU_CAP = 2_048;

/**
 * Tiny insertion-order LRU. Suitable for hot-path use because Map
 * iteration order is insertion order in V8.
 */
class LRU<K, V> {
  private cap: number;
  private map = new Map<K, V>();

  constructor(cap: number) {
    this.cap = cap;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

const provenanceCache = new LRU<string, ChunkProvenance>(PROVENANCE_LRU_CAP);

/**
 * Path-pattern derivation. Stage-1, deterministic from the relPath.
 *
 * @param relPath the chunk's logical path as stored in memory.sqlite.
 *                E.g. `extra:claude-whatsapp/logs/2026-04-09.md`,
 *                `memory/MEMORY.md`, `MEMORY.md`.
 */
export function deriveProvenance(relPath: string): ChunkProvenance {
  const cached = provenanceCache.get(relPath);
  if (cached !== undefined) return cached;

  const out = deriveProvenanceUncached(relPath);
  provenanceCache.set(relPath, out);
  return out;
}

function deriveProvenanceUncached(relPath: string): ChunkProvenance {
  if (typeof relPath !== "string" || relPath.length === 0) {
    return {
      class: { kind: "legacy_unprovenanced" },
      sourceChannel: null,
      sourceChatId: null,
    };
  }

  // Stage 1a: extra: prefix → channel attribution via marker hint.
  if (relPath.startsWith("extra:")) {
    const hint = deriveChannelHint(relPath);
    if (hint !== null) {
      return {
        class: { kind: "channel", sourceChannel: hint, sourceChatId: null },
        sourceChannel: hint,
        sourceChatId: null,
      };
    }
    // extra: but no known channel marker matched. Still channel-derived
    // (came from extraPaths) but channel unknown — treated as
    // legacy_unprovenanced for now, since enforcement always operates
    // on a known channel name.
    return {
      class: { kind: "legacy_unprovenanced" },
      sourceChannel: null,
      sourceChatId: null,
    };
  }

  // Stage 1a-bis: scoped MEMORY mirror — `memory/.scoped/<channel>/MEMORY.<encoded>.md`.
  // These are dream-promote outputs from the per-channel lane (Phase
  // 4a-3). They live under `memory/` so the existing `memory/...`
  // catch-all below would falsely classify them as `_local` and leak
  // them through the partial-allowlist SQL predicate. Recognize them
  // BEFORE the generic local fallback. Codex Phase 4a-3 pre-impl
  // CRITICAL #2 fix.
  const scoped = parseScopedMemoryPath(relPath);
  if (scoped) {
    return {
      class: {
        kind: "channel",
        sourceChannel: scoped.channel,
        sourceChatId: scoped.chatId === "*" ? null : scoped.chatId,
      },
      sourceChannel: scoped.channel,
      sourceChatId: scoped.chatId === "*" ? null : scoped.chatId,
    };
  }

  // Stage 1b: workspace-local paths. Positive evidence of locality.
  if (
    relPath === "MEMORY.md" ||
    relPath === "memory/MEMORY.md" ||
    relPath.startsWith("memory/")
  ) {
    return {
      class: { kind: "local" },
      sourceChannel: null,
      sourceChatId: null,
    };
  }

  // Anything else: ambiguous. May be a backup imported from another
  // workspace, a hand-edited path, or a future format.
  return {
    class: { kind: "legacy_unprovenanced" },
    sourceChannel: null,
    sourceChatId: null,
  };
}

/**
 * Apply optional Stage-2 enrichment using a `messages.db` row. Phase 2
 * never calls this (no DB row mapping exists yet); it's exposed so
 * Phase 3's whatsapp adapter can layer chat-id provenance on top of
 * the path-pattern result without re-deriving.
 */
export function enrichProvenanceWithDbRow(
  base: ChunkProvenance,
  dbRow: { chat_id?: string | null } | null | undefined
): ChunkProvenance {
  if (base.class.kind !== "channel") return base;
  if (!dbRow || typeof dbRow.chat_id !== "string" || dbRow.chat_id.length === 0) {
    return base;
  }
  return {
    class: {
      kind: "channel",
      sourceChannel: base.class.sourceChannel,
      sourceChatId: dbRow.chat_id,
    },
    sourceChannel: base.class.sourceChannel,
    sourceChatId: dbRow.chat_id,
  };
}

// ---------------------------------------------------------------------------
// Path containment (separator-safe + symlink-resolved + fail-closed)
// ---------------------------------------------------------------------------

interface RealpathCacheEntry {
  realPath: string;
  mtimeMs: number;
  size: number;
  /**
   * Inode (POSIX) — invalidates the cache when a file is replaced by
   * a different file with the same mtime + size. Codex P1 2c: without
   * inode, atomic-replace via rename can hand back stale realpath.
   */
  ino: number;
}

const realpathCache = new LRU<string, RealpathCacheEntry>(REALPATH_LRU_CAP);

/**
 * Resolve `relPath` (an `extra:` logical path or workspace-relative)
 * to an absolute filesystem path AND verify it's contained in one of
 * `allowedRoots`. Returns the absolute resolved path on success, or
 * `null` if any safety check fails.
 *
 * Safety properties (vs the original `memory-db.ts:466`):
 *   - **Separator-safe**: `/a/b` is NOT inside `/a/bX` because we
 *     compare on `path.sep`-bounded prefixes.
 *   - **Symlink-resolved**: both candidate and root run through
 *     `fs.realpathSync` so a symlink-to-outside-the-cage is rejected.
 *   - **Fail-closed**: `null` on any thrown error (missing file,
 *     dangling symlink, permission denied). Callers must handle.
 *
 * @param relPath - logical path as stored in chunks (e.g. `extra:foo/bar.md`)
 * @param allowedRoots - one or more configured root paths the candidate
 *                       must live under (e.g. configured extraPaths,
 *                       the workspace `memory/` dir).
 */
export function resolveContainedPath(
  relPath: string,
  allowedRoots: string[]
): string | null {
  if (!relPath || allowedRoots.length === 0) return null;

  // Build candidate absolute path.
  let candidate: string | null = null;
  if (relPath.startsWith("extra:")) {
    const stripped = relPath.slice(6);
    const firstSep = stripped.indexOf("/");
    const rootBase = firstSep >= 0 ? stripped.slice(0, firstSep) : stripped;
    const subPath = firstSep >= 0 ? stripped.slice(firstSep + 1) : "";
    for (const root of allowedRoots) {
      if (path.basename(root) !== rootBase) continue;
      candidate = subPath ? path.join(root, subPath) : root;
      break;
    }
    if (!candidate) return null;
  } else {
    // Workspace-relative — pick the first allowed root and join.
    candidate = path.resolve(allowedRoots[0], relPath);
  }

  const realCandidate = realpathFailClosed(candidate);
  if (!realCandidate) return null;

  for (const root of allowedRoots) {
    const realRoot = realpathFailClosed(root);
    if (!realRoot) continue;
    if (
      realCandidate === realRoot ||
      realCandidate.startsWith(realRoot + path.sep)
    ) {
      return realCandidate;
    }
  }
  return null;
}

/**
 * Reverse-map: convert an arbitrary absolute filesystem path into a
 * logical scope-aware shape. Used by `voice_transcribe` (and any future
 * surface that accepts an absolute file path) to gate channel-derived
 * audio/document inputs without bypassing the `extra:` provenance
 * model.
 *
 * Phase 4a-2 — Codex adversarial Q2 fix: this primitive must be
 * **fail-closed** when an audio path is textually under a configured
 * `extraPath` but `realpath` fails on it (ELOOP, ENOENT, EACCES, etc.).
 * The previous null-returns-original design let those cases reach
 * `assertCanReadPath` as "legacy_unprovenanced" → allow, which IS the
 * exact bypass we're trying to close.
 *
 * Three return states:
 *   - `{ kind: "logical", path: "extra:<basename>/<rel>" }` — happy path.
 *     Caller passes this to `assertCanReadPath`; runtime gates as usual.
 *   - `{ kind: "deny", channel: ChannelName }` — textual prefix matched
 *     a known channel root but `realpath` failed; caller MUST surface a
 *     sanitized scope-denied error without reading the file.
 *   - `null` — path is genuinely outside any configured `extraPath`,
 *     OR the matched root's basename doesn't map to a known channel
 *     (e.g. `~/projects/notes/` is just user files, not a channel).
 *     Caller falls through to existing behavior.
 *
 * Resolution algorithm:
 *   1. realpath the input absolute path. If both realpath AND any
 *      extraPath realpath succeed, do prefix-matching against the
 *      resolved forms — separator-safe at directory boundaries via
 *      `path.relative(parent, child)` checks. Longest matched
 *      `realExtra` wins; on a true tie at the deepest level (two
 *      distinct extraPaths resolve to the same realpath), fail-closed
 *      with `kind: "deny"`.
 *   2. If realpath of the input fails, walk extraPaths textually and
 *      look for a directory-boundary prefix match. If any extraPath
 *      textually contains the input AND its basename maps to a known
 *      channel via `deriveChannelHint`, return `kind: "deny"`. The
 *      caller cannot prove the file lives where it says, but the
 *      textual evidence is enough for fail-closed.
 *   3. Anything else → `null`.
 *
 * Caller must already have `runtime.anyArmed === true` OR
 * `runtime.anyEnforceConfigured === true` (Phase 5 v9 ship-readiness)
 * before invoking. This helper has no opinion about whether scope is
 * armed — it's pure reverse-mapping logic. Gating it behind those
 * runtime flags preserves the zero-behavior-change invariant for users
 * without scope opt-in.
 */
export type AbsoluteMapping =
  | { kind: "logical"; path: string }
  | { kind: "deny"; channel: ChannelName }
  | null;

export function mapAbsoluteToLogical(
  absPath: string,
  extraPaths: string[]
): AbsoluteMapping {
  if (!absPath || extraPaths.length === 0) return null;

  // Codex HIGH fix (Phase 4a-2 post-impl review): expand `~/` in
  // configured extraPaths. `MemoryDB.constructor` does this on its
  // own copy (lib/memory-db.ts:41-44), but raw config from
  // `loadConfig` reaches us with `~/...` literal. Without expansion
  // the realpath check fails on every tilde-prefixed extra and the
  // helper returns `null`, which is the exact bypass we're closing.
  const home = os.homedir();
  const normalizedExtras = extraPaths.map((p) => {
    if (p.startsWith("~/")) return path.join(home, p.slice(2));
    if (p === "~") return home;
    return p;
  });

  // -- Pass 1: realpath both sides, longest-prefix-wins.
  const realAbs = realpathFailClosed(absPath);
  type Match = {
    rootBasename: string;
    rel: string;
    realExtra: string;
  };
  const matches: Match[] = [];
  for (const extra of normalizedExtras) {
    const realExtra = realpathFailClosed(extra);
    if (!realExtra) continue;
    if (!realAbs) continue;
    const rel = path.relative(realExtra, realAbs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    // Use the canonical basename (post-realpath), not the configured
    // alias. A user who configures a symlink as their extraPath still
    // intends the underlying canonical channel — `deriveChannelHint`
    // is keyed on the canonical name.
    matches.push({
      rootBasename: path.basename(realExtra),
      rel,
      realExtra,
    });
  }
  // Sort by realExtra length descending — deepest (most specific) root wins.
  matches.sort((a, b) => b.realExtra.length - a.realExtra.length);

  if (matches.length === 0) {
    // -- Pass 2: textual prefix match (realpath failed somewhere).
    if (!realAbs) {
      for (const extra of normalizedExtras) {
        // Separator-safe textual check: is `absPath` strictly inside `extra/`?
        if (
          absPath === extra ||
          absPath.startsWith(extra.endsWith(path.sep) ? extra : extra + path.sep)
        ) {
          const channel = deriveChannelHint(`extra:${path.basename(extra)}/probe.md`);
          if (channel) {
            return { kind: "deny", channel };
          }
        }
      }
    }
    return null;
  }

  // True tie at the deepest level → ambiguous → fail-closed.
  if (
    matches.length >= 2 &&
    matches[0].realExtra.length === matches[1].realExtra.length
  ) {
    const channel = deriveChannelHint(
      `extra:${matches[0].rootBasename}/probe.md`
    );
    return channel ? { kind: "deny", channel } : null;
  }

  const winner = matches[0];
  // If the winning basename doesn't map to a known channel, the path is
  // a non-channel extra (e.g. user notes). No scope concern.
  const channel = deriveChannelHint(
    `extra:${winner.rootBasename}/probe.md`
  );
  if (!channel) return null;
  return {
    kind: "logical",
    path: `extra:${winner.rootBasename}/${winner.rel}`,
  };
}

/**
 * Wrapper around `fs.realpathSync` that:
 *   - returns `null` instead of throwing on missing/dangling/permission
 *   - caches by mtimeMs+size so repeated lookups are cheap
 *
 * The cache invalidates automatically when a file's mtime or size
 * changes, so symlink retargeting is observed without manual flush.
 */
function realpathFailClosed(p: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return null;
  }
  const cacheKey = p;
  const cached = realpathCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.ino === stat.ino
  ) {
    return cached.realPath;
  }
  let real: string;
  try {
    real = fs.realpathSync(p);
  } catch {
    return null;
  }
  realpathCache.set(cacheKey, {
    realPath: real,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ino: stat.ino,
  });
  return real;
}

// ---------------------------------------------------------------------------
// Test/debug surface
// ---------------------------------------------------------------------------

/** Test-only: clear both caches. */
export function _resetCachesForTests(): void {
  provenanceCache.clear();
  realpathCache.clear();
}

/** Test-only: report cache sizes. */
export function _cacheSizesForTests(): { provenance: number; realpath: number } {
  return {
    provenance: provenanceCache.size(),
    realpath: realpathCache.size(),
  };
}
