# Service — run the agent always-on

Wrap Claude Code (with ClawCode loaded) in the OS's service manager so the agent stays up 24/7. Required if you want the HTTP bridge, WebChat, webhooks, or cron-driven behaviors (heartbeat, dreaming) to work while your terminal is closed.

Optional feature. Off by default. Most users who just use Claude Code in a terminal can ignore it.

## Supported platforms

| OS | Service manager | Path |
|---|---|---|
| macOS | launchd | `~/Library/LaunchAgents/com.clawcode.<slug>.plist` |
| Linux | systemd (`--user`) | `~/.config/systemd/user/clawcode-<slug>.service` |
| Windows / BSD / other | Not supported | Use Task Scheduler or equivalent manually |

`<slug>` is derived from your workspace folder name (lowercased, non-alphanumeric collapsed to `-`). One service per agent folder — you can run several agents side by side.

## Commands and tools

| Command | Effect |
|---|---|
| `/agent:service install` | Generate + load the service (requires confirmation) |
| `/agent:service status` | Report whether the service is loaded and running |
| `/agent:service uninstall` | Unload + remove the file |
| `/agent:service logs` | Tail the last 60 log lines |

Programmatic:

| MCP tool | Purpose |
|---|---|
| `service_plan({ action })` | Returns the plan (file content + shell commands) for the requested action. Does not touch the filesystem — the skill runs the commands after user confirmation. |

## The safety trade-off — `--dangerously-skip-permissions`

A daemon cannot answer interactive "Approve this tool?" prompts, so the service launches Claude Code with `--dangerously-skip-permissions`. That means:

- Every tool call (Bash, Write, Edit, network, etc.) is **pre-approved**. The running service has full permissions over the workspace for its entire lifetime.
- You lose the per-tool approval safety net that the REPL gives you.
- If the agent or any skill it runs has a bug or is manipulated by an incoming message, it could do anything inside the workspace without your consent in the moment.

**Heads-up — only relevant when running as a service.** Bypass Permissions mode shows an interactive `WARNING: Bypass Permissions mode — Do you accept? [1. No / 2. Yes]` dialog at startup. In a terminal you just press `2` and continue; under launchd / systemd there is no TTY to answer it, so the service hangs silently and never reaches the listening state.

Before installing the service, persist the acknowledgment once in `~/.claude/settings.json`:

```json
{ "skipDangerousModePermissionPrompt": true }
```

Not needed if you only run `claude` interactively. Tracked upstream as [anthropics/claude-code#25503](https://github.com/anthropics/claude-code/issues/25503). Reported by [@JD2005L](https://github.com/JD2005L) — thanks.

**Consequences worth knowing:**

- Keep sensitive files out of the agent's workspace, or at least out of paths the agent has reason to touch.
- If you use messaging channels (WhatsApp, Telegram), a compromised conversation partner can ask the agent to do things it shouldn't. Access policies (`/whatsapp:access` etc.) help, but the daemon trust level is higher than a supervised REPL.
- If in doubt, run the agent manually in a terminal until you trust the behavior, then install the service.

The `/agent:service install` skill asks for explicit confirmation before generating the file. That's intentional — don't rubber-stamp it.

## What the service file contains

### macOS plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ...>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clawcode.my-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/claude</string>
        <string>--dangerously-skip-permissions</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/you/my-agent</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/you</string>
        <key>TERM</key>
        <string>xterm-256color</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/you/.clawcode/logs/my-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/.clawcode/logs/my-agent.log</string>
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
```

### Linux systemd user unit

```ini
[Unit]
Description=ClawCode Agent (my-agent)
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/you/my-agent
Environment=HOME=/home/you
Environment=TERM=xterm-256color
ExecStartPre=-/usr/bin/pkill -f "claude.*--dangerously-skip-permissions"
ExecStart=/usr/local/bin/claude --dangerously-skip-permissions
Restart=always
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=3
StandardOutput=append:/home/you/.clawcode/logs/my-agent.log
StandardError=append:/home/you/.clawcode/logs/my-agent.log

[Install]
WantedBy=default.target
```

The `ExecStartPre=-/usr/bin/pkill ...` line kills any leftover `claude` process running in service mode before the new one starts. Without it, a restart can leave the old instance briefly alive next to the new one — both then connect to the same channel (e.g. Telegram bot) and race for incoming messages, making the service look randomly broken. The leading `-` tells systemd to ignore the exit code (no leftover process is fine). The `-f` filter only matches Claude Code launched with `--dangerously-skip-permissions`, so an interactive `claude` session running in another terminal is left alone. macOS launchd does not need this line — launchd guarantees a single instance per `Label`. Reported by [@JD2005L](https://github.com/JD2005L).

Both auto-restart on crash. On Linux, `systemctl --user enable` is enough for reboot survival within a session; for true reboot survival across user logouts you also need `loginctl enable-linger <user>` (not done automatically).

## Adding messaging-channel flags

If you want the always-on agent to load WhatsApp / Telegram / etc., pass `extraArgs` to `service_plan`. The skill in v1 doesn't prompt for channel flags on install — re-run `/agent:service install` after modifying the config, or edit the generated file manually.

Example extra args:

```
--dangerously-load-development-channels plugin:whatsapp@claude-whatsapp
```

Or for official channels:

```
--channels plugin:telegram@claude-plugins-official
```

Remember: the more tools you load, the more attack surface the always-on agent has.

## Logs

Default log path: `~/.clawcode/logs/<slug>.log`. Both stdout and stderr go there. The install plan creates `~/.clawcode/logs/` automatically — without that, systemd's `append:` and launchd's `StandardOutPath` silently refuse to start the service.

Persistent across reboots. Override with a custom `logPath` when installing if you want the file elsewhere. Log rotation is not handled — add your own `logrotate` rule or pipe through a rotator if needed.

## Resume-on-restart wrapper

`/agent:service install` emits a small shim at `~/.clawcode/service/<slug>-resume-wrapper.sh` and points the unit's `ExecStart` (or plist `ProgramArguments`) at it. The wrapper runs `claude --continue` so a service restart rehydrates the prior session's conversation history instead of starting fresh — useful when a watchdog aggressively restarts stalled sessions.

Behavior:
- Runs `claude --continue` by default
- Falls back to a plain start when there is no prior session jsonl (first boot)
- Falls back to a plain start when the last session is more than 7 days old (long-stale resumes tend to behave oddly)

Opt out by passing `resumeOnRestart: false` to `service_plan`. You'll get the pre-v1.3 behavior — `ExecStart` invokes `claude` directly with no context preservation across restarts.

The wrapper is regenerated every time `install` is run, so safe to re-run after changing `extraArgs` or `claudeBin`. `uninstall` removes it.

## Automatic self-heal for stuck resume loops

`claude --continue` can land back inside a session with a stale deferred-tool marker. In that state the process keeps running (it does not crash), but every tick it logs `No deferred tool marker found in the resumed session` or `Input must be provided either through stdin or as a prompt argument when using --print`. Because it doesn't exit, `StartLimitBurst` never fires, so systemd's normal crash-loop guard can't help. A manual service reboot used to be the only exit.

Since v1.5, `/agent:service install` ships three layered defenses by default, all automatic:

**Layer 1, wrapper pre-flight.** Before the resume wrapper execs `claude --continue`, it checks four signals:

1. A `~/.clawcode/service/<slug>.force-fresh` flag file (set by Layer 2).
2. Whether a session jsonl exists at all.
3. Whether the last session is older than `RESUME_STALE_DAYS` (7 days).
4. Whether the tail of the service log contains 10 or more occurrences of the stuck-resume error pattern in the last ~200 lines.

Any of those signals makes the wrapper drop `--continue` and start the agent fresh. A one-line breadcrumb goes into the service log naming the reason. The force-fresh flag is deleted *before* the decision, so a crashed start doesn't leave the flag armed for perpetual fresh starts.

**Layer 2, heal sidecar.** A tiny companion service (`clawcode-heal-<slug>.timer`/`.service` on Linux, `com.clawcode.heal.<slug>` plist on macOS) fires every 60 seconds, scans the service log for the same error pattern, and when the threshold trips:

1. Writes the force-fresh flag.
2. Triggers `systemctl --user restart clawcode-<slug>` (Linux) or `launchctl kickstart -k` (macOS).
3. Observes a cooldown (2x the detection window, default 10 min) before trying again, so a slow recovery doesn't get bounced repeatedly.

The sidecar has zero runtime dependencies beyond `bash`, `tail`, and `grep`. It logs its own decisions to `~/.clawcode/logs/<slug>-heal.log`. First boot is delayed 2 minutes to give the main service time to settle.

This layer is what catches the case the wrapper pre-flight can't: when the service is *currently* inside the bad state and no restart is coming.

**Layer 3, tighter crash-loop guard.** `StartLimitBurst` is now `3` (was `5`). Fast-crash loops trip the systemd guard sooner. The slow-spam loop is Layer 2's job, so the extra headroom isn't needed anymore.

### Opting out

Pass `selfHeal: false` to `service_plan({ action: "install", selfHeal: false })` when an external watchdog (`recipes/watchdog/`) is already configured to handle recovery. Keep one recovery mechanism active, not two. They don't fight, but they also don't talk to each other. The heal sidecar is also silently disabled when `resumeOnRestart: false`, since without `--continue` there's no resume loop to heal.

### Tuning

The thresholds are exported constants in `lib/service-generator.ts`:

| Constant | Default | Meaning |
|---|---|---|
| `HEAL_PATTERN` | `(No deferred tool marker\|Input must be provided)` | Egrep regex scanned against the service log |
| `HEAL_THRESHOLD` | `10` | Minimum matches to trip recovery |
| `HEAL_WINDOW_SECONDS` | `300` | Logical window; cooldown is 2x this |
| `HEAL_LOG_TAIL_LINES` | `200` | How many lines of the log the scan inspects |

Change them, re-run `/agent:service install`, and the wrapper + sidecar are regenerated. Don't hand-edit the scripts, since regeneration clobbers edits.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Service installed but WebChat / HTTP bridge never come up; logs empty or stuck before "listening" | Bypass Permissions startup dialog waiting for a "Do you accept?" that the daemon (launchd / systemd) cannot answer — no TTY | Add `"skipDangerousModePermissionPrompt": true` to `~/.claude/settings.json`, then restart the service. Only affects service mode; interactive `claude` is unaffected |
| "service installed" but WebChat still unreachable | Service file is correct but `claude` not in PATH for launchd | Verify with `/agent:service status`; use absolute path to `claude` (`which claude` then pass as `claudeBin`) |
| Service keeps crashing / restart loop | Config error (bad `agent-config.json`) or missing permission the `--dangerously-skip-permissions` flag can't cover | Check `~/.clawcode/logs/<slug>.log`; run `/agent:doctor` to see if config is valid. `StartLimitBurst=3` means systemd will stop retrying after 3 failures in 5 minutes. Look for the last error there. |
| Service shows "active" but log spams `No deferred tool marker found` | Stuck deferred-tool resume loop inside a `--continue`'d session | Automatic since v1.5: the heal sidecar bounces it within ~1 min. Confirm it's running with `systemctl --user status clawcode-heal-<slug>.timer`. Its decisions are at `~/.clawcode/logs/<slug>-heal.log`. |
| On Linux: service dies when you log out | Lingering not enabled | `sudo loginctl enable-linger $USER` |
| Uninstall didn't fully stop | systemd cache | `systemctl --user daemon-reload` then re-run uninstall |
| Multiple agents conflicting | Same slug | Ensure workspace folder names are distinct |
| Telegram / other channel suddenly drops messages after a config edit | Editing `~/.claude/settings.json` while the service runs reloads MCPs; some plugins do not reconnect cleanly and stay dead | Restart the service after any manual edit (`/agent:service uninstall` + `/agent:service install`, or `systemctl --user restart clawcode-<slug>` / `launchctl kickstart -k gui/$(id -u)/com.clawcode.<slug>`). Reported by [@JD2005L](https://github.com/JD2005L) |

## Watchdog (optional)

Separate from the built-in heal sidecar described above. The heal sidecar targets one specific fault (stuck deferred-tool resume loops) with zero dependencies and no configuration. The watchdog recipe is broader: plugin subprocess health, HTTP bridge reachability, MCP ping, and optional LLM end-to-end ping, with alerting to a channel of your choice. Use both when you want both kinds of protection, or set `selfHeal: false` and let the watchdog do everything.

If you want an external probe to detect silent failures (plugin subprocess dies but systemd still reports "active", MCP stuck, etc.) and restart the service, there's an opt-in recipe at [`recipes/watchdog/`](../recipes/watchdog/). It installs a systemd user timer (Linux) or launchd StartInterval LaunchAgent (macOS) that runs every 5 minutes, does 4 tiered checks, and triggers a restart + alert on failure. Does not touch the running service during install — Claude stays up.

Full docs: [`docs/watchdog.md`](watchdog.md).

## Version stamp

At service start the unit writes the current `git HEAD` of the workspace to a reboot-clean runtime file (`$XDG_RUNTIME_DIR/clawcode-<slug>.version` on Linux, `$TMPDIR/clawcode-<slug>.version` on macOS). The service never reads this back; it exists purely for external observers.

The motivation: `git pull` followed by `/mcp` doesn't actually reload the plugins from disk. The running session keeps serving stale code, and from the outside everything still looks "active". An external watchdog can compare the stamped SHA against the on-disk HEAD and trigger a restart when they diverge. See [`docs/watchdog.md`](watchdog.md) for the consumer side.

The stamp write is best-effort. It's prefixed with `-` on the systemd `ExecStartPre` and wrapped in `|| true` in the launchd `sh -c`, so a missing `git`, a non-git workspace, or a read-only runtime dir never blocks service start. If the stamp file is absent, downstream watchdogs treat that as "drift detection disabled" rather than as a fault.

## Implementation

| File | Role |
|---|---|
| `lib/service-generator.ts` | Pure platform detection, slug + label conventions, plist/unit content generators, plan builder, heal sidecar generators |
| `server.ts` | `service_plan` MCP tool — planning only, no side effects |
| `skills/service/SKILL.md` | UX layer: confirmation prompts, executes plan commands via `Bash` + `Write` |
| `tests/service-generator-smoke.test.ts` | `npm test`. Parses every emitted shell script with `bash -n`, asserts plan shape, exercises wrapper pre-flight + heal sidecar against a synthetic log |
