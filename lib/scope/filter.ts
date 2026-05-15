/**
 * Channel-scope enforcement — Phase 4a-1.
 *
 * Two surfaces:
 *
 *   1. `filterScopedResults(results, context, runtime, options)`
 *      — post-process search results from `MemoryDB.search`,
 *      `QmdManager.search`, or `memory_context`. Drops chunks whose
 *      adapter says the current operator can't see them, respecting
 *      each channel's `mode` (`off`/`shadow`/`enforce`).
 *
 *   2. `assertCanReadPath(relPath, context, runtime)` — gate
 *      `memory_get` / `MemoryDB.readFile` by deriving the chunk's
 *      provenance from its path-pattern and asking the adapter.
 *      Returns either the unchanged `relPath` or a sanitized
 *      deny error object whose `message` does NOT include the
 *      original path.
 *
 * Both surfaces are **strict no-ops when no channel is armed**. The
 * runtime detection short-circuits before this module is ever
 * imported on the search hot path; the explicit early return below
 * is belt-and-suspenders.
 *
 * Sanitization rule (Codex P1 from Phase 1 doc):
 *   `scope-denied: <channel>:<8-char-hex-hash-of-path>`
 *   Never leak the full path or chat id in any error string.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChannelName } from "../channel-detector.ts";
import type { ChannelScopeConfig, ScopeConfigTree } from "../config.ts";
import {
  isWorkspaceCaseInsensitive,
  _resetWsCaseInsensitiveCacheForTests as resetWsCaseInsensitiveCache,
  _peekWsCaseInsensitiveForTests as peekWsCaseInsensitive,
} from "./canonical-path.ts";
import { deriveProvenance } from "./provenance.ts";
import type { ChunkProvenance } from "./provenance.ts";
import type { ScopeContext } from "./context.ts";
import { getScopeAdapter } from "./index.ts";
import type { ScopeRuntimeState } from "./runtime.ts";
import type { SearchResult } from "../types.ts";

export type ScopeMode = "off" | "shadow" | "enforce";

export interface ScopeFilterStats {
  /** True when this filter pass touched at least one result. */
  evaluated: boolean;
  /** Total chunks evaluated. */
  total: number;
  /** Chunks kept after enforcement. Equals `total` in shadow mode. */
  kept: number;
  /** Chunks the adapter said were not visible to the operator. */
  notVisible: number;
  /** Chunks actually dropped from the returned list. Equals
   *  `notVisible` in enforce mode, `0` in shadow / off. */
  dropped: number;
  /** Per-channel breakdown of `notVisible`. */
  byChannel: Partial<Record<ChannelName, number>>;
  /** Per-channel mode resolved at filter time (for diagnostics). */
  modes: Partial<Record<ChannelName, ScopeMode>>;
  /** True when the operator is owner-equivalent for the channels
   *  they queried — drives whether the count is shown to them. */
  operatorIsOwner: boolean;
  /** Phase 4a-2.6 v9 — Codex 9th-pass LOW F6: true when something
   *  upstream of the post-filter actively constrained the result set
   *  (SQL pre-filter emitted a clause OR QMD was skipped because of a
   *  partial allowlist). The post-filter never sees those drops, so
   *  `dropped` can be 0 even though the result set is restricted —
   *  callers use this flag to still emit a "scope active" notice. */
  preFilteredOrSkipped?: boolean;
}

export const EMPTY_STATS: ScopeFilterStats = Object.freeze({
  evaluated: false,
  total: 0,
  kept: 0,
  notVisible: 0,
  dropped: 0,
  byChannel: {},
  modes: {},
  operatorIsOwner: true,
  preFilteredOrSkipped: false,
});

export interface FilterScopedResultsOptions {
  /** When true, evaluate without dropping (shadow override). */
  forceShadow?: boolean;
  /** Active scope config tree from `loadConfig`. */
  scope?: ScopeConfigTree;
}

/**
 * Filter post-process for search results. When no channel is
 * armed, returns the input unchanged plus an empty stats object.
 *
 * The owner-equivalence flag is derived from the adapters: if an
 * adapter returns `null` from `allowedChatIds(context)` for the
 * channels touched by the result set, we treat the operator as
 * owner-equivalent for diagnostics. This determines whether the
 * caller surfaces a numeric drop count or a binary "results
 * filtered" message (info-disclosure mitigation).
 */
export function filterScopedResults(
  results: SearchResult[],
  context: ScopeContext,
  runtime: ScopeRuntimeState,
  options: FilterScopedResultsOptions = {}
): { results: SearchResult[]; stats: ScopeFilterStats } {
  // Codex round-8 ship-readiness BLOCKER fix: even when no channel is
  // armed, if any channel is `mode: enforce` configured, we must still
  // enter the loop so the adapter-missing branch denies chunks of that
  // channel. The previous `!anyArmed` short-circuit served chunks
  // unfiltered whenever the adapter went missing mid-session.
  if (!runtime.anyArmed && !runtime.anyEnforceConfigured) {
    return { results, stats: { ...EMPTY_STATS } };
  }

  const stats: ScopeFilterStats = {
    evaluated: true,
    total: results.length,
    kept: 0,
    notVisible: 0,
    dropped: 0,
    byChannel: {},
    modes: {},
    operatorIsOwner: true,
  };

  const filtered: SearchResult[] = [];
  const ownerProbed = new Set<ChannelName>();

  for (const result of results) {
    const provenance: ChunkProvenance =
      result.provenance ?? deriveProvenance(result.path);
    if (provenance.class.kind !== "channel") {
      filtered.push(result);
      stats.kept++;
      continue;
    }
    const channel = provenance.class.sourceChannel;
    const mode = resolveChannelMode(channel, runtime, options);
    stats.modes[channel] = mode;

    if (mode === "off") {
      filtered.push(result);
      stats.kept++;
      continue;
    }

    const adapter = getScopeAdapter(channel);
    if (!adapter) {
      // Channel is configured but no adapter is registered (e.g.
      // governance dropped mid-session). Fail closed in enforce,
      // pass-through in shadow.
      if (mode === "enforce" && !options.forceShadow) {
        stats.notVisible++;
        stats.dropped++;
        stats.byChannel[channel] = (stats.byChannel[channel] ?? 0) + 1;
        // Codex P1 fix (Phase 4a-1 review): a missing-adapter drop
        // never went through the ownership probe, so operatorIsOwner
        // stayed at its initial `true`. Without this, the
        // formatScopeNotice helper would surface a numeric drop
        // count to a non-owner whenever the adapter went missing
        // mid-session — a small info-disclosure leak.
        stats.operatorIsOwner = false;
      } else {
        filtered.push(result);
        stats.kept++;
      }
      continue;
    }

    // Probe operator ownership exactly once per channel; cache the
    // result on the stats object.
    if (!ownerProbed.has(channel)) {
      ownerProbed.add(channel);
      const allowed = adapter.allowedChatIds(context);
      if (allowed !== null) {
        // Anything other than `null` (no restriction) means the
        // operator is NOT owner-equivalent for this channel.
        stats.operatorIsOwner = false;
      }
    }

    const visible = adapter.canSee(provenance, context);
    if (visible) {
      filtered.push(result);
      stats.kept++;
      continue;
    }
    stats.notVisible++;
    stats.byChannel[channel] = (stats.byChannel[channel] ?? 0) + 1;
    if (mode === "enforce" && !options.forceShadow) {
      stats.dropped++;
    } else {
      filtered.push(result);
      stats.kept++;
    }
  }
  return { results: filtered, stats };
}

/**
 * Gate for `memory_get` / `MemoryDB.readFile`. Returns the
 * unchanged path on allow; returns a sanitized denial on deny.
 *
 * No-op when no channel is armed.
 *
 * Codex 3rd-pass BLOCK fix: callers can pass either a workspace-
 * relative path (`memory/.scoped/whatsapp/MEMORY.x.md`) or an absolute
 * path (`/Users/foo/workspace/memory/.scoped/whatsapp/MEMORY.x.md`).
 * `deriveProvenance` only matches the relative form — so an absolute
 * path under the workspace would fall through to `_local` and bypass
 * the scoped-MEMORY filter. We normalize absolute workspace-contained
 * paths to relative form before classifying. `workspaceRoot` is the
 * caller's plugin / workspace root (`MemoryDB.pluginRoot` /
 * `WORKSPACE`). When omitted, behavior matches pre-v4 (kept for tests
 * that don't have a workspace).
 *
 * Codex 4th-pass HIGH fix (v5): the v4 `path.resolve` + `startsWith`
 * implementation missed two real-world aliases — (1) symlinked
 * workspace dirs (e.g. `/var/folders/.../tmp/wsLink → /private/var/...`
 * on macOS, where mkdtemp returns the alias), and (2) case-variant
 * paths on case-insensitive filesystems (APFS / NTFS) where
 * `/USERS/foo/...` and `/Users/foo/...` reference the same inode but
 * `startsWith` rejects the variant. Both let an absolute scoped-MEMORY
 * file reach `deriveProvenance` as a non-channel path and fall through
 * to `_local`. v5 canonicalizes via `fs.realpathSync` for the existing-
 * file portion of the path AND case-folds the comparison on darwin /
 * win32. When realpath fails on an absolute path that textually
 * contains a known scoped-MEMORY shape, fail closed (route to
 * `deny`-pattern via the literal scoped path).
 */
export function assertCanReadPath(
  relPath: string,
  context: ScopeContext,
  runtime: ScopeRuntimeState,
  scope?: ScopeConfigTree,
  workspaceRoot?: string
): { allowed: true; relPath: string } | { allowed: false; error: string } {
  // Codex round-8 ship-readiness BLOCKER fix: see filterScopedResults.
  if (!runtime.anyArmed && !runtime.anyEnforceConfigured) {
    return { allowed: true, relPath };
  }

  // Codex 6th-pass MEDIUM fix: hard-deny on NUL / control-char paths
  // when scope is armed. Pre-v7 the guard was a soft pass-through that
  // relied on `MemoryDB.readFile`'s lower-level realpath to throw. But
  // for control chars in 0x01..0x1F that POSIX permits in filenames,
  // a planted file like `memory/.scoped/whatsapp/MEMORY.\x01x.md` would
  // pass the gate, classify as legacy/local via the unchanged path,
  // and reach `readFile`. Containment may or may not catch it; the
  // gate is the right place to refuse outright.
  if (
    typeof relPath === "string" &&
    hasUnsafeControlChars(relPath)
  ) {
    return {
      allowed: false,
      error: "scope-denied: invalid path (control character)",
    };
  }
  if (
    typeof workspaceRoot === "string" &&
    hasUnsafeControlChars(workspaceRoot)
  ) {
    return {
      allowed: false,
      error: "scope-denied: invalid workspace (control character)",
    };
  }
  // Codex 7th-pass HIGH: Windows drive-relative paths (`C:foo\\bar`)
  // are NOT absolute per Node's `path.isAbsolute` (only `C:\\foo` is).
  // The v6/v7 normalizer skipped them with the non-absolute return,
  // so `MemoryDB.readFile` then resolved them under `pluginRoot` —
  // potentially reaching a scoped file. v8 hard-denies the form at
  // the gate. The shape is `^[A-Za-z]:` followed by anything except a
  // separator (the absolute-form has `^[A-Za-z]:[/\\]`).
  if (typeof relPath === "string" && WINDOWS_DRIVE_RELATIVE_RE.test(relPath)) {
    return {
      allowed: false,
      error: "scope-denied: drive-relative path rejected",
    };
  }

  const classifyPath = normalizeForClassification(relPath, workspaceRoot);
  const provenance = deriveProvenance(classifyPath);
  if (provenance.class.kind !== "channel") {
    return { allowed: true, relPath };
  }
  const channel = provenance.class.sourceChannel;
  const mode = resolveChannelMode(channel, runtime, { scope });
  if (mode === "off" || mode === "shadow") return { allowed: true, relPath };

  const adapter = getScopeAdapter(channel);
  if (!adapter) {
    // Configured + enforce but no adapter — fail closed.
    return { allowed: false, error: sanitizeDenied(channel, relPath) };
  }
  if (adapter.canSee(provenance, context)) {
    return { allowed: true, relPath };
  }
  return { allowed: false, error: sanitizeDenied(channel, relPath) };
}

const SCOPED_MEMORY_TEXTUAL_RE =
  /(?:^|[/\\])memory[/\\]\.scoped[/\\]([a-z0-9_-]+)[/\\]MEMORY\.([^/\\]+)\.md$/i;

/** Codex 7th-pass HIGH: Windows drive-relative form `C:foo` (no
 *  separator after the colon). Path must NOT have a separator
 *  immediately after the drive letter. */
const WINDOWS_DRIVE_RELATIVE_RE = /^[A-Za-z]:[^/\\]/;

/**
 * Codex Phase 8 round-1 HIGH: the workspace case-sensitivity probe now
 * lives in `canonical-path.ts` so both filter and trust share a single
 * cache + implementation. Re-exported here for backwards-compat with the
 * Phase 5 test surface; new callers should import from `canonical-path.ts`
 * directly.
 */
export function _resetWsCaseInsensitiveCacheForTests(): void {
  resetWsCaseInsensitiveCache();
}

export function _probeWsCaseInsensitiveForTests(wsRealpath: string): boolean {
  return isWorkspaceCaseInsensitive(wsRealpath);
}

export function _peekWsCaseInsensitiveForTests(
  wsRealpath: string
): boolean | undefined {
  return peekWsCaseInsensitive(wsRealpath);
}

function caseFoldFor(wsCanonical: string, p: string): string {
  return isWorkspaceCaseInsensitive(wsCanonical) ? p.toLowerCase() : p;
}

function trimTrailingSep(p: string): string {
  if (p.length <= 1) return p;
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * Best-effort canonicalization. Returns null when realpath fails AND
 * the input cannot otherwise be canonicalized to its lowest existing
 * ancestor. Walks up the path until an ancestor exists, realpaths
 * that, then re-joins the missing tail.
 */
function canonicalizeBestEffort(absPath: string): string | null {
  try {
    return fs.realpathSync(absPath);
  } catch {
    /* fall through to ancestor-walk */
  }
  let cur = path.dirname(absPath);
  const tail: string[] = [path.basename(absPath)];
  while (true) {
    try {
      const real = fs.realpathSync(cur);
      return path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Convert an arbitrary `relPath` into the form `deriveProvenance`
 * expects (a workspace-relative path with forward slashes, OR an
 * `extra:` logical path). Absolute paths under `workspaceRoot` get
 * stripped to relative; `extra:` paths and non-absolute paths pass
 * through unchanged. Non-contained absolute paths also pass through
 * unchanged so `deriveProvenance` returns `legacy_unprovenanced`
 * (not the file's actual provenance — but the surrounding logic
 * already fails-closed on non-channel for the readPath surface).
 *
 * v5 hardening (Codex 4th-pass HIGH):
 *   - Canonicalize both sides via `fs.realpathSync` (best-effort:
 *     walks up to the lowest existing ancestor when the file itself
 *     is missing).
 *   - On darwin/win32, case-fold containment comparison so APFS / NTFS
 *     case aliases don't bypass the prefix check.
 *   - When the candidate looks like a scoped-MEMORY path textually
 *     (regex match against `SCOPED_MEMORY_TEXTUAL_RE`) but realpath
 *     fully fails, return the textual scoped form so the gate routes
 *     it through the channel adapter instead of treating it as
 *     `_local`. Fail-closed by construction.
 *   - Trailing slashes on `workspaceRoot` (and on the candidate) are
 *     stripped before comparison.
 */
/**
 * Reject paths containing NUL or other control characters before
 * realpath/regex normalization. Some platforms behave inconsistently
 * with embedded `\0`; cheaper to refuse outright. Codex 5th-pass LOW.
 */
function hasUnsafeControlChars(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    // C0 control chars (0x00..0x1F) except TAB, plus DEL (0x7F).
    // Codex 7th-pass LOW: DEL was missed in v7. TAB stays allowed
    // because POSIX legitimately permits it in filenames.
    if (c === 0 || c === 0x7f) return true;
    if (c < 0x20 && c !== 0x09) return true;
  }
  return false;
}

function normalizeForClassification(
  relPath: string,
  workspaceRoot: string | undefined
): string {
  if (typeof relPath !== "string" || relPath.length === 0) return relPath;
  if (relPath.startsWith("extra:")) return relPath;
  if (!path.isAbsolute(relPath)) return relPath;
  if (!workspaceRoot) return relPath;
  if (hasUnsafeControlChars(relPath) || hasUnsafeControlChars(workspaceRoot)) {
    // Defense-in-depth — defer to the textual fail-closed branch only
    // if the input also names a scoped file. Otherwise, return the
    // raw input (gate caller will deny via lower-level containment).
    return relPath;
  }

  // Step 1 — textual fail-closed when the path *names* a scoped-MEMORY
  // file. Anything matching the regex below classifies as channel-
  // derived regardless of realpath success/failure. This catches:
  //   - dangling-symlink targets
  //   - paths under not-yet-created directories
  //   - filesystem racing (file deleted between gate and read)
  // The tail of `SCOPED_MEMORY_TEXTUAL_RE` reproduces the exact form
  // `deriveProvenance` is willing to classify; matching here just
  // ensures the gate surface sees that form.
  const textualMatch = relPath.match(SCOPED_MEMORY_TEXTUAL_RE);

  const wsResolved = trimTrailingSep(path.resolve(workspaceRoot));
  const candResolved = path.resolve(relPath);

  // Track realpath success/failure explicitly. Codex 5th-pass LOW: the
  // textual fallback is only safe when realpath failed — a successful
  // realpath that lands OUTSIDE the workspace must be denied via
  // pass-through, not reclassified as channel via the textual shape
  // (a symlink inside the workspace pointing OUTSIDE shouldn't be
  // re-routed through the channel filter — it's a containment
  // violation that the readFile gate will catch with a sharper error).
  let realpathSucceeded = true;
  let wsCanonical = canonicalizeBestEffort(wsResolved);
  if (wsCanonical === null) {
    realpathSucceeded = false;
    wsCanonical = wsResolved;
  } else {
    try {
      fs.realpathSync(wsResolved);
    } catch {
      realpathSucceeded = false;
    }
  }
  let candCanonical = canonicalizeBestEffort(candResolved);
  if (candCanonical === null) {
    realpathSucceeded = false;
    candCanonical = candResolved;
  } else {
    try {
      fs.realpathSync(candResolved);
    } catch {
      realpathSucceeded = false;
    }
  }

  const wsTrimmed = trimTrailingSep(wsCanonical);
  const wsCmp = caseFoldFor(wsTrimmed, wsTrimmed);
  const candCmp = caseFoldFor(wsTrimmed, candCanonical);
  const insensitive = isWorkspaceCaseInsensitive(wsTrimmed);

  // Containment + tail extraction via path.relative on the case-folded
  // forms. path.relative does component-by-component comparison so
  // Unicode case-fold expansion (e.g. Turkish `İ` → 2-char `i̇`) doesn't
  // corrupt the tail. The output is fully lowercase on case-insensitive
  // platforms; we re-case `MEMORY.` and lowercase the channel segment
  // in a downstream pass so the case-sensitive `parseScopedMemoryPath`
  // regex matches.
  //
  // Codex 5th-pass HIGH fix: the v5 implementation sliced
  // `candCanonical` by `wsCmp.length + 1` which assumed
  // `wsCanonical.length === wsCmp.length`. That's false for
  // case-fold-expanding Unicode chars (Turkish I, German ß). v6 uses
  // `path.relative` instead, which is length-agnostic.
  let containedRelative: string;
  if (candCmp === wsCmp) {
    containedRelative = "";
  } else {
    const rel = path.relative(wsCmp, candCmp);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      // Outside the workspace canonically.
      // - If realpath succeeded but result is outside, fall through
      //   to pass-through (caller's lower-level containment denies).
      //   Codex 5th-pass LOW: NEVER use textual fail-closed here —
      //   a symlink inside the workspace pointing outside should be
      //   denied by containment, not reclassified.
      // - If realpath failed AND the input textually names a scoped
      //   file, route through the channel filter via the canonical
      //   textual form (fail-closed by construction).
      if (textualMatch && !realpathSucceeded) {
        return buildTextualScopedRel(relPath, textualMatch);
      }
      return relPath;
    }
    containedRelative = rel;
  }

  let normalized = containedRelative.split(path.sep).join("/");
  if (insensitive) {
    normalized = normalized.replace(
      /^memory\/\.scoped\/([^/]+)\//i,
      (_m, ch) => `memory/.scoped/${String(ch).toLowerCase()}/`
    );
    normalized = normalized.replace(
      /\/memory\.([^/]+\.md)$/i,
      "/MEMORY.$1"
    );
  }
  return normalized;
}

/**
 * Recover a textual scoped-MEMORY path from an arbitrary input that
 * matched `SCOPED_MEMORY_TEXTUAL_RE`. Used when realpath failed on a
 * candidate that names a scoped file — we still want to route the
 * gate through the channel adapter so the file isn't accidentally
 * classified as `_local` and leaked.
 *
 * Codex 5th-pass MEDIUM fixes:
 *   - Build the output from the regex captures, not by `indexOf`,
 *     so a path containing two `memory/.scoped/` substrings doesn't
 *     produce a non-canonical result.
 *   - Lowercase the channel segment so the case-sensitive
 *     `parseScopedMemoryPath` regex matches even when the textual
 *     match was case-insensitive (e.g. `MEMORY/.SCOPED/...`).
 */
function buildTextualScopedRel(
  _absPath: string,
  match: RegExpMatchArray
): string {
  // Build canonically from the regex captures, ignoring the original
  // path entirely. Codex 5th-pass MEDIUM fix: prevents `indexOf`-
  // based reconstruction from picking the wrong occurrence when the
  // path contains two `memory/.scoped/` substrings.
  const channel = String(match[1] ?? "").toLowerCase();
  const basename = String(match[2] ?? "");
  return `memory/.scoped/${channel}/MEMORY.${basename}.md`;
}

/**
 * Build the stable `WHERE` fragment + bound parameters for a SQL
 * pre-filter when a channel is armed in enforce mode and its
 * adapter returns either `null` (allow all) or `[]` (allow none)
 * for the current context. Phase 3's owner-only ceiling never
 * emits a partial allowlist, so the SQL emitted here is one of:
 *
 *   - allow-all: no fragment (caller skips pre-filter)
 *   - deny-all: `chunks.source_channel != ?`  (params: channel name)
 *
 * Phase 4a-2 may extend this to handle partial allowlists once the
 * marker-file proposal lands.
 */
export interface ScopeSqlPreFilter {
  /** Empty when no pre-filter applies. */
  whereSql: string;
  params: string[];
}

export function buildSqlPreFilter(
  context: ScopeContext,
  runtime: ScopeRuntimeState,
  scope?: ScopeConfigTree
): ScopeSqlPreFilter {
  // Codex round-8 ship-readiness BLOCKER fix: see filterScopedResults.
  if (!runtime.anyArmed && !runtime.anyEnforceConfigured) {
    return { whereSql: "", params: [] };
  }

  // Codex post-impl HIGH 3 fix: partial allowlists now emit a real
  // pre-filter so the FTS5 candidate window doesn't get exhausted
  // by denied chunks before refill kicks in. For a deny-all channel
  // we emit `chunks.source_channel != ?`; for a partial allowlist
  // we emit `(chunks.source_channel != ? OR chunks.source_chat_id
  // IN (?, ?, …))`. Allow-all (allowedChatIds === null) emits
  // nothing.
  const clauses: string[] = [];
  const params: string[] = [];

  for (const [channel, state] of Object.entries(runtime.channels) as Array<
    [ChannelName, NonNullable<ScopeRuntimeState["channels"][ChannelName]>]
  >) {
    const mode = resolveChannelMode(channel, runtime, { scope });
    if (mode !== "enforce") continue;
    // Codex round-8 BLOCKER fix: previously we skipped channels with
    // `!state.armed` before checking mode. That meant a channel
    // configured `mode: enforce` whose adapter went missing was
    // skipped entirely — chunks visible. Now we DON'T skip on
    // !armed: instead we let the missing-adapter branch below
    // emit `chunks.source_channel != ?` (deny-all).
    if (!state.armed) {
      clauses.push("chunks.source_channel != ?");
      params.push(channel);
      continue;
    }
    const adapter = getScopeAdapter(channel);
    if (!adapter) {
      // Adapter went missing mid-session — fail closed for this
      // channel.
      clauses.push("chunks.source_channel != ?");
      params.push(channel);
      continue;
    }
    const allowed = adapter.allowedChatIds(context);
    if (allowed === null) continue; // allow-all: no SQL filter
    if (allowed.length === 0) {
      clauses.push("chunks.source_channel != ?");
      params.push(channel);
      continue;
    }
    // Partial allowlist: keep non-channel rows + allowed chat_ids.
    const placeholders = allowed.map(() => "?").join(",");
    clauses.push(
      `(chunks.source_channel != ? OR chunks.source_chat_id IN (${placeholders}))`
    );
    params.push(channel, ...allowed);
  }
  if (clauses.length === 0) return { whereSql: "", params: [] };

  return {
    whereSql: clauses.join(" AND "),
    params,
  };
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Build the user-facing deny string. The hash makes it possible
 * to correlate across logs without leaking the path.
 */
export function sanitizeDenied(channel: ChannelName, relPath: string): string {
  const h = createHash("sha256").update(relPath).digest("hex").slice(0, 8);
  return `scope-denied: ${channel}:${h}`;
}

// ---------------------------------------------------------------------------
// Internal: per-channel mode lookup
// ---------------------------------------------------------------------------

function resolveChannelMode(
  channel: ChannelName,
  runtime: ScopeRuntimeState,
  options: { scope?: ScopeConfigTree; forceShadow?: boolean } = {}
): ScopeMode {
  if (options.forceShadow) return "shadow";
  // Prefer the runtime state (already reconciled with config); fall
  // back to the scope tree if a channel is provided in config but
  // didn't make it into runtime.channels for any reason.
  const rt = runtime.channels[channel];
  if (rt) return rt.mode;
  const cfg: ChannelScopeConfig | undefined = options.scope?.[channel];
  return cfg?.mode ?? "off";
}
