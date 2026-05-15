/**
 * Shadow-mode event log for the execution gate.
 *
 * When `scope.<channel>.execGate.mode === "shadow"`, the gate does NOT
 * block tool calls but DOES record each would-block decision to
 * `memory/.execgate-shadow.jsonl` for review before the user flips to
 * enforce. Each event carries enough state (effective mode, expanded
 * tools, hook version, config hash, lookback window, envelope count) to
 * replay the policy decision unambiguously, even if the config changed
 * since the event was logged.
 *
 * Rotation: hard cap at 1 MB. On overflow, atomic rename to
 * `.execgate-shadow.jsonl.1` (overwriting any prior `.1`), then a fresh
 * write goes to the canonical name. Single backup file — older history
 * is discarded by design (shadow events are observational; long history
 * is not useful for the wizard's pre-flip review).
 *
 * Concurrency: advisory lock via O_EXCL mkdir on a sibling
 * `.execgate-shadow.lock/` directory. Same pattern as `lib/scope/cache.ts`.
 *
 * Symlink defense: refuses to write if the canonical log path is itself
 * a symlink (lstat check). A same-uid attacker that planted a redirect
 * could otherwise capture shadow events to an attacker-controlled file.
 *
 * Fail-soft: any write failure (ENOSPC, EROFS, symlinked path, lock
 * timeout) drops the event silently — shadow logs are observational, so
 * losing one is acceptable; failing the hook is not.
 */

import fs from "node:fs";
import path from "node:path";

export const SHADOW_LOG_MAX_BYTES = 1_048_576; // 1 MB
export const SHADOW_LOG_LOCK_TIMEOUT_MS = 200;
export const SHADOW_LOG_LOCK_POLL_MS = 5;
/** Codex round-1 WARN 6: stale-lock recovery threshold. Was 4×timeout
 *  (800 ms) which is too aggressive for slow disks or during rotation.
 *  30 s is conservative — actual live writers complete in <100 ms; only
 *  truly orphaned locks survive longer. */
export const SHADOW_LOG_STALE_LOCK_MS = 30_000;

/** Stable subset of fields every event carries, for replay analysis. */
export interface ShadowEvent {
  /** ISO timestamp (`new Date(now).toISOString()`). */
  ts: string;
  /** Channel name (e.g. `"whatsapp"`). */
  channel: string;
  /** 8-char SHA-256 prefix of the non-owner senderId; surfaces a stable
   *  identifier to the user without leaking the raw JID. */
  senderHash: string;
  /** Tool the agent attempted (e.g. `"Bash"`, `"mcp__clawcode__skill_install"`). */
  toolName: string;
  /** Always `"would-block"` in shadow mode. Enforce-mode blocks don't
   *  emit shadow events (they emit stderr instead). */
  decision: "would-block";
  /** Resolved mode after coercion (`"shadow"`). */
  effectiveMode: "shadow";
  /** Resolved policy (`"denylist"` | `"allowlist"`). */
  policy: "denylist" | "allowlist";
  /** Expanded tool list applied to the decision (after defaults +
   *  user-config override). Recorded so review can spot config drift. */
  expandedTools: string[];
  /** Bumped per breaking change to the hook contract. Lets shadow events
   *  remain interpretable across upgrades. */
  hookVersion: number;
  /** SHA-256-8 of the serialized `execGate` config block. Detects
   *  silent config edits between shadow and enforce. */
  configHash: string;
  /** Effective lookback window in ms (after coercion). */
  lookbackMs: number;
  /** Count of valid envelopes the resolver saw in this window. */
  windowEnvelopeCount: number;
  /** Codex Phase 8 round-1 MEDIUM: when a 1.6 legacy global trust file
   *  for this channel would have unlocked under 1.6 semantics but no
   *  workspace-scoped trust file exists, this flag is `true`. Surfaces
   *  the silent shadow-mode degradation that users would otherwise miss
   *  until they flip to enforce. Defaults false (post-1.7 native state). */
  legacyGlobalExecTrustIgnored?: boolean;
}

export interface AppendOptions {
  /** Absolute path to the shadow log directory (typically `<workspace>/memory`). */
  logDir: string;
  /** Optional override for the canonical filename; default
   *  `.execgate-shadow.jsonl`. Test-only. */
  fileName?: string;
}

export interface AppendResult {
  ok: boolean;
  reason?: "symlink" | "lock-timeout" | "io-error" | "rotation-failed";
}

const DEFAULT_FILE_NAME = ".execgate-shadow.jsonl";

/**
 * Append a single event to the shadow log. Best-effort + atomic-ish:
 * - Acquires an advisory lock (O_EXCL mkdir) before any write.
 * - Rotates the log when its current size + event line would exceed the cap.
 * - Releases the lock in `finally`.
 *
 * Returns `{ok:false, reason}` on any failure; callers MUST NOT crash
 * on a shadow log failure (the gate still allows the tool to run because
 * shadow mode never blocks).
 */
export function appendShadowEvent(
  event: ShadowEvent,
  opts: AppendOptions
): AppendResult {
  const fileName = opts.fileName ?? DEFAULT_FILE_NAME;
  const logPath = path.join(opts.logDir, fileName);
  const backupPath = `${logPath}.1`;
  const lockDir = path.join(opts.logDir, `${fileName}.lock`);

  try {
    fs.mkdirSync(opts.logDir, { recursive: true });
  } catch {
    return { ok: false, reason: "io-error" };
  }

  // Acquire lock with short timeout.
  const lockAcquired = acquireLock(lockDir, SHADOW_LOG_LOCK_TIMEOUT_MS);
  if (!lockAcquired) return { ok: false, reason: "lock-timeout" };

  try {
    // Codex round-1 WARN 5: TOCTOU-free symlink defense via O_NOFOLLOW
    // open + fstat on the fd. The previous lstat→appendFileSync pair
    // had a race window where a same-uid attacker could swap the path
    // to a symlink after the lstat and before the append. O_NOFOLLOW
    // makes the open itself fail on symlinks; fstat (vs stat) reads
    // through the descriptor.
    const NOFOLLOW =
      typeof (fs.constants as Record<string, number>).O_NOFOLLOW === "number"
        ? (fs.constants as Record<string, number>).O_NOFOLLOW
        : 0;
    const flags =
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW;

    // Probe current size for rotation decision. lstat is safe here (it
    // does not follow symlinks); if it IS a symlink we'll fail at the
    // O_NOFOLLOW open below.
    let canonicalSt: fs.Stats | null = null;
    try {
      canonicalSt = fs.lstatSync(logPath);
    } catch {
      canonicalSt = null;
    }
    if (canonicalSt && canonicalSt.isSymbolicLink()) {
      return { ok: false, reason: "symlink" };
    }
    if (canonicalSt && !canonicalSt.isFile()) {
      return { ok: false, reason: "symlink" };
    }

    const line = JSON.stringify(event) + "\n";
    const currentSize = canonicalSt ? canonicalSt.size : 0;

    // Rotate BEFORE the write if adding the line would push us over.
    if (currentSize + line.length > SHADOW_LOG_MAX_BYTES) {
      try {
        if (currentSize > 0) {
          fs.renameSync(logPath, backupPath);
        }
      } catch {
        try {
          fs.unlinkSync(logPath);
        } catch {
          // ignore
        }
      }
    }

    // Open with O_NOFOLLOW + O_APPEND + O_CREAT, then fstat to confirm
    // we got a regular file owned by us at mode 0o077-clean.
    let fd: number;
    try {
      fd = fs.openSync(logPath, flags, 0o600);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // ELOOP = symlink encountered with O_NOFOLLOW (POSIX). Treat
      // either as symlink rejection.
      if (e.code === "ELOOP") return { ok: false, reason: "symlink" };
      return { ok: false, reason: "io-error" };
    }

    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return { ok: false, reason: "symlink" };
      if (process.platform !== "win32" && typeof process.getuid === "function") {
        if (st.uid !== process.getuid()) return { ok: false, reason: "symlink" };
      }
      const buf = Buffer.from(line, "utf-8");
      fs.writeSync(fd, buf, 0, buf.length);
      // Defensive mode set (creation path may not honor mode arg on
      // pre-existing files).
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // best-effort
      }
    } catch {
      return { ok: false, reason: "io-error" };
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  } finally {
    releaseLock(lockDir);
  }

  return { ok: true };
}

function acquireLock(lockDir: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        // Codex round-1 WARN 6: stale-lock recovery uses
        // SHADOW_LOG_STALE_LOCK_MS (30 s) — conservative enough that
        // legitimate slow disks don't get false-reclaimed mid-write.
        try {
          const st = fs.statSync(lockDir);
          if (Date.now() - st.mtimeMs > SHADOW_LOG_STALE_LOCK_MS) {
            try {
              fs.rmdirSync(lockDir);
              continue;
            } catch {
              // race with another writer cleaning up — fall through
            }
          }
        } catch {
          // can't stat — let the loop retry
        }
        // Spin briefly.
        const waitUntil = Date.now() + SHADOW_LOG_LOCK_POLL_MS;
        while (Date.now() < waitUntil) {
          // busy-wait — keep it tiny
        }
        continue;
      }
      // Any other error → can't acquire.
      return false;
    }
  }
  return false;
}

function releaseLock(lockDir: string): void {
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // already gone — ok
  }
}
