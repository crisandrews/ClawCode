/**
 * Lifecycle file-watcher for scope runtime cache invalidation.
 *
 * Watches `~/.claude/plugins/installed_plugins.json` (or the parent
 * `~/.claude/plugins/` directory if the file doesn't exist yet) and
 * calls `clearScopeRuntimeCache()` on change. Closes the Phase 4a-1
 * deferred WATCH item: between `/agent:scope disable whatsapp` (or a
 * plugin uninstall that removes the WhatsApp adapter source) and the
 * `RUNTIME_TTL_MS = 5 s` cache expiry, a stale armed snapshot could
 * have survived. With this watcher in place, a plugin-state change
 * triggers immediate re-detection on the next request.
 *
 * Pattern follows `lib/live-config.ts:93+` — watch the PARENT dir
 * with `{ persistent: false }` and filter by basename so atomic
 * replace (editor temp-file rename) doesn't permanently break the
 * watcher.
 *
 * Designed to be inert when no plugins directory exists. The startup
 * caller can register the watcher unconditionally.
 *
 * Threat model: a hostile same-user process could touch the plugins
 * file to force cache thrashing. The callback is cheap (one Map field
 * write) and 500ms-debounced, so the practical cost is bounded.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearScopeRuntimeCache } from "./runtime.ts";

export interface LifecycleWatcherHandle {
  /** Stop watching and clear pending debounce. Idempotent. */
  close(): void;
  /** True iff a real fs.watch handle is currently active. */
  active(): boolean;
}

const DEFAULT_DEBOUNCE_MS = 500;

export interface StartLifecycleWatcherOptions {
  /** Override path to the plugins file. Defaults to `~/.claude/plugins/installed_plugins.json`. */
  pluginsFilePath?: string;
  /** Override debounce window. Default 500ms. */
  debounceMs?: number;
  /**
   * Hook fired AFTER the cache is cleared. Tests use this to assert
   * that a write triggered the callback. Production callers leave it
   * undefined.
   */
  onChange?: () => void;
}

/**
 * Start a lifecycle watcher. Returns a handle the caller can close
 * on shutdown. Failures are best-effort — if the parent directory
 * can't be watched, the handle is returned with `active() === false`
 * and no callbacks fire. Safe to call multiple times; subsequent
 * calls are independent watchers (caller should close the prior
 * handle if reusing the slot).
 */
export function startLifecycleWatcher(
  options: StartLifecycleWatcherOptions = {}
): LifecycleWatcherHandle {
  const pluginsFilePath =
    options.pluginsFilePath ??
    path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const dir = path.dirname(pluginsFilePath);
  const basename = path.basename(pluginsFilePath);

  // Ensure the parent directory exists before we ask `fs.watch` to
  // observe it. We never CREATE plugin state — if the dir is missing,
  // there are simply no plugins, and the watcher stays dormant until
  // the dir appears (a separate, deeper watcher would be required to
  // watch ~/.claude itself; out of scope for the privacy story).
  let watcher: fs.FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fire = () => {
    clearScopeRuntimeCache();
    options.onChange?.();
  };

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fire, debounceMs);
    // Codex round 1 HIGH (server.ts signal handler removal): unref the
    // debounce timer so a pending fire does NOT keep the event loop
    // alive. Combined with `{ persistent: false }` on the fs.watch
    // call, this means we don't need SIGINT/SIGTERM handlers — the
    // OS reclaims the watcher fd on exit and the loop drains cleanly.
    if (typeof timer.unref === "function") timer.unref();
  };

  try {
    if (fs.existsSync(dir)) {
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        if (filename !== basename) return;
        trigger();
      });
      watcher.on("error", () => {
        // Filesystem event errors are non-fatal — same posture as live-config.
        // The next /mcp reconnect re-runs detection anyway.
      });
    }
  } catch {
    watcher = null;
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {}
        watcher = null;
      }
    },
    active() {
      return watcher !== null;
    },
  };
}
