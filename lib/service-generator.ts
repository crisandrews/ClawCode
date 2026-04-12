/**
 * Service generator — produces a launchd plist (macOS) or systemd user unit
 * (Linux) that runs Claude Code in the agent's workspace continuously.
 *
 * All functions are pure: given inputs, they return strings (file content) or
 * plan objects. Actually writing files and invoking `launchctl`/`systemctl`
 * happens in the skill via Bash. That way this lib is fully unit-testable.
 *
 * NOTE: the `--dangerously-skip-permissions` flag is mandatory for a service —
 * a daemon cannot answer tool-approval prompts. The skill MUST confirm with
 * the user before installing.
 */

import os from "os";
import path from "path";

export type Platform = "darwin" | "linux" | "unsupported";

export type ServiceAction = "install" | "status" | "uninstall" | "logs";

export interface ServiceOptions {
  /** Absolute workspace path (agent's directory). */
  workspace: string;
  /** Full path to the `claude` binary. Usually `/usr/local/bin/claude` or similar. */
  claudeBin: string;
  /** Overrides — useful for tests and power users. */
  logPath?: string;
  slug?: string;
  platform?: Platform;
  /** Extra args appended after `--dangerously-skip-permissions`. */
  extraArgs?: string[];
}

export interface ServicePlan {
  platform: Platform;
  /** Human-readable unique id for this agent's service. */
  slug: string;
  /** Label the OS uses to reference the service. */
  label: string;
  /** Absolute path where the service file lives. */
  filePath: string;
  /** Where stdout/stderr will be written. */
  logPath: string;
  /** File contents to write (plist XML or systemd unit INI). Empty for non-install actions. */
  fileContent: string;
  /** Ordered list of shell commands the skill should run to accomplish the action. */
  commands: PlanCommand[];
  /** If action can't be performed (unsupported OS etc.), explanation. */
  error?: string;
}

export interface PlanCommand {
  /** Short description (surfaced to the user). */
  label: string;
  /** Shell command to execute. */
  cmd: string;
}

// ---------------------------------------------------------------------------
// Platform + slug
// ---------------------------------------------------------------------------

export function detectPlatform(): Platform {
  const p = process.platform;
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unsupported";
}

/** Normalize a workspace path into a safe service-name slug. */
export function slugifyWorkspace(workspacePath: string): string {
  const base = path.basename(path.resolve(workspacePath)) || "agent";
  // Keep [a-z0-9-], collapse everything else to -, trim leading/trailing -
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

/** Label conventions per platform: com.clawcode.<slug> on macOS, clawcode-<slug> on linux. */
export function serviceLabel(platform: Platform, slug: string): string {
  if (platform === "darwin") return `com.clawcode.${slug}`;
  return `clawcode-${slug}`;
}

export function serviceFilePath(platform: Platform, slug: string): string {
  const home = os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "LaunchAgents", `com.clawcode.${slug}.plist`);
  }
  if (platform === "linux") {
    return path.join(home, ".config", "systemd", "user", `clawcode-${slug}.service`);
  }
  return "";
}

export function defaultLogPath(slug: string): string {
  return path.join("/tmp", `clawcode-${slug}.log`);
}

// ---------------------------------------------------------------------------
// File content generators
// ---------------------------------------------------------------------------

/** Escape a string for embedding inside a double-quoted shell argument. */
function shellEscape(s: string): string {
  return s.replace(/(["$`\\])/g, "\\$1");
}

/** Escape for XML text content. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Generate a launchd plist. */
export function generatePlist(opts: {
  label: string;
  workspace: string;
  claudeBin: string;
  logPath: string;
  extraArgs?: string[];
}): string {
  const args = ["--dangerously-skip-permissions", ...(opts.extraArgs || [])];
  const argsXml = [opts.claudeBin, ...args]
    .map((a) => `        <string>${xmlEscape(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(opts.label)}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(opts.workspace)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(opts.logPath)}</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
`;
}

/** Generate a systemd user unit. */
export function generateSystemdUnit(opts: {
  name: string;
  workspace: string;
  claudeBin: string;
  logPath: string;
  extraArgs?: string[];
}): string {
  const args = ["--dangerously-skip-permissions", ...(opts.extraArgs || [])];
  // systemd ExecStart: quote with double quotes if a path has spaces
  const execStartParts = [opts.claudeBin, ...args].map((a) =>
    /\s/.test(a) ? `"${shellEscape(a)}"` : a
  );
  const execStart = execStartParts.join(" ");

  return `[Unit]
Description=ClawCode Agent (${opts.name})
After=network.target

[Service]
Type=simple
WorkingDirectory=${opts.workspace}
ExecStart=${execStart}
Restart=always
RestartSec=10
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export function buildPlan(action: ServiceAction, opts: ServiceOptions): ServicePlan {
  const platform = opts.platform ?? detectPlatform();
  const slug = opts.slug ?? slugifyWorkspace(opts.workspace);
  const label = serviceLabel(platform, slug);
  const filePath = serviceFilePath(platform, slug);
  const logPath = opts.logPath ?? defaultLogPath(slug);

  if (platform === "unsupported") {
    return {
      platform,
      slug,
      label,
      filePath: "",
      logPath,
      fileContent: "",
      commands: [],
      error:
        "Unsupported OS. /agent:service supports macOS (launchd) and Linux (systemd --user). On Windows, wrap Claude Code with Task Scheduler manually.",
    };
  }

  if (action === "install") {
    const fileContent =
      platform === "darwin"
        ? generatePlist({
            label,
            workspace: opts.workspace,
            claudeBin: opts.claudeBin,
            logPath,
            extraArgs: opts.extraArgs,
          })
        : generateSystemdUnit({
            name: slug,
            workspace: opts.workspace,
            claudeBin: opts.claudeBin,
            logPath,
            extraArgs: opts.extraArgs,
          });

    const commands: PlanCommand[] = [];
    if (platform === "darwin") {
      commands.push({
        label: "Create LaunchAgents directory",
        cmd: `mkdir -p "${path.dirname(filePath)}"`,
      });
      commands.push({
        label: "Unload previous instance (ignored if not loaded)",
        cmd: `launchctl unload "${filePath}" 2>/dev/null || true`,
      });
      commands.push({
        label: "Load the service",
        cmd: `launchctl load "${filePath}"`,
      });
    } else {
      commands.push({
        label: "Create systemd user directory",
        cmd: `mkdir -p "${path.dirname(filePath)}"`,
      });
      commands.push({
        label: "Reload systemd",
        cmd: `systemctl --user daemon-reload`,
      });
      commands.push({
        label: "Enable + start the service",
        cmd: `systemctl --user enable --now clawcode-${slug}.service`,
      });
    }

    return { platform, slug, label, filePath, logPath, fileContent, commands };
  }

  if (action === "uninstall") {
    const commands: PlanCommand[] = [];
    if (platform === "darwin") {
      commands.push({
        label: "Unload the service (ignored if not loaded)",
        cmd: `launchctl unload "${filePath}" 2>/dev/null || true`,
      });
      commands.push({
        label: "Remove the plist",
        cmd: `rm -f "${filePath}"`,
      });
    } else {
      commands.push({
        label: "Stop + disable the service (ignored if not enabled)",
        cmd: `systemctl --user disable --now clawcode-${slug}.service 2>/dev/null || true`,
      });
      commands.push({
        label: "Remove the unit file",
        cmd: `rm -f "${filePath}"`,
      });
      commands.push({
        label: "Reload systemd",
        cmd: `systemctl --user daemon-reload`,
      });
    }

    return {
      platform,
      slug,
      label,
      filePath,
      logPath,
      fileContent: "",
      commands,
    };
  }

  if (action === "status") {
    const commands: PlanCommand[] = [];
    if (platform === "darwin") {
      commands.push({
        label: "Check launchd state",
        cmd: `launchctl list | grep "${label}" || echo "NOT LOADED"`,
      });
      commands.push({
        label: "Verify plist file exists",
        cmd: `ls -la "${filePath}" 2>/dev/null || echo "FILE NOT FOUND"`,
      });
    } else {
      commands.push({
        label: "Check systemd state",
        cmd: `systemctl --user is-active clawcode-${slug}.service 2>&1 || true`,
      });
      commands.push({
        label: "Show unit status",
        cmd: `systemctl --user status clawcode-${slug}.service --no-pager 2>&1 | head -20 || true`,
      });
    }

    return {
      platform,
      slug,
      label,
      filePath,
      logPath,
      fileContent: "",
      commands,
    };
  }

  if (action === "logs") {
    const commands: PlanCommand[] = [
      {
        label: "Tail the last 60 log lines",
        cmd: `tail -n 60 "${logPath}" 2>/dev/null || echo "No log yet at ${logPath}"`,
      },
    ];
    return {
      platform,
      slug,
      label,
      filePath,
      logPath,
      fileContent: "",
      commands,
    };
  }

  return {
    platform,
    slug,
    label,
    filePath,
    logPath,
    fileContent: "",
    commands: [],
    error: `Unknown action: ${action}`,
  };
}
