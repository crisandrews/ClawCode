/**
 * Path canonicalization helper extracted from `lib/scope/protected-paths.ts`
 * so the scope-trust primitive can reuse the same logic without depending on
 * the protected-paths module (which pulls in unrelated classifier surface).
 *
 * Public functions:
 *   - `canonicalize(p, caseFold?)`: realpath + optional case-fold.
 *   - `platformWantsCaseFold()`: stale platform-default heuristic (kept for
 *     legacy callers; trust uses the per-workspace probe instead).
 *   - `isWorkspaceCaseInsensitive(realpath)`: probe the actual filesystem at
 *     the workspace path. Codex Phase 8 round-1 HIGH: platform default folds
 *     case on case-sensitive APFS too, breaking cross-workspace isolation.
 *
 * Pure: no side effects beyond filesystem reads (realpathSync, readdirSync,
 * lstatSync, statSync). Safe to call from any synchronous context.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Returns the canonical form of an absolute path. Symlinks resolved, case
 * folded on platforms with case-insensitive filesystems (when `caseFold` is
 * `true`).
 *
 * Falls back to the input path (optionally lowercased) when even the
 * filesystem root cannot be canonicalized (extremely unlikely).
 */
export function canonicalize(p: string, caseFold: boolean = false): string {
  // Walk up to the deepest existing ancestor.
  let cur = p;
  const tail: string[] = [];
  // Safety bound: don't loop forever.
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(cur);
      const joined = tail.length === 0 ? real : path.join(real, ...tail.reverse());
      return caseFold ? joined.toLowerCase() : joined;
    } catch {
      // Not existing — pop one segment and retry.
      const parent = path.dirname(cur);
      if (parent === cur) {
        // Reached fs root without finding any existing ancestor.
        return caseFold ? p.toLowerCase() : p;
      }
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return caseFold ? p.toLowerCase() : p;
}

/**
 * Returns true on platforms where the DEFAULT filesystem is case-insensitive
 * (darwin = APFS/HFS+, win32 = NTFS). Linux's ext4/btrfs are case-sensitive.
 *
 * **Trust callers should NOT use this** — use `isWorkspaceCaseInsensitive`
 * which probes the actual filesystem. Case-sensitive APFS volumes exist and
 * the platform default mis-folds them, conflating distinct workspaces.
 */
export function platformWantsCaseFold(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "darwin" || platform === "win32";
}

const PLATFORM_CASE_INSENSITIVE_DEFAULT =
  process.platform === "darwin" || process.platform === "win32";

// Per-workspace probe cache. Workspace FS case-sensitivity doesn't change at
// runtime; cache by realpath. Cap = 64 entries (long-running processes that
// cycle through ephemeral workspaces don't accumulate).
const wsCaseInsensitiveCache = new Map<string, boolean>();
const WS_CASE_PROBE_CACHE_CAP = 64;

/**
 * Probes whether the filesystem at `wsRealpath` is case-insensitive by looking
 * up an existing entry under a case-flipped name and comparing inodes.
 *
 * Algorithm:
 * - `readdirSync(wsRealpath)` — collect entries.
 * - Sort for determinism (Codex 7th-pass MEDIUM: `readdir` order is
 *   filesystem-dependent; a dangling symlink as first flippable entry could
 *   poison the answer).
 * - For each entry with a non-trivial case flip (some letters), try
 *   `statSync(joined-with-flipped-name)`. Same dev+ino → case-insensitive.
 * - If no entries succeed, fall back to the parent-dir basename flip.
 * - If everything fails, return the platform default but DON'T cache it.
 *
 * Codex Phase 8 round-1 HIGH: `workspaceFingerprint` must use THIS instead of
 * the platform default — otherwise case-sensitive APFS volumes silently
 * conflate `/Work/Foo` and `/Work/foo` and break cross-workspace isolation.
 */
export function isWorkspaceCaseInsensitive(wsRealpath: string): boolean {
  const cached = wsCaseInsensitiveCache.get(wsRealpath);
  if (cached !== undefined) return cached;
  let result = PLATFORM_CASE_INSENSITIVE_DEFAULT;
  let conclusive = false;
  try {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(wsRealpath, { withFileTypes: true });
    } catch {
      /* no readdir — empty/unreadable; defer to parent-dir probe */
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const name = e.name;
      const flipped =
        name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase();
      if (flipped === name) continue;
      const orig = path.join(wsRealpath, name);
      const variant = path.join(wsRealpath, flipped);
      try {
        fs.lstatSync(orig);
      } catch {
        continue;
      }
      try {
        const aOrig = fs.statSync(orig);
        if (aOrig.ino === 0) continue;
        try {
          const aVar = fs.statSync(variant);
          if (aVar.ino === 0) continue;
          result = aOrig.dev === aVar.dev && aOrig.ino === aVar.ino;
          conclusive = true;
          break;
        } catch {
          result = false;
          conclusive = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!conclusive) {
      const dir = path.dirname(wsRealpath);
      const base = path.basename(wsRealpath);
      if (base.length > 0 && dir !== wsRealpath) {
        const flipped =
          base === base.toLowerCase()
            ? base.toUpperCase()
            : base.toLowerCase();
        if (flipped !== base) {
          const variant = path.join(dir, flipped);
          try {
            const aOrig = fs.statSync(wsRealpath);
            const aVar = fs.statSync(variant);
            if (aOrig.ino !== 0 && aVar.ino !== 0) {
              result = aOrig.dev === aVar.dev && aOrig.ino === aVar.ino;
            }
          } catch {
            result = false;
          }
        }
      }
    }
  } catch {
    /* fall back to platform default */
  }
  if (conclusive) {
    if (wsCaseInsensitiveCache.size >= WS_CASE_PROBE_CACHE_CAP) {
      const first = wsCaseInsensitiveCache.keys().next().value;
      if (first !== undefined) wsCaseInsensitiveCache.delete(first);
    }
    wsCaseInsensitiveCache.set(wsRealpath, result);
  }
  return result;
}

/** @internal Test-only: clear the workspace case-sensitivity probe cache. */
export function _resetWsCaseInsensitiveCacheForTests(): void {
  wsCaseInsensitiveCache.clear();
}

/** @internal Test-only: peek the cached probe answer without triggering a fresh probe. */
export function _peekWsCaseInsensitiveForTests(
  wsRealpath: string
): boolean | undefined {
  return wsCaseInsensitiveCache.get(wsRealpath);
}
