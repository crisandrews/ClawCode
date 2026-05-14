/**
 * scope-cache.json — atomic write-temp+rename utility for
 * cross-launch persistence of scope adapter governance state.
 *
 * Phase 3 ships the writer; the only consumers in this phase are
 * tests + the runtime warm-start path. Phase 4a-1 may use it for
 * memo-ed `allowedChatIds` snapshots (currently unused since the
 * adapter cache is in-process).
 *
 * Properties:
 *   - **Atomic on POSIX**: write `*.tmp` with `0600`, then `rename`.
 *     A reader sees either the old version or the new one, never a
 *     half-written file.
 *   - **Last-known-good**: parse failure preserves the prior value;
 *     callers see the LKG, the writer logs to stderr (best-effort).
 *   - **Advisory flock**: optional `lockfile` arg (path to a
 *     sentinel file). When provided, we acquire `O_EXCL` on the
 *     lock to serialize writers from peer processes (e.g. two
 *     Claude Code sessions in the same workspace). Best-effort —
 *     a stale lock falls through to a forced retake after 30 s.
 *
 * The cache file is JSON with a top-level `{ version, updatedAt,
 * data }` envelope so a future migration can bump `version` and
 * tolerate forward-compat parsing.
 */

import fs from "node:fs";
import path from "node:path";

export interface ScopeCacheEnvelope<T> {
  version: number;
  updatedAt: string;
  data: T;
}

const CURRENT_VERSION = 1;
const STALE_LOCK_MS = 30_000;

/**
 * Write `data` to `cachePath` atomically. When `lockPath` is given,
 * the writer takes a best-effort exclusive lock on it for the
 * duration of the write — useful when two processes might both try
 * to refresh the cache (e.g. concurrent dream cycles).
 *
 * Returns:
 *   - `true` on successful write
 *   - `false` when the lock was held by a live peer; caller should
 *     trust the existing on-disk value
 *
 * Never throws. Failures are best-effort by design — losing the
 * cache means a slower next launch, not a correctness bug.
 */
export function writeScopeCache<T>(
  cachePath: string,
  data: T,
  options: { lockPath?: string } = {}
): boolean {
  const lock = options.lockPath ? takeAdvisoryLock(options.lockPath) : null;
  if (options.lockPath && !lock) return false;
  try {
    const envelope: ScopeCacheEnvelope<T> = {
      version: CURRENT_VERSION,
      updatedAt: new Date().toISOString(),
      data,
    };
    const tmp = `${cachePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2) + "\n", {
      mode: 0o600,
    });
    try {
      fs.renameSync(tmp, cachePath);
    } catch {
      // Rename can fail across mountpoints; fall back to copy+unlink.
      try {
        fs.copyFileSync(tmp, cachePath);
        fs.unlinkSync(tmp);
      } catch {
        return false;
      }
    }
    return true;
  } finally {
    if (lock) releaseAdvisoryLock(lock);
  }
}

/**
 * Read + parse `cachePath`. On parse failure or missing file
 * returns `null` — caller decides whether to log + rebuild.
 */
export function readScopeCache<T>(
  cachePath: string
): ScopeCacheEnvelope<T> | null {
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.version === "number" &&
      typeof parsed.updatedAt === "string" &&
      "data" in parsed
    ) {
      return parsed as ScopeCacheEnvelope<T>;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Advisory lock (best-effort)
// ---------------------------------------------------------------------------

interface LockHandle {
  path: string;
  fd: number;
}

function takeAdvisoryLock(lockPath: string): LockHandle | null {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Parent directory creation failed; lock attempt below will
    // surface the error.
  }
  // Stale lock handling: if the file exists and is older than
  // STALE_LOCK_MS, remove it so we don't deadlock waiting for a
  // crashed peer. Codex post-impl-round5 RH-4: clamp future mtime
  // (clock skew on shared FS) so we don't wedge here either, and
  // unlink immediately on a far-future mtime which indicates a
  // corrupt timestamp.
  try {
    const stat = fs.statSync(lockPath);
    const now = Date.now();
    const FUTURE_SKEW_TOLERANCE_MS = 5 * 60_000;
    const farFuture = stat.mtimeMs > now + FUTURE_SKEW_TOLERANCE_MS;
    const effectiveMtime = Math.min(stat.mtimeMs, now);
    if (farFuture || now - effectiveMtime > STALE_LOCK_MS) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // No lock present — proceed.
  }
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeSync(fd, String(process.pid));
    return { path: lockPath, fd };
  } catch {
    return null;
  }
}

function releaseAdvisoryLock(handle: LockHandle): void {
  try {
    fs.closeSync(handle.fd);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(handle.path);
  } catch {
    // ignore
  }
}
