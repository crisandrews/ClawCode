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
  | "fakechat";

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
  /** Human-readable detail per field. */
  detail: {
    installed?: string;
    authenticated?: string;
    active?: string;
  };
  /** What to run to configure or set up. */
  setupHint: string;
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
      } else {
        authenticated = "no";
        authDetail = `no auth artifact at ${resolved.join(" / ")}`;
      }
    }
  }

  // Active — we can't reliably tell from a read-only probe inside the MCP
  // server. We expose this as "unknown" honestly rather than guessing.
  const active: TriState =
    installed === "yes" && authenticated === "yes" ? "unknown" : "no";
  const activeDetail =
    active === "unknown"
      ? "can't be detected — confirm with /mcp or by sending a message"
      : installed === "no"
      ? "channel not installed"
      : authenticated === "no"
      ? "channel installed but not authenticated"
      : undefined;

  return {
    name: entry.name,
    label: entry.label,
    kind: entry.kind,
    pluginId: entry.pluginId,
    installed,
    authenticated,
    active,
    osSupported,
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
 */
export function detectWhatsappProjectDir(
  home: string,
  cwd: string
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

  return out.join("\n");
}
