/**
 * Channel detector — surface status of messaging channel plugins without
 * touching the network or executing them. All functions are read-only and
 * safe to call repeatedly.
 *
 * "Channels" here are messaging plugins (WhatsApp, Telegram, Discord, iMessage,
 * Slack, Fakechat). We detect them by scanning Claude Code's plugin cache,
 * inspect per-channel auth artifacts (heuristics), and produce a launch
 * command the user can copy or hand to /agent:service.
 *
 * We do NOT:
 *   - install channels (that's /agent:messaging)
 *   - authenticate (per-channel skills like /whatsapp:configure do that)
 *   - restart Claude Code (user runs the command)
 */

import fs from "fs";
import os from "os";
import path from "path";

export type ChannelName =
  | "whatsapp"
  | "telegram"
  | "discord"
  | "imessage"
  | "slack"
  | "fakechat"
  // `webchat` is a scope-only channel. It has no CHANNEL_REGISTRY entry
  // (not launchable as a Claude Code plugin — it's the in-process HTTP
  // bridge). Listed here so `lib/scope/*` can use a single ChannelName
  // type without secondary union games.
  | "webchat";

export type ChannelKind =
  | "development" // requires --dangerously-load-development-channels
  | "official"    // requires --channels
  | "integration" // not a Claude Code channel, e.g. Claude in Slack
  | "none";       // not a channel we launch (just metadata)

export interface ChannelRegistryEntry {
  name: ChannelName;
  /** Display label. */
  label: string;
  /** Claude Code launch kind. */
  kind: ChannelKind;
  /** Plugin id used in launch flags. e.g. "plugin:whatsapp@claude-whatsapp". Empty for integration/none. */
  pluginId: string;
  /** Substring(s) to look for in plugin-cache directory names. */
  cacheMarkers: string[];
  /** Required OS, if any. */
  os?: "darwin" | "linux" | "win32";
  /** File or env var that indicates the channel is authenticated. */
  authProbe: AuthProbe;
  /** Setup skill for this channel. */
  setupHint: string;
}

interface AuthProbePath {
  kind: "path";
  /** Static path patterns (use `~/` or absolute). First hit wins. */
  paths?: string[];
  /**
   * Dynamic paths computed from (home, cwd). Used for plugins whose state
   * dir depends on install scope / project (e.g. claude-whatsapp).
   * When present, takes precedence over `paths`.
   */
  dynamicPaths?: (home: string, cwd: string) => string[];
}
interface AuthProbeEnv {
  kind: "env";
  vars: string[];
}
interface AuthProbeNone {
  kind: "none";
  note: string;
}
type AuthProbe = AuthProbePath | AuthProbeEnv | AuthProbeNone;

// ---------------------------------------------------------------------------
// Static registry
// ---------------------------------------------------------------------------

export const CHANNEL_REGISTRY: ChannelRegistryEntry[] = [
  {
    name: "whatsapp",
    label: "WhatsApp",
    kind: "development",
    pluginId: "plugin:whatsapp@claude-whatsapp",
    cacheMarkers: ["claude-whatsapp", "whatsapp"],
    authProbe: {
      kind: "path",
      // Probe `status.json` — part of claude-whatsapp's public state contract
      // (README → "State contract for companion plugins"). It is only written
      // by the plugin after a real connection event, so its presence is a
      // reliable proxy for "paired and connected at least once".
      // Checking `auth/` (a directory) would false-positive because the plugin
      // creates it empty at startup before any pairing.
      dynamicPaths: (home, cwd) => {
        const out: string[] = [];
        const projectDir = detectWhatsappProjectDir(home, cwd);
        if (projectDir) {
          out.push(path.join(projectDir, ".whatsapp", "status.json"));
        }
        out.push(path.join(home, ".claude", "channels", "whatsapp", "status.json"));
        return out;
      },
    },
    setupHint: "/agent:messaging whatsapp → /whatsapp:configure (scan QR)",
  },
  {
    name: "telegram",
    label: "Telegram",
    kind: "official",
    pluginId: "plugin:telegram@claude-plugins-official",
    cacheMarkers: ["telegram"],
    authProbe: {
      kind: "path",
      paths: [
        "~/.claude/channels/telegram/session.json",
        "~/.claude/channels/telegram/config.json",
      ],
    },
    setupHint: "/agent:messaging telegram → follow bot token setup",
  },
  {
    name: "discord",
    label: "Discord",
    kind: "official",
    pluginId: "plugin:discord@claude-plugins-official",
    cacheMarkers: ["discord"],
    authProbe: {
      kind: "env",
      vars: ["DISCORD_BOT_TOKEN", "DISCORD_TOKEN"],
    },
    setupHint: "/agent:messaging discord → follow bot token setup",
  },
  {
    name: "imessage",
    label: "iMessage",
    kind: "official",
    pluginId: "plugin:imessage@claude-plugins-official",
    cacheMarkers: ["imessage"],
    os: "darwin",
    authProbe: {
      kind: "path",
      paths: ["~/Library/Messages/chat.db"],
    },
    setupHint: "/agent:messaging imessage (macOS only, grants Messages.db access)",
  },
  {
    name: "slack",
    label: "Slack",
    kind: "integration",
    pluginId: "",
    cacheMarkers: ["slack"],
    authProbe: {
      kind: "none",
      note: "Claude in Slack is an Anthropic-hosted integration, not a plugin you launch here.",
    },
    setupHint: "Use claude.ai/slack (Claude in Slack), not a local plugin.",
  },
  {
    name: "fakechat",
    label: "Fakechat (local demo)",
    kind: "development",
    pluginId: "plugin:fakechat@fakechat",
    cacheMarkers: ["fakechat"],
    authProbe: {
      kind: "none",
      note: "Local demo channel — no auth.",
    },
    setupHint: "/agent:messaging fakechat (demo at http://localhost:8787)",
  },
];

// ---------------------------------------------------------------------------
// Types returned to callers
// ---------------------------------------------------------------------------

export type TriState = "yes" | "no" | "unknown" | "na";

/**
 * Runtime state read from a channel's `status.json` (currently WhatsApp only).
 * The plugin owns this file; we read it without interpreting beyond surfacing
 * the live `status` and any operator remediation. This is what lets ClawCode
 * tell the user "inbound is NOT active, another instance holds the lock"
 * instead of going silently mute when a second session wins the single-device
 * lock (the classic post-update / cron-session-still-alive failure).
 */
export interface ChannelRuntime {
  /** Raw `status` field from status.json (e.g. "connected", "idle_other_instance"). */
  status: string;
  /** Whether inbound delivery is active, when the plugin reports it (whatsapp 1.20.1+). */
  inboundActive?: boolean;
  /** PID holding the single-instance lock, when status is idle_other_instance. */
  holderPid?: number;
  /** Operator remediation text the plugin wrote (whatsapp 1.20.1+). */
  remediation?: string;
  /** Human one-liner derived for display. */
  detail: string;
  /** True when this state means the session may be connected but inbound won't reach it. */
  problem: boolean;
}

/**
 * Runtime states where the channel server is up but inbound won't reach this
 * session AND the user must act to fix it — worth surfacing loudly rather than
 * reporting a bare "active: unknown".
 *
 * Deliberately excludes the self-healing transients `reconnecting` (network blip,
 * backs off and recovers) and `deps_missing` (first-launch dependency install,
 * ~60-90s, transitions out automatically). Those are surfaced as informational
 * runtime detail (not a "problem") so we don't nag the user to act on something
 * that resolves on its own. The states here all require a human: close a session,
 * re-link, or fix filesystem perms.
 */
export const CHANNEL_PROBLEM_STATES = new Set<string>([
  "idle_other_instance",
  "lock_error",
  "logged_out",
  // claude-whatsapp ≥ 1.21.0: the WhatsApp side could not start (e.g. corrupt
  // auth state) — the server stays up and keeps retrying, but inbound is down
  // until a retry succeeds, so surface it like the other problem states.
  "connect_error",
]);

export interface ChannelStatus {
  name: ChannelName;
  label: string;
  kind: ChannelKind;
  pluginId: string;
  /** Plugin is in ~/.claude/plugins/cache/ */
  installed: TriState;
  /** Detected path or env var indicating auth. */
  authenticated: TriState;
  /** Best-guess whether it's loaded in this session. Always "unknown" unless we have a strong signal. */
  active: TriState;
  /** OS requirement not met? */
  osSupported: boolean;
  /** Live runtime state from the channel's status.json, when available. */
  runtime?: ChannelRuntime;
  /** Human-readable detail per field. */
  detail: {
    installed?: string;
    authenticated?: string;
    active?: string;
  };
  /** What to run to configure or set up. */
  setupHint: string;
}

/**
 * Read and interpret a channel's `status.json` runtime state. Read-only and
 * never throws — returns undefined when the file is missing/unparseable or
 * carries no usable `status`. Exported for direct unit testing.
 */
export function readChannelRuntime(statusJsonPath: string): ChannelRuntime | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(statusJsonPath, "utf8");
  } catch {
    return undefined;
  }
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj.status !== "string") return undefined;

  const status: string = obj.status;
  const holderPid = typeof obj.holder === "number" ? obj.holder : undefined;
  const inboundActive =
    typeof obj.inboundActive === "boolean" ? obj.inboundActive : undefined;
  const remediation =
    typeof obj.remediation === "string" ? obj.remediation : undefined;

  let detail: string;
  switch (status) {
    case "idle_other_instance":
      detail = `⚠️ inbound NOT active — another instance${
        holderPid ? ` (PID ${holderPid})` : ""
      } holds the single-device lock; this session receives no incoming messages`;
      break;
    case "connected":
      detail = "server connected";
      break;
    case "reconnecting":
      detail = "reconnecting (transient)";
      break;
    case "logged_out":
      detail = "logged out — re-link with /whatsapp:configure reset";
      break;
    case "lock_error":
      detail = "lock error — see status.json / logs";
      break;
    case "connect_error":
      detail = "server could not start the WhatsApp connection (retrying) — see status.json error / logs";
      break;
    case "deps_missing":
      detail = "installing dependencies";
      break;
    case "qr_ready":
      detail = "waiting for QR / pairing";
      break;
    default:
      detail = status;
  }

  return {
    status,
    holderPid,
    inboundActive,
    remediation,
    detail,
    problem: CHANNEL_PROBLEM_STATES.has(status),
  };
}

export interface DetectionOptions {
  /** Override home (for tests). */
  home?: string;
  /** Override cwd (for tests; defaults to `process.cwd()`). */
  cwd?: string;
  /** Override OS (for tests). */
  platform?: NodeJS.Platform;
  /** Override env (for tests). */
  env?: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectChannels(opts: DetectionOptions = {}): ChannelStatus[] {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  const pluginCache = path.join(home, ".claude", "plugins", "cache");
  let cacheEntries: string[] = [];
  try {
    if (fs.existsSync(pluginCache)) {
      cacheEntries = fs.readdirSync(pluginCache);
    }
  } catch {}

  return CHANNEL_REGISTRY.map((entry) =>
    statusFor(entry, cacheEntries, home, cwd, platform, env)
  );
}

export function statusFor(
  entry: ChannelRegistryEntry,
  cacheEntries: string[],
  home: string,
  cwd: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): ChannelStatus {
  // OS
  const osSupported = !entry.os || entry.os === platform;

  // Installed
  let installed: TriState = "no";
  let installedDetail = "";
  const match = cacheEntries.find((e) =>
    entry.cacheMarkers.some((m) => e.toLowerCase().includes(m.toLowerCase()))
  );
  if (match) {
    installed = "yes";
    installedDetail = `cache entry: ${match}`;
  }

  // Authenticated
  let authenticated: TriState = "unknown";
  let authDetail = "";
  // Path to a status.json we found while probing auth — reused below to read
  // live runtime state (whatsapp only).
  let statusJsonHit: string | undefined;

  if (!osSupported) {
    authenticated = "na";
    authDetail = `requires ${entry.os}, running on ${platform}`;
  } else if (installed === "no") {
    authenticated = "na";
    authDetail = "not installed";
  } else {
    const probe = entry.authProbe;
    if (probe.kind === "none") {
      authenticated = "na";
      authDetail = probe.note;
    } else if (probe.kind === "env") {
      const set = probe.vars.find((v) => !!env[v]);
      if (set) {
        authenticated = "yes";
        authDetail = `env ${set} is set`;
      } else {
        authenticated = "no";
        authDetail = `env not set: ${probe.vars.join(" / ")}`;
      }
    } else if (probe.kind === "path") {
      const resolved = probe.dynamicPaths
        ? probe.dynamicPaths(home, cwd)
        : (probe.paths ?? []).map((p) => resolveHome(p, home));
      const hit = resolved.find((p) => {
        try {
          return fs.existsSync(p);
        } catch {
          return false;
        }
      });
      if (hit) {
        authenticated = "yes";
        authDetail = `path exists: ${hit}`;
        if (hit.endsWith("status.json")) statusJsonHit = hit;
      } else {
        authenticated = "no";
        authDetail = `no auth artifact at ${resolved.join(" / ")}`;
      }
    }
  }

  // Live runtime state from status.json (whatsapp only). Read-only; surfaces a
  // locked-out / logged-out / lock-error server that would otherwise look fine.
  const runtime =
    entry.name === "whatsapp" && statusJsonHit
      ? readChannelRuntime(statusJsonHit)
      : undefined;

  // Active — normally we can't tell from a read-only probe whether the channel
  // is loaded in THIS session, so we stay honest with "unknown". But a runtime
  // "problem" state (e.g. idle_other_instance) is a strong negative signal that
  // inbound is not reaching us, so we report "no".
  let active: TriState =
    installed === "yes" && authenticated === "yes" ? "unknown" : "no";
  let activeDetail =
    active === "unknown"
      ? "can't be detected — confirm with /mcp or by sending a message"
      : installed === "no"
      ? "channel not installed"
      : authenticated === "no"
      ? "channel installed but not authenticated"
      : undefined;

  if (runtime?.problem) {
    active = "no";
    activeDetail = runtime.detail;
  } else if (runtime && active === "unknown") {
    // Non-problem runtime info still beats "can't be detected".
    activeDetail = `${runtime.detail} (confirm delivery by sending a message)`;
  }

  return {
    name: entry.name,
    label: entry.label,
    kind: entry.kind,
    pluginId: entry.pluginId,
    installed,
    authenticated,
    active,
    osSupported,
    runtime,
    detail: {
      installed: installedDetail || undefined,
      authenticated: authDetail || undefined,
      active: activeDetail,
    },
    setupHint: entry.setupHint,
  };
}

function resolveHome(p: string, home: string): string {
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  if (p === "~") return home;
  return p;
}

/**
 * Mirrors `detectProjectDir()` from claude-whatsapp's `server.ts`. Reads
 * `~/.claude/plugins/installed_plugins.json` to find the local-scope
 * projectPath the plugin will use as its state dir root. Returns undefined
 * when the plugin isn't installed locally anywhere (→ caller should fall
 * back to the global channel dir).
 *
 * Exported so `detectWhatsappAudio` in `lib/voice.ts` can resolve the
 * same path without duplicating the logic.
 *
 * Phase 3 — `cwdExactMatchOnly`: when `true`, only return a path when
 * the launch cwd exactly matches a local install's `projectPath`.
 * Disables the "first local entry fallback" that otherwise picks an
 * arbitrary install whose cwd doesn't match. The fallback exists for
 * single-install convenience, but in multi-project setups it can
 * surface stale WA channel state. Opt-in via
 * `config.scope.whatsapp.cwdExactMatchOnly = true`.
 */
export function detectWhatsappProjectDir(
  home: string,
  cwd: string,
  options: { cwdExactMatchOnly?: boolean } = {}
): string | undefined {
  try {
    const f = path.join(home, ".claude", "plugins", "installed_plugins.json");
    const data = JSON.parse(fs.readFileSync(f, "utf8"));
    const entries = (data?.plugins?.["whatsapp@claude-whatsapp"] ?? []) as Array<{
      scope?: string;
      projectPath?: string;
    }>;
    const exact = entries.find(
      (e) => e.scope === "local" && e.projectPath === cwd
    );
    if (exact?.projectPath) return exact.projectPath;
    if (options.cwdExactMatchOnly) return undefined;
    const firstLocal = entries.find(
      (e) => e.scope === "local" && e.projectPath
    );
    return firstLocal?.projectPath;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Launch command builder
// ---------------------------------------------------------------------------

export interface LaunchCommandOptions {
  /** Include channels that are installed-and-authenticated. Default: true. */
  includeAuthenticated?: boolean;
  /** Include channels that are installed but NOT authenticated (they'll load but fail at runtime). Default: false. */
  includeInstalledOnly?: boolean;
  /** Append --dangerously-skip-permissions. Default: false. */
  skipPermissions?: boolean;
}

export function buildLaunchCommand(
  channels: ChannelStatus[],
  opts: LaunchCommandOptions = {}
): string {
  const includeAuth = opts.includeAuthenticated !== false;
  const includeInstalledOnly = !!opts.includeInstalledOnly;
  const skipPermissions = !!opts.skipPermissions;

  const toLoad = channels.filter((c) => {
    if (c.kind !== "development" && c.kind !== "official") return false;
    if (!c.osSupported) return false;
    if (c.installed !== "yes") return false;
    if (c.authenticated === "yes" && includeAuth) return true;
    if (c.authenticated === "no" && includeInstalledOnly) return true;
    if (c.authenticated === "na" && includeInstalledOnly) return true;
    return false;
  });

  const parts: string[] = ["claude"];

  const dev = toLoad.filter((c) => c.kind === "development");
  const official = toLoad.filter((c) => c.kind === "official");

  for (const c of dev) {
    parts.push(`--dangerously-load-development-channels ${c.pluginId}`);
  }
  if (official.length > 0) {
    parts.push(`--channels ${official.map((c) => c.pluginId).join(",")}`);
  }
  if (skipPermissions) {
    parts.push("--dangerously-skip-permissions");
  }

  return parts.join(" \\\n  ");
}

// ---------------------------------------------------------------------------
// Formatter — table for the skill card
// ---------------------------------------------------------------------------

const ICON: Record<TriState, string> = {
  yes: "✅",
  no: "❌",
  unknown: "❓",
  na: "⏸️",
};

export function formatStatusTable(channels: ChannelStatus[]): string {
  const headers = ["Channel", "Kind", "Installed", "Auth", "Active"];
  const rows = channels.map((c) => [
    c.label,
    c.kind,
    ICON[c.installed],
    ICON[c.authenticated],
    ICON[c.active],
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length))
  );

  const line = (cells: string[]) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");

  const out: string[] = [];
  out.push(line(headers));
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) out.push(line(r));

  // Hints block
  const withHints = channels.filter(
    (c) =>
      (c.installed === "no" || c.authenticated === "no") &&
      c.kind !== "integration" &&
      c.osSupported
  );
  if (withHints.length > 0) {
    out.push("");
    out.push("Next steps:");
    for (const c of withHints) {
      out.push(`  · ${c.label}: ${c.setupHint}`);
    }
  }

  // Unsupported OS callouts
  const unsupported = channels.filter((c) => !c.osSupported);
  if (unsupported.length > 0) {
    out.push("");
    out.push("Skipped (OS not supported):");
    for (const c of unsupported) {
      out.push(`  · ${c.label}: requires ${CHANNEL_REGISTRY.find((r) => r.name === c.name)?.os}`);
    }
  }

  // Runtime problems — a server that's up but not delivering inbound to us.
  // This is the loud surface for the post-update / second-instance lockout.
  const runtimeProblems = channels.filter((c) => c.runtime?.problem);
  if (runtimeProblems.length > 0) {
    out.push("");
    out.push("⚠️ Runtime:");
    for (const c of runtimeProblems) {
      out.push(`  · ${c.label}: ${c.runtime!.detail}`);
      if (c.runtime!.remediation) out.push(`      ${c.runtime!.remediation}`);
    }
  }

  return out.join("\n");
}
