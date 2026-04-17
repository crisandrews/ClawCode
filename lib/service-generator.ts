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
  /**
   * Install the heal sidecar alongside the main service. The sidecar
   * polls the service log every 60 seconds, drops a force-fresh flag,
   * and restarts the service when it detects the deferred-tool
   * resume-loop error pattern. Default: true when `resumeOnRestart`
   * is true, false otherwise (no resume loop to heal).
   *
   * Explicitly passing `false` disables the sidecar even when
   * `resumeOnRestart` is true. Useful when an external watchdog
   * (e.g. recipes/watchdog) is configured to handle recovery.
   */
  selfHeal?: boolean;
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
  // Persistent per-user location. `/tmp` is wiped on reboot, making it
  // near-useless for diagnosing failures that survived a restart cycle.
  return path.join(os.homedir(), ".clawcode", "logs", `${slug}.log`);
}

/** Where the resume-on-restart wrapper script gets installed per service. */
export function resumeWrapperPath(slug: string): string {
  return path.join(os.homedir(), ".clawcode", "service", `${slug}-resume-wrapper.sh`);
}

/**
 * Flag file the heal sidecar creates to force a fresh start on the next
 * wrapper invocation. Wrapper deletes the flag after honoring it. Used
 * when the wrapper is already exec'd inside a bad session and the
 * in-wrapper pre-flight (which only runs at start) can't escape.
 */
export function forceFreshFlagPath(slug: string): string {
  return path.join(os.homedir(), ".clawcode", "service", `${slug}.force-fresh`);
}

/** Where the heal sidecar script gets installed. */
export function healScriptPath(slug: string): string {
  return path.join(os.homedir(), ".clawcode", "service", `${slug}-heal.sh`);
}

/** Service-manager file paths for the heal sidecar. */
export function healServiceFilePath(platform: Platform, slug: string): string {
  const home = os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "LaunchAgents", `com.clawcode.heal.${slug}.plist`);
  }
  if (platform === "linux") {
    return path.join(home, ".config", "systemd", "user", `clawcode-heal-${slug}.service`);
  }
  return "";
}

export function healTimerFilePath(platform: Platform, slug: string): string {
  if (platform === "linux") {
    return path.join(
      os.homedir(),
      ".config",
      "systemd",
      "user",
      `clawcode-heal-${slug}.timer`
    );
  }
  return "";
}

/**
 * Error-pattern thresholds used by both the wrapper pre-flight and the
 * heal sidecar. Exported so the docs generator and tests can reference
 * a single source of truth.
 *
 * `pattern` matches the two strings observed in real stuck sessions
 * (see fault log in ~/.clawcode/logs/claude.log 2026-04-17). Either
 * one on its own does not trip recovery; only rate-over-window does.
 */
export const HEAL_PATTERN = "(No deferred tool marker|Input must be provided)";
export const HEAL_THRESHOLD = 10;
export const HEAL_WINDOW_SECONDS = 300;
export const HEAL_LOG_TAIL_LINES = 200;

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
 *
 * Self-heal pre-flight: before attaching `--continue`, the wrapper checks
 * for (a) a force-fresh flag the heal sidecar may have dropped and
 * (b) recent error-spam in the service log. If either trips, the wrapper
 * starts fresh, breaking the resume loop where every restart re-enters
 * the same stuck deferred-tool session.
 */
export function generateResumeWrapper(opts: {
  claudeBin: string;
  workspace: string;
  extraArgs?: string[];
  /** Absolute path to the service log, scanned by the log pre-flight. */
  logPath: string;
  /** Absolute path to the force-fresh flag the heal sidecar writes. */
  forceFreshFlagPath: string;
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
# when there is no prior session jsonl (first boot), the last session
# is stale (>7 days), the heal sidecar dropped a force-fresh flag, or
# the service log shows a sustained error-spam pattern.
#
# Safe to regenerate — do not hand-edit. Regenerate by re-running
# /agent:service install with the same options.

set -u

CLAUDE_BIN=${shellQuote(opts.claudeBin)}
SESSIONS_DIR=${shellQuote(sessionsDir)}
LOG_PATH=${shellQuote(opts.logPath)}
FORCE_FRESH_FLAG=${shellQuote(opts.forceFreshFlagPath)}
RESUME_STALE_DAYS=7
HEAL_PATTERN='${HEAL_PATTERN}'
HEAL_THRESHOLD=${HEAL_THRESHOLD}
HEAL_LOG_TAIL_LINES=${HEAL_LOG_TAIL_LINES}

continue_flag="--continue"
skip_reason=""

# 1. Force-fresh flag from heal sidecar → start fresh, clear flag first so a
# failed start doesn't leave the flag armed and cause perpetual fresh starts.
if [ -f "$FORCE_FRESH_FLAG" ]; then
    rm -f "$FORCE_FRESH_FLAG" 2>/dev/null || true
    continue_flag=""
    skip_reason="force-fresh flag present"
fi

# 2. No prior session jsonl → first boot.
if [ -n "$continue_flag" ] && ! ls "$SESSIONS_DIR"/*.jsonl >/dev/null 2>&1; then
    continue_flag=""
    skip_reason="no prior session jsonl"
fi

# 3. Prior session older than RESUME_STALE_DAYS → start fresh.
if [ -n "$continue_flag" ]; then
    latest=$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -1)
    if [ -n "$latest" ]; then
        mtime=$(stat -c %Y "$latest" 2>/dev/null || stat -f %m "$latest" 2>/dev/null || echo 0)
        age_days=$(( ( $(date +%s) - mtime ) / 86400 ))
        if [ "$age_days" -gt "$RESUME_STALE_DAYS" ]; then
            continue_flag=""
            skip_reason="last session >$RESUME_STALE_DAYS days old"
        fi
    fi
fi

# 4. Log pre-flight. If the previous run spammed the deferred-tool-resume
# error pattern, the session we're about to --continue into is probably
# still stuck. Scan the tail and count matches.
if [ -n "$continue_flag" ] && [ -r "$LOG_PATH" ]; then
    # grep -Ec prints "0" and exits 1 on no matches; \`|| true\` keeps
    # the output and discards the exit code so \$recent is always a clean int.
    recent=$(tail -n "$HEAL_LOG_TAIL_LINES" "$LOG_PATH" 2>/dev/null | \
        grep -Ec "$HEAL_PATTERN" 2>/dev/null || true)
    [ -z "$recent" ] && recent=0
    if [ "$recent" -ge "$HEAL_THRESHOLD" ]; then
        continue_flag=""
        skip_reason="log shows $recent error lines in last $HEAL_LOG_TAIL_LINES (stale resume)"
    fi
fi

# Breadcrumb so a post-mortem reader can see why --continue was skipped.
if [ -n "$skip_reason" ]; then
    printf '[%s] resume-wrapper: skipping --continue (%s)\\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$skip_reason" >> "$LOG_PATH" 2>/dev/null || true
fi

# shellcheck disable=SC2086
exec "$CLAUDE_BIN" $continue_flag ${quotedArgs}
`;
}

/** Shell-single-quote a string for embedding in a bash script literal. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Heal sidecar: automatic recovery from stuck deferred-tool resume loops.
//
// Fault pattern (observed 2026-04-17): the service spams "No deferred tool
// marker found" or "Input must be provided" hundreds of times without
// crashing. systemd's StartLimitBurst never trips because claude doesn't
// exit. It just stays up logging errors. Manual reboot was the only exit.
//
// Layer 1 (wrapper pre-flight, above) handles the case where the error
// pattern is already in the log at NEXT start. Layer 2 (this sidecar)
// handles the case where the service is CURRENTLY in the bad state and
// no restart is coming. It polls the log on a 60s cadence, drops a
// force-fresh flag, and restarts the service.
// ---------------------------------------------------------------------------

/**
 * Generate the heal sidecar script. Invoked by a systemd timer / launchd
 * StartInterval every 60 seconds. Pure log-pattern check + restart trigger,
 * with no HTTP probes and no dependencies beyond coreutils.
 *
 * Exit codes: 0 = healthy, 1 = pattern tripped + restart issued, 2 = tripped
 * but inside cooldown (no restart). All three are non-failure from the timer's
 * perspective; the timer keeps ticking regardless.
 */
export function generateHealScript(opts: {
  serviceLabel: string;
  logPath: string;
  forceFreshFlagPath: string;
  platform: Platform;
  /** Slug, used to scope the cooldown state file. */
  slug: string;
}): string {
  // Restart command differs per service manager. macOS `launchctl kickstart`
  // bounces the service in-place without un/reloading the plist.
  const restartCmd =
    opts.platform === "darwin"
      ? `launchctl kickstart -k "gui/$(id -u)/${opts.serviceLabel}"`
      : `systemctl --user restart ${opts.serviceLabel}`;

  const stateFile = path.join(os.homedir(), ".clawcode", "service", `${opts.slug}.heal-state`);
  const healLog = path.join(os.homedir(), ".clawcode", "logs", `${opts.slug}-heal.log`);

  return `#!/bin/bash
# ClawCode heal sidecar. Generated by lib/service-generator.ts.
# Scans the service log for a deferred-tool-resume error spam pattern.
# If the rate exceeds threshold, drops a force-fresh flag so the resume
# wrapper starts clean on next boot, then restarts the service.
#
# Invoked on a 60s cadence by a systemd timer (Linux) or launchd
# StartInterval (macOS). One-shot; exits fast, does not daemonize.
#
# Safe to regenerate. Do not hand-edit.

set -u

LOG_PATH=${shellQuote(opts.logPath)}
FORCE_FRESH_FLAG=${shellQuote(opts.forceFreshFlagPath)}
STATE_FILE=${shellQuote(stateFile)}
HEAL_LOG=${shellQuote(healLog)}
HEAL_PATTERN='${HEAL_PATTERN}'
HEAL_THRESHOLD=${HEAL_THRESHOLD}
HEAL_WINDOW_SECONDS=${HEAL_WINDOW_SECONDS}
HEAL_LOG_TAIL_LINES=${HEAL_LOG_TAIL_LINES}
# Cooldown between restarts so one event doesn't cause repeated bounces
# while the service is still coming back up and flushing stale buffers.
HEAL_COOLDOWN_SECONDS=${HEAL_WINDOW_SECONDS * 2}

mkdir -p "$(dirname "$HEAL_LOG")" 2>/dev/null || true
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

now_epoch() { date +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] %s\\n' "$(now_iso)" "$1" >> "$HEAL_LOG" 2>/dev/null || true; }

# No log yet → nothing to scan, service is probably fine or hasn't started.
if [ ! -r "$LOG_PATH" ]; then
    exit 0
fi

# Count pattern matches in the tail of the log. grep -Ec exits 1 on zero
# matches (but still prints "0"). \`|| true\` keeps the output and
# swallows the exit code so \$matches is always a clean integer.
matches=$(tail -n "$HEAL_LOG_TAIL_LINES" "$LOG_PATH" 2>/dev/null | \
    grep -Ec "$HEAL_PATTERN" 2>/dev/null || true)
[ -z "$matches" ] && matches=0

if [ "$matches" -lt "$HEAL_THRESHOLD" ]; then
    exit 0
fi

# Cooldown check: don't bounce again if we just did.
if [ -f "$STATE_FILE" ]; then
    last=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
    elapsed=$(( $(now_epoch) - last ))
    if [ "$elapsed" -lt "$HEAL_COOLDOWN_SECONDS" ]; then
        remaining=$(( HEAL_COOLDOWN_SECONDS - elapsed ))
        log "TRIP matches=$matches but inside cooldown (\${remaining}s left); skipping restart"
        exit 2
    fi
fi

log "TRIP matches=$matches >= threshold=$HEAL_THRESHOLD; writing force-fresh flag + restarting"
touch "$FORCE_FRESH_FLAG" 2>/dev/null || log "WARN failed to write force-fresh flag at $FORCE_FRESH_FLAG"
now_epoch > "$STATE_FILE" 2>/dev/null || true

if ${restartCmd.replace(/"/g, '\\"')} >> "$HEAL_LOG" 2>&1; then
    log "RESTART issued ok"
    exit 1
else
    log "RESTART command failed; may need manual intervention"
    exit 1
fi
`;
}

/**
 * Generate the systemd service unit that runs the heal script once. Paired
 * with a .timer that fires it every 60 seconds. Type=oneshot so systemd
 * knows the unit is supposed to exit quickly.
 */
export function generateHealSystemdService(opts: {
  slug: string;
  healScriptPath: string;
  workspace: string;
}): string {
  return `[Unit]
Description=ClawCode Heal Sidecar (${opts.slug})
# Do not run until the service itself has had a chance to come up.
After=clawcode-${opts.slug}.service

[Service]
Type=oneshot
WorkingDirectory=${opts.workspace}
Environment=HOME=${os.homedir()}
ExecStart=/bin/bash ${opts.healScriptPath}
# Script exits 0/1/2 with distinct meaning; 1/2 are "handled trip", not
# failure. Don't let systemd mark the unit failed on a successful trip.
SuccessExitStatus=0 1 2

[Install]
WantedBy=default.target
`;
}

/** Generate the systemd timer that fires the heal service every 60s. */
export function generateHealSystemdTimer(opts: { slug: string }): string {
  return `[Unit]
Description=ClawCode Heal Timer (${opts.slug})

[Timer]
# Offset first tick 2 minutes after boot so the service has time to
# settle before any restart decision is made.
OnBootSec=2min
OnUnitActiveSec=1min
Unit=clawcode-heal-${opts.slug}.service
AccuracySec=5s

[Install]
WantedBy=timers.target
`;
}

/**
 * Generate a launchd plist that runs the heal script every 60s via
 * StartInterval. On macOS there is no separate timer concept; the same
 * plist describes both the program and its schedule.
 */
export function generateHealLaunchdPlist(opts: {
  slug: string;
  healScriptPath: string;
  workspace: string;
  healLogPath: string;
}): string {
  const label = `com.clawcode.heal.${opts.slug}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xmlEscape(opts.healScriptPath)}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(opts.workspace)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${xmlEscape(os.homedir())}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${xmlEscape(opts.healLogPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(opts.healLogPath)}</string>
</dict>
</plist>
`;
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
  // Wrap the invocation in `/usr/bin/script -q /dev/null <cmd...>` so claude
  // runs under a pseudo-terminal. Without a PTY, launchd services inherit
  // stdio that lacks a controlling terminal, which can cause lifecycle hooks
  // (SessionEnd and others) to fail to spawn subshells and return non-zero,
  // producing a crash loop under `KeepAlive`. BSD `script(1)` takes positional
  // args: `script [flags] [typescript] [command args...]`.
  const argsXml = ["/usr/bin/script", "-q", "/dev/null", opts.claudeBin, ...args]
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
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${xmlEscape(os.homedir())}</string>
        <key>TERM</key>
        <string>xterm-256color</string>
    </dict>
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
Environment=HOME=${os.homedir()}
Environment=TERM=xterm-256color
# Disable Claude Code's in-process auto-updater while running as a daemon.
# In a service context the updater can regenerate files it manages mid-run,
# including the resume-on-restart wrapper script (see generateResumeWrapper).
# A long-running daemon rewriting its own ExecStart target while live is a
# file-integrity issue, separate from the PTY-wrap crash-loop fix. Pin the
# installed version and update explicitly via the /agent:update skill.
# DISABLE_AUTOUPDATER is a documented env var Claude Code exposes.
Environment=DISABLE_AUTOUPDATER=1
ExecStartPre=-/usr/bin/pkill -f "claude.*--dangerously-skip-permissions"
ExecStart=${execStart}
Restart=always
RestartSec=10
# Crash-loop guard: stop restarting after 3 failures within 5 minutes
# so a deterministic boot-time error doesn't churn forever. Tightened
# from 5 in v1.4; the heal sidecar handles the slow-spam failure mode
# that used to need the extra headroom, so fast-crash loops should trip
# sooner instead of burning retries.
StartLimitIntervalSec=300
StartLimitBurst=3
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

    const flagPath = forceFreshFlagPath(slug);

    if (resumeOnRestart) {
      const wrapperPath = resumeWrapperPath(slug);
      extraFiles.push({
        path: wrapperPath,
        content: generateResumeWrapper({
          claudeBin: opts.claudeBin,
          workspace: opts.workspace,
          extraArgs: opts.extraArgs,
          logPath,
          forceFreshFlagPath: flagPath,
        }),
        mode: 0o755,
      });
      // The wrapper already bakes in --dangerously-skip-permissions
      // and extraArgs, so the unit/plist just exec's the wrapper bare.
      execBin = wrapperPath;
      execExtraArgs = [];
      skipDefaultArgs = true;
    }

    // Heal sidecar defaults on when resumeOnRestart is on (no resume
    // loop to heal otherwise). Explicit false disables regardless.
    const selfHeal = opts.selfHeal === undefined ? resumeOnRestart : opts.selfHeal;
    const healScript = healScriptPath(slug);
    const healUnitPath = healServiceFilePath(platform, slug);
    const healTimerPath = healTimerFilePath(platform, slug);
    const healLogPath = path.join(
      path.dirname(logPath),
      `${slug}-heal.log`
    );

    if (selfHeal) {
      extraFiles.push({
        path: healScript,
        content: generateHealScript({
          serviceLabel: label,
          logPath,
          forceFreshFlagPath: flagPath,
          platform,
          slug,
        }),
        mode: 0o755,
      });
      if (platform === "darwin") {
        extraFiles.push({
          path: healUnitPath,
          content: generateHealLaunchdPlist({
            slug,
            healScriptPath: healScript,
            workspace: opts.workspace,
            healLogPath,
          }),
        });
      } else {
        extraFiles.push({
          path: healUnitPath,
          content: generateHealSystemdService({
            slug,
            healScriptPath: healScript,
            workspace: opts.workspace,
          }),
        });
        extraFiles.push({
          path: healTimerPath,
          content: generateHealSystemdTimer({ slug }),
        });
      }
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
    // Ensure the log directory exists first — systemd's `append:` and
    // launchd's StandardOutPath do NOT create missing parent directories,
    // and the service silently refuses to start if they don't.
    commands.push({
      label: "Create log directory",
      cmd: `mkdir -p "${path.dirname(logPath)}"`,
    });
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
      if (selfHeal) {
        commands.push({
          label: "Unload previous heal sidecar (ignored if not loaded)",
          cmd: `launchctl unload "${healUnitPath}" 2>/dev/null || true`,
        });
        commands.push({
          label: "Load the heal sidecar",
          cmd: `launchctl load "${healUnitPath}"`,
        });
      }
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
      if (selfHeal) {
        commands.push({
          label: "Enable + start the heal sidecar timer",
          cmd: `systemctl --user enable --now clawcode-heal-${slug}.timer`,
        });
      }
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
    const healUnit = healServiceFilePath(platform, slug);
    const healTimer = healTimerFilePath(platform, slug);

    if (platform === "darwin") {
      // Stop the sidecar first so it can't race the main service teardown.
      commands.push({
        label: "Unload the heal sidecar (ignored if not loaded)",
        cmd: `launchctl unload "${healUnit}" 2>/dev/null || true`,
      });
      commands.push({
        label: "Unload the service (ignored if not loaded)",
        cmd: `launchctl unload "${filePath}" 2>/dev/null || true`,
      });
      commands.push({
        label: "Remove the heal sidecar plist (if present)",
        cmd: `rm -f "${healUnit}"`,
      });
      commands.push({
        label: "Remove the plist",
        cmd: `rm -f "${filePath}"`,
      });
    } else {
      commands.push({
        label: "Stop + disable the heal sidecar timer (ignored if not enabled)",
        cmd: `systemctl --user disable --now clawcode-heal-${slug}.timer 2>/dev/null || true`,
      });
      commands.push({
        label: "Stop + disable the service (ignored if not enabled)",
        cmd: `systemctl --user disable --now clawcode-${slug}.service 2>/dev/null || true`,
      });
      commands.push({
        label: "Remove the heal sidecar unit files (if present)",
        cmd: `rm -f "${healUnit}" "${healTimer}"`,
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

    // Best-effort wrapper + heal cleanup; silent if never installed.
    commands.push({
      label: "Remove resume-on-restart wrapper if present",
      cmd: `rm -f "${resumeWrapperPath(slug)}"`,
    });
    commands.push({
      label: "Remove heal sidecar script + state (if present)",
      cmd: `rm -f "${healScriptPath(slug)}" "${forceFreshFlagPath(slug)}" "${path.join(os.homedir(), ".clawcode", "service", `${slug}.heal-state`)}"`,
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
