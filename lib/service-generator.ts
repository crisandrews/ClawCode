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
  /**
   * Emit a wrapper script so the service runs `claude --continue` and
   * preserves conversation history across restarts. Default: true.
   * Set to false to get a plain `claude` invocation in ExecStart /
   * ProgramArguments (the pre-v1.3 behavior).
   */
  resumeOnRestart?: boolean;
}

export interface ExtraFile {
  /** Absolute path where the file should be written. */
  path: string;
  /** UTF-8 content. */
  content: string;
  /** POSIX file mode (e.g. 0o755 for an executable script). */
  mode?: number;
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
  /**
   * Additional files the skill should write before running commands
   * (e.g. the resume-on-restart wrapper). Each is an absolute path +
   * content + optional mode. Only set for `install` when applicable.
   */
  extraFiles?: ExtraFile[];
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

/** Where the resume-on-restart wrapper script gets installed per service. */
export function resumeWrapperPath(slug: string): string {
  return path.join(os.homedir(), ".clawcode", "service", `${slug}-resume-wrapper.sh`);
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

/**
 * Generate the resume-on-restart wrapper script. Runs `claude --continue`
 * when a prior session exists and is fresh; otherwise falls back to a
 * plain start. Written to disk as an executable at `resumeWrapperPath(slug)`
 * and invoked from the service's ExecStart / ProgramArguments.
 */
export function generateResumeWrapper(opts: {
  claudeBin: string;
  workspace: string;
  extraArgs?: string[];
}): string {
  const args = ["--dangerously-skip-permissions", ...(opts.extraArgs || [])];
  // Shell-single-quote each arg so spaces and metacharacters survive exec.
  const quotedArgs = args
    .map((a) => `'${a.replace(/'/g, `'\\''`)}'`)
    .join(" ");
  const sessionsDir = path.join(
    opts.workspace,
    ".claude",
    "projects",
    "-" + opts.workspace.replace(/^\/+/, "").replace(/\//g, "-")
  );

  return `#!/bin/bash
# ClawCode service ExecStart wrapper — generated by lib/service-generator.ts.
# Runs \`claude --continue\` so a service restart rehydrates the prior
# conversation instead of starting fresh. Falls back to a plain start
# when there is no prior session to resume (first boot) or when the last
# session is stale (>7 days).
#
# Safe to regenerate — do not hand-edit. Regenerate by re-running
# /agent:service install with the same options.

set -u

CLAUDE_BIN=${shellQuote(opts.claudeBin)}
SESSIONS_DIR=${shellQuote(sessionsDir)}
RESUME_STALE_DAYS=7

continue_flag="--continue"

# No prior session jsonl → first boot, start fresh.
if ! ls "$SESSIONS_DIR"/*.jsonl >/dev/null 2>&1; then
    continue_flag=""
fi

# Prior session exists but is older than RESUME_STALE_DAYS → start fresh.
if [ -n "$continue_flag" ]; then
    latest=$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
        mtime=$(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest" 2>/dev/null || echo 0)
        age_days=$(( ( $(date +%s) - mtime ) / 86400 ))
        if [ "$age_days" -gt "$RESUME_STALE_DAYS" ]; then
            continue_flag=""
        fi
    fi
fi

# shellcheck disable=SC2086
exec "$CLAUDE_BIN" $continue_flag ${quotedArgs}
`;
}

/** Shell-single-quote a string for embedding in a bash script literal. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Generate a launchd plist. */
export function generatePlist(opts: {
  label: string;
  workspace: string;
  claudeBin: string;
  logPath: string;
  extraArgs?: string[];
  /**
   * If true, skip prepending `--dangerously-skip-permissions`. Use this
   * when `claudeBin` points at a wrapper script that already embeds the
   * flag itself (see `generateResumeWrapper`). Default: false.
   */
  skipDefaultArgs?: boolean;
}): string {
  const defaults = opts.skipDefaultArgs ? [] : ["--dangerously-skip-permissions"];
  const args = [...defaults, ...(opts.extraArgs || [])];
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
  /**
   * If true, skip prepending `--dangerously-skip-permissions`. Use this
   * when `claudeBin` points at a wrapper script that already embeds the
   * flag itself (see `generateResumeWrapper`). Default: false.
   */
  skipDefaultArgs?: boolean;
}): string {
  const defaults = opts.skipDefaultArgs ? [] : ["--dangerously-skip-permissions"];
  const args = [...defaults, ...(opts.extraArgs || [])];
  // systemd ExecStart: quote with double quotes if a path has spaces
  const execStartParts = [opts.claudeBin, ...args].map((a) =>
    /\s/.test(a) ? `"${shellEscape(a)}"` : a
  );
  // Wrap the invocation in `script -q -c '...' /dev/null` so claude runs
  // under a PTY. Without a PTY, Claude Code's SessionEnd (and other
  // lifecycle) hooks cannot spawn `/bin/sh`, graceful exits return code 1
  // instead of 0, and `Restart=on-failure`/`always` produces a crash loop
  // on every normal shutdown. The inner single-quoted command is re-parsed
  // by `script`'s child /bin/sh, which strips the outer quotes — so any
  // literal single-quote in a path/arg must be escaped with '\''.
  const innerCmd = execStartParts
    .map((a) => a.replace(/'/g, `'\\''`))
    .join(" ");
  const execStart = `/usr/bin/script -q -c '${innerCmd}' /dev/null`;

  return `[Unit]
Description=ClawCode Agent (${opts.name})
After=network.target

[Service]
Type=simple
WorkingDirectory=${opts.workspace}
# Disable Claude Code's in-process auto-updater while running as a daemon.
# Background updates have regenerated service files and left the system in
# inconsistent states; pin the installed version and update explicitly via
# package manager instead.
Environment=DISABLE_AUTOUPDATER=1
ExecStartPre=-/usr/bin/pkill -f "claude.*--dangerously-skip-permissions"
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
    // Default: emit a wrapper so `claude --continue` preserves context
    // across restarts. Opt out by passing resumeOnRestart: false.
    const resumeOnRestart = opts.resumeOnRestart !== false;

    const extraFiles: ExtraFile[] = [];
    let execBin = opts.claudeBin;
    let execExtraArgs = opts.extraArgs;
    let skipDefaultArgs = false;

    if (resumeOnRestart) {
      const wrapperPath = resumeWrapperPath(slug);
      extraFiles.push({
        path: wrapperPath,
        content: generateResumeWrapper({
          claudeBin: opts.claudeBin,
          workspace: opts.workspace,
          extraArgs: opts.extraArgs,
        }),
        mode: 0o755,
      });
      // The wrapper already bakes in --dangerously-skip-permissions
      // and extraArgs, so the unit/plist just exec's the wrapper bare.
      execBin = wrapperPath;
      execExtraArgs = [];
      skipDefaultArgs = true;
    }

    const fileContent =
      platform === "darwin"
        ? generatePlist({
            label,
            workspace: opts.workspace,
            claudeBin: execBin,
            logPath,
            extraArgs: execExtraArgs,
            skipDefaultArgs,
          })
        : generateSystemdUnit({
            name: slug,
            workspace: opts.workspace,
            claudeBin: execBin,
            logPath,
            extraArgs: execExtraArgs,
            skipDefaultArgs,
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

    return {
      platform,
      slug,
      label,
      filePath,
      logPath,
      fileContent,
      extraFiles: extraFiles.length > 0 ? extraFiles : undefined,
      commands,
    };
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

    // Best-effort wrapper cleanup — silent if never installed.
    commands.push({
      label: "Remove resume-on-restart wrapper if present",
      cmd: `rm -f "${resumeWrapperPath(slug)}"`,
    });

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
