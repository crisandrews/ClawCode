# Watchdog — external health monitor for your always-on service

Optional, opt-in external watchdog that probes your ClawCode service every few minutes and restarts it if anything's wrong. Shipped as a **recipe** under [`recipes/watchdog/`](../recipes/watchdog/) — you copy and install it when you want it. Nothing in core depends on this.

Off by default. If you never install it, nothing runs.

## Why you might want it

When you run ClawCode as an always-on service (launchd / systemd), several things can go quiet without systemd noticing:

- The plugin subprocess (Telegram, WhatsApp, etc.) crashes while the main `claude` process keeps running → systemd shows "active" but messages silently drop
- The MCP server gets stuck in an unrecoverable state
- The HTTP bridge stops responding
- The service crashes and `Restart=` bounces it into a failure loop

The watchdog catches these cases, logs the diagnosis, restarts the service, and optionally alerts you on a separate channel (Telegram / Pushover / email / webhook / your choice).

## How it works

A short-lived `watcher.sh` is triggered every 5 minutes by your OS's scheduler (systemd timer on Linux, launchd `StartInterval` on macOS). It runs up to **5 checks in order** and stops at the first failure:

| Tier | Probe | Proves | Requires HTTP bridge | Touches LLM |
|---|---|---|---|---|
| 1 | `systemctl --user is-active <unit>` / `launchctl print` | OS sees your service as running | No | No |
| 2 | `curl /health` | HTTP bridge + Node event loop responsive | Yes | No |
| 3 | `curl /watchdog/mcp-ping` | ClawCode MCP handler dispatches correctly | Yes | No |
| 4 | `pgrep -P <service main PID>` vs expected plugin list | Plugin subprocesses (Telegram, WhatsApp, …) still alive | No | No |
| 5 | `curl -X POST /watchdog/llm-ping` | LLM responds end-to-end with `PONG-<nonce>` | Yes | **Yes** |

**Why scoped pgrep?** Tier 4 finds your service's main PID via `systemctl show -p MainPID` (or `launchctl print | awk '/pid =/'`) and lists only its children. A parallel interactive `claude` running elsewhere has a different PID tree — it can't be mistaken for a service subprocess.

**Tier 5 — LLM ping (opt-in, costs tokens):** runs on its own cadence (default 1/hour via `--llm-ping-interval=3600`) because each call consumes LLM tokens and injects a brief message into the agent's chat history. The endpoint:

1. Generates an 8-hex nonce
2. Pushes a user-role message `__watchdog_ping__ Respond immediately with just \`PONG-<nonce>\` (no other text)` into the WebChat inbox (same queue as real WebChat messages, triggering the agent)
3. Polls chat history for an agent reply containing `PONG-<nonce>`
4. Returns 200 with latency on success, 504 on timeout (default 30s)

For Tier 5 to actually pass in production, the agent's `CLAUDE.md` should include an instruction to recognize `__watchdog_ping__` prefixed messages and respond via `webchat_reply("PONG-<nonce>")`. Without that, the agent may respond conversationally or not at all, and the probe times out.

Tier 5 also requires `http.token` to be set — even though the route is already loopback-only, this is defense-in-depth against a rogue local process draining your LLM tokens. Rate-limited at **1 call per hour per token** at the endpoint level (independent of the watcher's interval) so even if `--llm-ping-interval=0` you still can't hit it more than hourly.

If any tier fails and the watcher is past its cooldown window (default 5 min), it runs `--on-fail` (default: `systemctl --user restart <unit>` / `launchctl kickstart -k`) and optionally `--alert-cmd`. Both are composable — you set them in the installer.

## Install

**Prerequisites:** you already have the always-on service set up (see [`service.md`](service.md)). For Tier 2/3 you need the HTTP bridge enabled (see [`http-bridge.md`](http-bridge.md)); for Tier 1/4 you don't.

Run from your ClawCode workspace:

```bash
# Linux
bash recipes/watchdog/install-linux.sh

# macOS
bash recipes/watchdog/install-mac.sh
```

Both auto-detect the service label, HTTP port/token, and installed channel plugins. You'll be asked **one question** — whether to enable Telegram alerts — and only if a Telegram plugin authentication is already present at `~/.claude/channels/telegram/.env`. Everything else is auto-derived.

**Dry run first** if you want to see exactly what gets written without enabling anything:

```bash
bash recipes/watchdog/install-linux.sh --dry-run
```

### Does it touch the running service?

**No.** The installer writes the timer / plist files and enables the scheduler. It does **not** restart or stop your running ClawCode process. You can install in the middle of an active conversation — the agent won't notice.

The service restart only happens when the watchdog actually detects a failure. That's the same restart you'd do with `systemctl --user restart` / `launchctl kickstart -k` by hand.

## What it doesn't catch

Process alive ≠ network connection healthy. If a plugin's `bun` subprocess is still running but has silently lost its upstream WebSocket/API connection (rare but possible), Tier 4 passes because the PID is there. Detecting this reliably requires plugin-side instrumentation (a heartbeat file, a health tool) that upstream plugins don't expose today.

The majority of real failures are process crashes — OOM kill, unhandled exception, SIGKILL. Those Tier 4 catches cleanly.

**Restart failure** (port in use, lockfile held, DB locked) is logged but not retried. You'll see it in the log and intervene by hand. Automatic escalation is out of scope for this recipe.

## Alerts

When a check fails and the watcher runs `--on-fail`, it also calls `--alert-cmd` if configured. Two examples ship with the recipe:

- **`alert-telegram.sh`** — sends a Telegram message via the Bot API. Works even when your agent is dead (it's a direct HTTPS call to `api.telegram.org`, not going through the plugin). Reads `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` from environment; auto-sources them from `~/.claude/channels/telegram/.env` if available.
- **`alert-generic.sh`** — template with ready-to-uncomment blocks for ntfy.sh, Pushover, Slack webhook, Discord webhook, generic webhook (Zapier / n8n), and local `mail`. Pick one, uncomment, set its env vars in the timer/plist.

### Why not WhatsApp?

The WhatsApp channel plugin uses reverse-engineered WhatsApp Web — there is no public Bot API to call. Sending a WhatsApp message requires the plugin process to be alive, which is a chicken-and-egg situation when the watchdog is firing precisely because the plugin died. Use Telegram or any generic out-of-band service for watchdog alerts.

## Security

- **Loopback socket peer only.** All HTTP probes go to `127.0.0.1`. The `/watchdog/*` routes in the HTTP bridge refuse requests whose TCP peer is not `127.0.0.1`/`::1`/`::ffff:127.0.0.1` (`req.socket.remoteAddress`), regardless of how `http.host` is configured. **Caveat**: this is socket-peer enforcement, not origin enforcement — a local reverse proxy or tunnel can relay remote-origin traffic that appears loopback to the bridge. For tunneled deployments the practical boundary is the token (and the `/watchdog/llm-ping` 1/hour rate limit), not loopback. Don't put the bridge behind a reverse proxy and assume the watchdog endpoints stay private.
- **Token inheritance.** If you've set `http.token` in `agent-config.json`, the installer reads it and passes it to the watcher. The Bearer requirement applies to `/watchdog/mcp-ping` the same way it applies to `/v1/*`.
- **Alert scripts read tokens from environment.** Never hardcode `TELEGRAM_BOT_TOKEN` (or any other secret) into the alert scripts or timer/plist files — keep them in `~/.claude/channels/telegram/.env` (0600) or the service's environment.

## Logs

**Tick log:** `/tmp/clawcode-watchdog-<label>.log` — one line per check. Example:

```
2026-04-14T18:23:05Z | OK    | tier1:pass tier2:pass tier3:pass tier4:pass       | -
2026-04-14T18:28:05Z | FAIL  | tier1:pass tier2:pass tier3:pass tier4:FAIL(no-telegram) | restart
2026-04-14T18:28:12Z | INFO  | post-restart verify                                | tier1:pass
2026-04-14T18:33:05Z | SKIP  | tier4:FAIL                                         | cooldown (312s left)
```

On failure + restart, the watchdog also appends the **last 30 lines of the service log** (`/tmp/clawcode-<slug>.log`) into the watchdog log, so when you come back later you can see what the service was doing right before it died.

**Rotation** isn't shipped — use `logrotate` (Linux) or a nightly `truncate -s 0` cron on macOS if the file grows.

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

State files at `/tmp/clawcode-watchdog-<label>.state` and the log file persist — remove them manually if you want a clean slate.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| All ticks log `tier1:FAIL(not-loaded)` | Service label doesn't match what's installed | Pass `--label=<real-label>` to the installer and reinstall |
| Ticks log `tier4:FAIL(no-telegram)` but the Telegram bot clearly works | Expected plugins list doesn't include `telegram`, or `telegram` doesn't appear in the bun subprocess cmdline | Either set `--expected-plugins=...` explicitly or remove Tier 4 from the timer's `ExecStart` |
| Ticks fire but no restart happens | `--on-fail` missing, empty, or pointing at the wrong unit | Edit the generated `.service` / plist and restart the timer/LaunchAgent |
| Telegram alerts never arrive | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` not in env | Add to `~/.claude/channels/telegram/.env` (the auto-source path) or export them in the watcher's environment |
| After install, service stopped responding | Watchdog restart triggered on a false positive during install | Inspect the log; probably a race during the first few seconds. Either extend `--cooldown` or increase `OnBootSec` in the timer. |
| `/watchdog/mcp-ping` returns 503 | HTTP bridge is running but `getWatchdogInfo` wasn't wired — check your ClawCode version. Should never happen on 1.2.3+ | Update ClawCode |
| `curl /watchdog/mcp-ping` from LAN returns 403 | Loopback-socket-peer enforcement (working as designed) | Use a local curl. Direct LAN access is refused; a local reverse proxy or tunnel could relay external traffic and bypass this — set a strong `http.token` if you do that |

## Implementation

| File | Role |
|---|---|
| `recipes/watchdog/watcher.sh` | One-shot probe — all tier logic lives here |
| `recipes/watchdog/install-linux.sh` | Generates + enables systemd user timer |
| `recipes/watchdog/install-mac.sh` | Generates + loads LaunchAgent plist |
| `recipes/watchdog/alert-telegram.sh` | Telegram Bot API alert |
| `recipes/watchdog/alert-generic.sh` | Template for other alerting backends |
| `server.ts` | `watchdog_ping` MCP tool + helper `buildWatchdogPing()` |
| `lib/http-bridge.ts` | `/watchdog/mcp-ping` route + `isLoopbackRequest` middleware |

Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4).
