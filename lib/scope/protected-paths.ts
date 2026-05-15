/**
 * Always-on protected-paths classifier for the execution gate hook.
 *
 * Independent of `scope.<channel>.execGate.mode` and of any user-configured
 * `denylist`/`allowlist` — this list is hard-coded and refuses writes from
 * MCP-side write tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) to a
 * fixed set of self-protecting paths.
 *
 * The Bash tool is NOT consulted here: shell command grammar is too rich
 * to safely parse for output redirection (`tee`, `dd of=`, `>`, `>>`,
 * process substitution, heredocs). When the gate is armed and a non-owner
 * envelope is in the lookback window, Bash is hard-denied wholesale; this
 * module's protected-paths apply on top of that as a defense-in-depth
 * layer for the write-tool surface.
 *
 * Pure-function: callers pass `tool_input.file_path` (or `notebook_path`),
 * `pluginRoot` and `workspaceRoot`. Returns `null` when the path is fine
 * to write, or a string reason when it's refused. Uses `path.resolve`
 * (no filesystem touch) so the classifier is deterministic and testable
 * without setting up real files.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "./canonical-path.ts";

/** Reasons surfaced via stderr when a protected path is refused. */
export type ProtectedPathReason =
  | "plugin-hooks"
  | "plugin-manifest"
  | "plugin-mcp-config"
  | "workspace-mcp-config"
  | "workspace-agent-config"
  | "exec-gate-source"
  | "agent-config-guard-source"
  | "scope-trust-dir"
  | "claude-home"
  | "ssh-dir"
  | "credential-dir"
  | "shell-init"
  | "launch-agent"
  | "systemd-user"
  | "channel-access-json";

export interface ProtectedPathHit {
  reason: ProtectedPathReason;
  matchedPrefix: string;
}

export interface ClassifyOptions {
  /** Absolute path to the running plugin root (`CLAUDE_PLUGIN_ROOT`). */
  pluginRoot: string;
  /** Absolute path to the workspace cwd (`CLAUDE_PROJECT_DIR`). */
  workspaceRoot: string;
  /** Test override; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Test override; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /**
   * Codex round-2 MEDIUM: channel governance files (`<channel-dir>/access.json`)
   * become a DoS surface if corruptible — the entry script falls into the
   * `unresolved` sentinel path and blocks every owner turn until the file
   * is manually repaired. Pass the runtime-resolved channel-dirs in to
   * harden the protected list. Empty array (the default) preserves prior
   * behavior; the resolver populates it from `armed[]`.
   */
  channelDirs?: string[];
}

/**
 * Return `null` if the path is not protected, or a `ProtectedPathHit`
 * describing which root the path resolves under. Longest-prefix-wins
 * is implicit in the iteration order (specific files before broader
 * directories).
 *
 * Realpath canonicalization (Codex round-1 BLOCKER 3): we canonicalize
 * `abs` AND every protected root via `realpathSync` of the deepest
 * existing ancestor before comparing. This defeats two bypass surfaces:
 *   - **Symlink alias**: `/Users/me` symlinked to `/Volumes/Data/Users/me`
 *     means an attacker calling Write on `/Volumes/Data/Users/me/.ssh/...`
 *     would skip a naive string-prefix check against `/Users/me/.ssh/`.
 *   - **Case-insensitive filesystems** (APFS/HFS on darwin, NTFS on
 *     win32): `~/.Claude/Agent/Scope-Trust/...` resolves to the canonical
 *     lowercase form. Compare case-folded on those platforms.
 *
 * If the input or the protected root doesn't exist yet (a Write may be
 * creating a new file in a directory that exists), the helper falls
 * back to canonicalizing the deepest existing ancestor and joining the
 * remaining segments verbatim.
 */
export function classifyProtectedPath(
  rawPath: string,
  opts: ClassifyOptions
): ProtectedPathHit | null {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;

  const home = opts.homeDir ?? os.homedir();
  const platform = opts.platform ?? process.platform;
  const caseFold = platform === "darwin" || platform === "win32";

  // Expand leading `~` / `~/` to the home dir before resolve.
  let expanded = rawPath;
  if (expanded === "~") expanded = home;
  else if (expanded.startsWith("~/")) expanded = path.join(home, expanded.slice(2));

  // Resolve relative paths against the workspace cwd (matches how
  // Claude Code resolves `tool_input.file_path` when the agent passes
  // a relative path like `hooks/hooks.json`).
  const absResolved = path.resolve(opts.workspaceRoot, expanded);
  const abs = canonicalize(absResolved, caseFold);

  // Specific files first (so a hit on plugin.json doesn't get masked
  // by the broader plugin-root directory check that doesn't exist —
  // we intentionally don't protect ALL of the plugin root, only the
  // surfaces that control behavior or store credentials).
  const specificFiles: Array<[string, ProtectedPathReason]> = [
    [path.join(opts.pluginRoot, ".claude-plugin", "plugin.json"), "plugin-manifest"],
    [path.join(opts.pluginRoot, ".mcp.json"), "plugin-mcp-config"],
    [path.join(opts.workspaceRoot, ".mcp.json"), "workspace-mcp-config"],
    [path.join(opts.workspaceRoot, "agent-config.json"), "workspace-agent-config"],
    [path.join(opts.pluginRoot, "lib", "scope", "exec-gate.ts"), "exec-gate-source"],
    [path.join(opts.pluginRoot, "lib", "scope", "exec-gate-hook-entry.ts"), "exec-gate-source"],
    [path.join(opts.pluginRoot, "lib", "scope", "agent-config-guard.ts"), "agent-config-guard-source"],
    [path.join(opts.pluginRoot, "lib", "scope", "protected-paths.ts"), "exec-gate-source"],
    [path.join(opts.pluginRoot, "hooks", "hooks.json"), "plugin-hooks"],
    [path.join(opts.pluginRoot, "hooks", "exec-gate-pretool.sh"), "plugin-hooks"],
    [path.join(opts.pluginRoot, "dist", "exec-gate-resolver.cjs"), "exec-gate-source"],
  ];
  // Codex round-2 MEDIUM: protect channel-dir access.json files. Adding
  // them as exact-path matches (each resolved channel-dir contributes
  // one entry) so an attacker can't soft-DoS the owner by corrupting
  // governance.
  for (const cd of opts.channelDirs ?? []) {
    if (typeof cd !== "string" || cd.length === 0) continue;
    specificFiles.push([path.join(cd, "access.json"), "channel-access-json"]);
  }

  for (const [target, reason] of specificFiles) {
    if (abs === canonicalize(target, caseFold)) {
      return { reason, matchedPrefix: target };
    }
  }

  // Shell init files — exact path match (rc files are individual, not
  // a directory). Persistent code execution surface on next shell launch.
  const shellInitFiles = [
    path.join(home, ".bashrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".profile"),
    path.join(home, ".zshrc"),
    path.join(home, ".zprofile"),
    path.join(home, ".zshenv"),
    path.join(home, ".config", "fish", "config.fish"),
  ];
  for (const target of shellInitFiles) {
    if (abs === canonicalize(target, caseFold)) {
      return { reason: "shell-init", matchedPrefix: target };
    }
  }

  // Directory roots — anything under these is refused.
  const dirRoots: Array<[string, ProtectedPathReason]> = [
    [path.join(opts.pluginRoot, "hooks") + path.sep, "plugin-hooks"],
    [path.join(home, ".claude", "agent", "scope-trust") + path.sep, "scope-trust-dir"],
    [path.join(home, ".claude") + path.sep, "claude-home"],
    [path.join(home, ".ssh") + path.sep, "ssh-dir"],
    [path.join(home, ".aws") + path.sep, "credential-dir"],
    [path.join(home, ".gnupg") + path.sep, "credential-dir"],
    [path.join(home, ".kube") + path.sep, "credential-dir"],
    [path.join(home, ".docker") + path.sep, "credential-dir"],
  ];

  // macOS-only LaunchAgents.
  if (platform === "darwin") {
    dirRoots.push([
      path.join(home, "Library", "LaunchAgents") + path.sep,
      "launch-agent",
    ]);
  }

  // Linux user systemd units.
  if (platform === "linux") {
    dirRoots.push([
      path.join(home, ".config", "systemd", "user") + path.sep,
      "systemd-user",
    ]);
  }

  // Sort longest-prefix first so `scope-trust/` matches before the
  // broader `~/.claude/` claim.
  dirRoots.sort((a, b) => b[0].length - a[0].length);

  // Add a trailing separator to `abs` so a directory whose name equals
  // a protected root (without a child component) still matches.
  const absWithSep = abs + path.sep;
  for (const [prefix, reason] of dirRoots) {
    const canonicalRoot = canonicalize(prefix.slice(0, -1), caseFold);
    const canonicalRootWithSep = canonicalRoot + path.sep;
    if (abs === canonicalRoot) {
      return { reason, matchedPrefix: prefix };
    }
    if (absWithSep.startsWith(canonicalRootWithSep)) {
      return { reason, matchedPrefix: prefix };
    }
  }

  return null;
}

// `canonicalize` was extracted to `./canonical-path.ts` (Phase 8 / Codex
// round-1 HIGH #7) so the scope-trust primitive can reuse it without
// pulling in the protected-paths classifier. The named import at the top
// of this file uses the same implementation.

/**
 * Subset of tool names for which `tool_input.file_path` / `notebook_path`
 * is consulted against the protected-paths list. Bash is intentionally
 * NOT in this list — Bash gets hard-denied entirely when the gate is
 * armed and a non-owner envelope is in the window (see exec-gate.ts).
 */
export const PROTECTED_PATH_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Pull the path arg from a tool input. Returns `null` for tools that
 * don't carry a file-path argument (Bash, Read-only ops, etc.).
 */
export function extractToolPath(
  toolName: string,
  toolInput: unknown
): string | null {
  if (!PROTECTED_PATH_TOOLS.has(toolName)) return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const o = toolInput as Record<string, unknown>;
  if (toolName === "NotebookEdit") {
    if (typeof o.notebook_path === "string") return o.notebook_path;
    return null;
  }
  if (typeof o.file_path === "string") return o.file_path;
  return null;
}
