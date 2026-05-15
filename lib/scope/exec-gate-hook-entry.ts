/**
 * Hook entry point — reads PreToolUse stdin JSON, builds the
 * resolver's `ArmedChannel[]`, calls `resolve()`, and exits with the
 * decision encoded in shell-friendly form.
 *
 * Bundled to `dist/exec-gate-resolver.cjs` via esbuild so the hook
 * script can invoke a single .cjs file with ~30-50ms cold start —
 * well under the 50ms armed-path target. `tsx` at runtime (~150-200ms)
 * is too slow for the hot path.
 *
 * Stdin: PreToolUse JSON payload from Claude Code. Fields used:
 *   - tool_name
 *   - tool_input
 *   - cwd (for protected-path resolution)
 *
 * Env vars:
 *   - CLAUDE_PROJECT_DIR (workspace root, fallback to `cwd` from stdin)
 *   - CLAUDE_PLUGIN_ROOT (plugin's installed path)
 *
 * Exit codes:
 *   - 0 = allow (decision="allow" OR decision="shadow")
 *   - 2 = block (stderr contains the reason)
 *
 * All errors are fail-soft → exit 0 (decision="allow"). The hook MUST
 * NEVER block legitimate tool work due to plugin internals.
 */

import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../config.ts";
import {
  detectScopeRuntime,
  resolveWhatsappChannelDir,
  discoverAllChannelGovernanceDirs,
} from "./runtime.ts";
import {
  resolve as resolveExecGate,
  execGateConfigForChannel,
  DEFAULT_DENYLIST_TOOLS,
  type ArmedChannel,
} from "./exec-gate.ts";
import { loadAccess, type AccessCacheEntry } from "./whatsapp.ts";

async function main(): Promise<number> {
  let stdin: string;
  try {
    stdin = await readStdin();
  } catch {
    return 0; // fail-soft
  }

  let payload: { tool_name?: unknown; tool_input?: unknown; cwd?: unknown };
  try {
    payload = JSON.parse(stdin);
  } catch {
    return 0;
  }

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (!toolName) return 0;

  const toolInput = payload.tool_input ?? {};

  // Codex Phase 8 round-2 NEW-HIGH: normalize workspaceRoot at the hook
  // boundary. `CLAUDE_PROJECT_DIR` may be empty (uncommon but observed)
  // or unset; `payload.cwd` may be missing or relative. The fingerprint
  // helper at trust.ts throws on empty/non-absolute input, and the
  // top-level hook `.catch(() => process.exit(0))` (line 420) is
  // fail-OPEN. So an unhandled throw here would silently un-arm the
  // gate. We resolve to an absolute path explicitly here, then fail
  // CLOSED (exit 2) if even that fails.
  const rawWorkspaceRoot =
    process.env.CLAUDE_PROJECT_DIR ??
    (typeof payload.cwd === "string" ? payload.cwd : "");
  let workspaceRoot: string;
  try {
    const candidate =
      typeof rawWorkspaceRoot === "string" && rawWorkspaceRoot.length > 0
        ? rawWorkspaceRoot
        : process.cwd();
    // Codex Phase 8 round-3 LOW: NUL-byte hardening. `path.resolve` and
    // `path.isAbsolute` both accept NUL bytes silently on POSIX, and Node
    // file I/O later rejects them with a confusing ERR_INVALID_ARG_VALUE
    // somewhere deep in the resolver. Reject at the boundary so the hook
    // fails closed with a clear diagnostic instead of leaking the error
    // to the silent top-level catch (which would be fail-open).
    if (candidate.indexOf("\0") !== -1) {
      throw new Error("workspaceRoot contains NUL byte");
    }
    workspaceRoot = path.resolve(candidate);
    if (!path.isAbsolute(workspaceRoot) || workspaceRoot.length === 0) {
      throw new Error("workspaceRoot did not resolve to absolute path");
    }
  } catch {
    process.stderr.write(
      "exec-gate: unable to resolve workspaceRoot (CLAUDE_PROJECT_DIR/cwd invalid) — fail-closed\n"
    );
    return 2;
  }
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? path.resolve(__dirname, "..", "..");
  const memoryDir = path.join(workspaceRoot, "memory");

  // Build ArmedChannel[] from config + runtime. Same path the in-process
  // server would take, but invoked from a hook subprocess.
  //
  // loadConfig reads `<workspace>/agent-config.json` (matches the
  // in-process server's `loadConfig(WORKSPACE)` at server.ts:101).
  //
  // Codex Step 2 post-impl round-1 FAIL A: when ANY enforce/shadow
  // channel is configured but its runtime governance is unresolvable,
  // we must NOT silently fall back to "no armed channels" (the
  // resolver's step-2 short-circuit). Push the channel onto `armed[]`
  // with `unresolved: true` so the resolver synthesizes a non-owner
  // hit and the gate fires. This is the explicit "fail closed on
  // missing access" rule.
  const armed: ArmedChannel[] = [];
  /**
   * Codex round-3 MEDIUM: protected-paths must cover access.json even
   * for channels whose `execGate.mode === "off"`. An attacker who
   * corrupted access.json of an off-mode channel could permanently
   * break read-scope governance later (the read filter would fail-open
   * via bootstrap masquerade). Collect channel-dirs for ALL known
   * channels separately from `armed[]`, gated only on "channel is
   * configured AND we can resolve its directory" — independent of
   * execGate state.
   */
  const protectedChannelDirs: string[] = [];
  // Single-process cache for loadAccess — hook is short-lived, but
  // the function requires a Map argument. Empty Map is fine.
  const accessCache = new Map<string, AccessCacheEntry>();

  // Step 1: load config. If it throws, every non-off channel in the
  // CONFIG (we can re-read the raw JSON defensively if needed) must
  // still arm with unresolved=true. But the simplest fail-closed
  // posture is: when we can't introspect the config at all, push a
  // synthetic "unknown" channel for every channel name we know about
  // as a generic-armed entry. We don't actually know what's configured
  // so the safest move is to NOT fail closed for the global case (it
  // would block tool calls for users who never opted in) — instead,
  // try a second read of the raw config file to extract `scope.*` keys
  // and execGate.mode values directly.
  const configResult = tryLoadConfig(workspaceRoot);
  if (configResult.ok) {
    const cfg = configResult.config;
    // Codex round-2 HIGH 2: synthesize unresolved sentinels for
    // channels whose RAW value was non-object. mergeScopeConfig
    // silently dropped them; without this branch they'd be invisible.
    for (const channel of configResult.malformedChannels) {
      armed.push({
        channel,
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: 60_000,
        },
        unresolved: true,
      });
    }
    if (cfg.scope) {
      let runtime: ReturnType<typeof detectScopeRuntime> | null = null;
      try {
        runtime = detectScopeRuntime(cfg, workspaceRoot);
      } catch {
        runtime = null;
      }
      const channelsToEnumerate = new Set<ArmedChannel["channel"]>([
        ...(Object.keys(runtime?.channels ?? {}) as ArmedChannel["channel"][]),
        ...(Object.keys(cfg.scope) as ArmedChannel["channel"][]),
      ]);
      for (const channel of channelsToEnumerate) {
        let execGate;
        try {
          execGate = execGateConfigForChannel(cfg.scope, channel);
        } catch {
          // Coercion threw → fail-closed: synthesize an enforce config.
          // Coerce path is pure but defensive try keeps the entry script
          // panic-free against future changes.
          //
          // Codex round-2 LOW 1: use DEFAULT_DENYLIST_TOOLS so denylist
          // policy actually blocks the destructive set, not just the
          // hard-deny pair (Bash/Task).
          armed.push({
            channel,
            channelDir: "",
            ownerJids: [],
            execGate: {
              mode: "enforce",
              policy: "denylist",
              tools: [...DEFAULT_DENYLIST_TOOLS],
              lookbackMs: 60_000,
            },
            unresolved: true,
          });
          continue;
        }
        if (execGate.mode === "off") continue;
        // Channel-dir resolution lives in `resolveWhatsappChannelDir`
        // today (Phase 4a-2.6). When new channels publish their own
        // resolver, extend this switch.
        let channelDir: string | null = null;
        try {
          if (channel === "whatsapp") {
            channelDir = resolveWhatsappChannelDir(cfg, workspaceRoot);
          }
        } catch {
          channelDir = null;
        }
        if (!channelDir) {
          // Can't find the channel-dir → unresolvable. Fail-closed.
          armed.push({
            channel,
            channelDir: "",
            ownerJids: [],
            execGate,
            unresolved: true,
          });
          continue;
        }
        let access;
        try {
          access = loadAccess(path.join(channelDir, "access.json"), accessCache);
        } catch {
          access = { resolvable: false, access: null } as ReturnType<typeof loadAccess>;
        }
        if (!access.resolvable || !access.access) {
          // access.json missing/corrupt/unreadable → unresolvable.
          // Fail-closed (Codex FAIL A).
          armed.push({
            channel,
            channelDir,
            ownerJids: [],
            execGate,
            unresolved: true,
          });
          continue;
        }
        armed.push({
          channel,
          channelDir,
          ownerJids: access.access.ownerJids ?? [],
          execGate,
        });
      }
    }
  } else if (configResult.armPolicy === "fail-closed") {
    // Config file existed but parse threw. We can't inspect scope, so
    // fail-closed conservatively: push a synthetic enforce entry for
    // EVERY known scope channel. The protected-paths check still fires
    // independently; this adds the non-owner-present synthesis to
    // ensure denylist tools (Bash, Write, etc.) get blocked.
    //
    // We don't have channel names from a parse-failed config; use the
    // canonical scope channel list mirrored from runtime.ts.
    for (const channel of KNOWN_SCOPE_CHANNELS) {
      armed.push({
        channel,
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: 60_000,
        },
        unresolved: true,
      });
    }
  }
  // configResult.armPolicy === "noop" (file absent) → no armed channels.
  // Step 2 short-circuit in the resolver handles this. The
  // protected-paths check still fires.

  // Codex round-4 MEDIUM 1+2: mode-independent discovery of channel
  // governance dirs. Covers BOTH the `mode: "off"` configured case
  // (where `resolveWhatsappChannelDir` returns null) AND the
  // entirely-absent-scope case (project-local `.whatsapp/access.json`
  // still gets protected if a paired install is auto-discoverable).
  //
  // Best-effort: this never throws, never blocks the hook, and only
  // adds discovered dirs that already exist on disk. The classifier's
  // realpath canonicalization handles symlinks.
  try {
    const cfgForDiscovery = configResult.ok ? configResult.config : undefined;
    const extraDirs = discoverAllChannelGovernanceDirs(
      cfgForDiscovery,
      workspaceRoot
    );
    for (const d of extraDirs) {
      if (!protectedChannelDirs.includes(d)) protectedChannelDirs.push(d);
    }
  } catch {
    // Discovery failed — protected paths beyond the static list are
    // skipped. Static protected paths (plugin hooks, ssh, etc.) still
    // fire.
  }

  const decision = resolveExecGate({
    toolName,
    toolInput,
    pluginRoot,
    workspaceRoot,
    memoryDir,
    armed,
    protectedChannelDirs,
  });

  if (decision.decision === "block") {
    process.stderr.write(decision.reason + "\n");
    return 2;
  }
  // "allow" or "shadow" → exit 0. Shadow has already been recorded
  // via the resolver's effects.recordShadow callback.
  return 0;
}

/**
 * Wrapper around `loadConfig` that distinguishes "file absent" (legitimate
 * — no opt-in, allow) from "file present but unreadable" (parse error /
 * permission denied — fail closed so a corrupt agent-config.json can't
 * silently re-open the gate).
 *
 * Note: `loadConfig` itself swallows parse errors and returns
 * `DEFAULT_CONFIG`. That's the right behavior for the in-process server
 * (it should boot with defaults rather than crash) but the WRONG
 * behavior for the exec-gate hook (a malformed config would silently
 * re-open the gate). So we re-parse the raw file here before calling
 * `loadConfig`, and only proceed to the defaults-merge path if our
 * pre-parse succeeds. A parse failure routes through `fail-closed`.
 *
 * Codex round-2 HIGH 2: `mergeScopeConfig` (in `lib/config.ts:340`)
 * silently drops `scope.<channel>` values that aren't objects (e.g.
 * `scope.whatsapp: "bogus"`). The merged `cfg.scope` would have no
 * `whatsapp` key and the entry script's enumeration would skip it,
 * fail-opening the gate. To close that hole we also surface a list of
 * malformed channel names from the RAW pre-merge JSON.
 */
type ConfigLoadResult =
  | {
      ok: true;
      config: ReturnType<typeof loadConfig>;
      /** Channels whose RAW value in agent-config.json is malformed
       *  (non-object). The entry will synthesize unresolved sentinels
       *  for these so the gate fires. */
      malformedChannels: ArmedChannel["channel"][];
    }
  | { ok: false; armPolicy: "noop" | "fail-closed" };

const KNOWN_SCOPE_CHANNELS = [
  "whatsapp",
  "telegram",
  "discord",
  "imessage",
  "webchat",
] as const;

function tryLoadConfig(workspaceRoot: string): ConfigLoadResult {
  const configPath = path.join(workspaceRoot, "agent-config.json");
  let exists = false;
  try {
    exists = fs.existsSync(configPath);
  } catch {
    // existsSync should not throw, but be conservative — fail closed.
    return { ok: false, armPolicy: "fail-closed" };
  }
  if (!exists) {
    return { ok: false, armPolicy: "noop" };
  }
  // Defensive pre-parse: catches malformed-JSON-but-file-exists. Without
  // this, `loadConfig`'s internal catch returns DEFAULT_CONFIG with
  // `scope: undefined`, and the hook silently allows.
  let rawJson: unknown;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    rawJson = JSON.parse(raw);
  } catch {
    return { ok: false, armPolicy: "fail-closed" };
  }
  // Codex round-2 HIGH 2: detect malformed channel values pre-merge.
  // `mergeScopeConfig` silently skips non-object channel entries, so by
  // the time the entry inspects `cfg.scope`, those channels look like
  // they were never configured. Surface the raw shape so we can synth
  // unresolved sentinels.
  const malformedChannels: ArmedChannel["channel"][] = [];
  const rawScope = (rawJson as { scope?: unknown })?.scope;
  if (rawScope && typeof rawScope === "object" && !Array.isArray(rawScope)) {
    for (const channel of KNOWN_SCOPE_CHANNELS) {
      const v = (rawScope as Record<string, unknown>)[channel];
      if (v === undefined) continue;
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        malformedChannels.push(channel);
      }
    }
  }
  try {
    return {
      ok: true,
      config: loadConfig(workspaceRoot),
      malformedChannels,
    };
  } catch {
    return { ok: false, armPolicy: "fail-closed" };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 256 * 1024; // 256 KB defensive cap on stdin payload
  return await new Promise<string>((resolveProm, rejectProm) => {
    process.stdin.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        rejectProm(new Error("stdin too large"));
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      resolveProm(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", rejectProm);
  });
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch(() => {
    process.exit(0); // fail-soft
  });

// Defensive: avoid hanging if stdin emits no data on some environments.
// Without a max-wait, the hook would block forever on a misconfigured caller.
setTimeout(() => {
  process.exit(0);
}, 5_000).unref();
