# ClawCode Watchdog (recipe)

Optional, opt-in external watchdog for ClawCode services. Detects the most common failure modes — service down, HTTP bridge unreachable, ClawCode MCP stuck, plugin subprocess dead — and can restart the service and notify you.

**Not installed by default.** Copy or run the installers here when you want it. Nothing in ClawCode core depends on this.

> Full user-facing docs: [`docs/watchdog.md`](../../docs/watchdog.md). This README is a quick-start.

## What it does

A short-lived `watcher.sh` runs every 5 minutes (via systemd timer on Linux, `StartInterval` launchd job on macOS) and checks, in order:

| Tier | Check | What it proves | Needs HTTP bridge? |
|---|---|---|---|
| 1 | `systemctl / launchctl is-active` | OS sees your service as running | No |
| 2 | `GET /health` (curl) | HTTP bridge + Node event loop responsive | Yes |
| 3 | `GET /watchdog/mcp-ping` | ClawCode MCP dispatch works | Yes |
| 4 | `pgrep -P <main-pid>` vs expected plugin list | Plugin subprocesses (Telegram, WhatsApp, etc.) alive | No |
| 6 | Boot-time git HEAD stamp vs on-disk HEAD | Service is running current code (catches `git pull` without restart) | No |

First failing tier short-circuits the rest. If any tier fails and we're past the cooldown, it runs `--on-fail` (default: restart via the service manager) and optionally `--alert-cmd`.

> Tier 5 (LLM end-to-end ping) is off by default — it costs tokens. Enable with `--tier=5` if you want it.
> Tier 6 (version drift) auto-enables when the installer detects a git workspace. The service writes its boot-time SHA to a reboot-clean stamp (see [`docs/service.md`](../../docs/service.md#version-stamp)); the watchdog diffs the stamp against the current HEAD and treats a mismatch as "stale code → restart". Silently skipped on non-git workspaces.

## Install

Run from **your ClawCode workspace** (the folder with `agent-config.json`). The installer auto-detects everything it can — you'll be asked at most one question (alert channel).

### Linux

```bash
bash /path/to/recipes/watchdog/install-linux.sh
# or dry-run first to see what it would write:
bash /path/to/recipes/watchdog/install-linux.sh --dry-run
```

Installs a user-level systemd timer at `~/.config/systemd/user/clawcode-watchdog-<slug>.timer`. Runs as the same user as the ClawCode service — no sudo needed.

### macOS

```bash
bash /path/to/recipes/watchdog/install-mac.sh
bash /path/to/recipes/watchdog/install-mac.sh --dry-run
```

Installs a user LaunchAgent at `~/Library/LaunchAgents/com.clawcode.watchdog.<slug>.plist`.

## Does it touch my running service?

**No.** The installer creates timer/plist files and enables them. It does **not** stop or restart the running `claude` process. You can install while in an active conversation.

Only when the watchdog detects a failure does it call the service manager to restart — the same restart you'd do with `systemctl --user restart` or `launchctl kickstart -k` manually.

## What it does NOT catch

- **Plugin alive but disconnected from its upstream API** (e.g. Telegram plugin `bun` process is running but lost its Bot API connection). Tier 4 only checks the subprocess exists. Upstream plugins don't expose a native health probe; detecting this reliably requires plugin-side changes we don't own.
- **Restart failures** (port held, lockfile, DB locked). Watchdog logs the failure but does not retry. You'll see it in the log and need to intervene.

The 95% of real failures are process crashes (SIGKILL, OOM, unhandled exceptions). Those the watchdog catches cleanly.

## Security

- All HTTP calls go to `127.0.0.1`. The `/watchdog/*` routes refuse non-loopback requests even if you misconfigure the bridge to bind a public interface.
- If you've set `http.token` in `agent-config.json`, the installer reads it automatically and passes it to the watcher. The same token works for `/watchdog/*`.
- Alert scripts read tokens from environment (e.g. `TELEGRAM_BOT_TOKEN`). Never commit them into these files.

## Alerts

The watchdog calls `--alert-cmd` (if set) after running `--on-fail`. Two examples ship here:

- **`alert-telegram.sh`** — sends a Telegram message via the Bot API. Works even when the agent is dead (direct API call). Reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` from environment, or auto-sources `~/.claude/channels/telegram/.env`.
- **`alert-generic.sh`** — commented template with ready-to-uncomment blocks for ntfy.sh, Pushover, Slack webhook, Discord webhook, generic webhook (Zapier / n8n / your own), and local `mail`.

**WhatsApp note:** there is no WhatsApp Bot API. Sending via the WhatsApp channel plugin requires the plugin to be alive — chicken-and-egg when the watchdog is alerting because the plugin died. Use Telegram or a generic out-of-band alerting service (ntfy, Pushover, email, Slack) instead.

## Logs

- `/tmp/clawcode-watchdog-<label>.log` — one line per tick. On failure + restart, also appends the last ~30 lines of the service log for diagnosis.
- systemd: `journalctl --user -u clawcode-watchdog-<slug>.service` additionally captures stdout/stderr of the timer firings.
- Launchd: the plist redirects stdout/stderr to `/tmp/com.clawcode.watchdog.<slug>.log`.

Rotation isn't shipped. Use `logrotate` on Linux or a `cron` `truncate -s 0` on macOS if the file grows.

## Uninstall

### Linux

```bash
systemctl --user disable --now clawcode-watchdog-<slug>.timer
rm ~/.config/systemd/user/clawcode-watchdog-<slug>.{timer,service}
systemctl --user daemon-reload
```

### macOS

```bash
launchctl bootout gui/$(id -u)/com.clawcode.watchdog.<slug>
rm ~/Library/LaunchAgents/com.clawcode.watchdog.<slug>.plist
```

State files at `/tmp/clawcode-watchdog-<label>.state` and logs persist — remove manually if desired.

## Files in this recipe

| File | Role |
|---|---|
| `watcher.sh` | The one-shot check script. All tier logic lives here. |
| `install-linux.sh` | Generates + enables the systemd user timer. |
| `install-mac.sh` | Generates + loads the LaunchAgent plist. |
| `alert-telegram.sh` | Working Telegram alert using the Bot API. |
| `alert-generic.sh` | Template for ntfy / Pushover / Slack / Discord / webhook / mail. |
| `README.md` | You are here. |
