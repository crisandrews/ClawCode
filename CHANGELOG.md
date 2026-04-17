# Changelog

## [Unreleased]

## [1.4.1] — 2026-04-17

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for two follow-ups from his live service deployment on 2026-04-17: an automatic self-heal for a stuck resume-loop he actually hit in production, and a PATH fix so hooks find `jq` when it's installed user-local.

### Added

- **Automatic self-heal for stuck deferred-tool resume loops.** `claude --continue` can land back inside a session with a stale deferred-tool marker and then log `No deferred tool marker found in the resumed session` or `Input must be provided either through stdin or as a prompt argument when using --print` hundreds of times without crashing, so `StartLimitBurst` never fires and manual intervention was the only exit. `/agent:service install` now ships three layered defenses by default: (1) the resume wrapper gains a pre-flight that honors a `~/.clawcode/service/<slug>.force-fresh` flag and inspects the tail of the service log for the error pattern, skipping `--continue` when the rate exceeds threshold; (2) a new heal sidecar (`clawcode-heal-<slug>.timer` + `.service` on Linux, `com.clawcode.heal.<slug>.plist` on macOS) fires every 60 s, writes the force-fresh flag, and restarts the main service when the pattern trips, observing a 10-minute cooldown between bounces; (3) `StartLimitBurst` tightened from 5 to 3 since the slow-spam failure mode is now Layer 2's job. All three are on by default. Opt out with `service_plan({ action: "install", selfHeal: false })` if an external watchdog (`recipes/watchdog/`) handles recovery. New exported constants `HEAL_PATTERN` / `HEAL_THRESHOLD` / `HEAL_WINDOW_SECONDS` / `HEAL_LOG_TAIL_LINES` are the single source of truth for both layers. First failure mode observed in production by [@JD2005L](https://github.com/JD2005L) on 2026-04-17 (log flood of 22 "deferred tool marker" errors followed by 7 "input must be provided" errors, with `pkill` permission failures preventing self-recovery). Reported by [@JD2005L](https://github.com/JD2005L) in [#19](https://github.com/crisandrews/ClawCode/pull/19) / [#21](https://github.com/crisandrews/ClawCode/pull/21).
- **`npm test`.** New smoke test at `tests/service-generator-smoke.test.ts` runs `bash -n` on every generated shell script, asserts the plan shape for install / uninstall across both platforms, and exercises the wrapper pre-flight + heal sidecar against a synthetic log flood. 18 checks, ~1 second, zero external deps. Tracked publicly via a refined `.gitignore` pattern (`tests/*` + `!tests/*.test.ts`) so future template-interpolation bugs surface at the maintainer's machine before landing on a user's system.
- **`resumeOnRestart` and `selfHeal` now exposed on `service_plan`.** Previously `resumeOnRestart` lived only in the library layer. Both knobs are now part of the MCP tool schema so they're discoverable and opt-outable without dropping into TypeScript.

### Fixed

- **`jq` visible to cron hooks when installed user-local.** `hooks/cron-posttool.sh`, `hooks/reconcile-crons.sh`, and `skills/crons/writeback.sh` now prepend `$HOME/.local/bin:$HOME/bin:/usr/local/bin:/opt/homebrew/bin` to their PATH. Needed when the hook runs under systemd user service / launchd LaunchAgent, where the inherited PATH is minimal and skips Homebrew / pip-user install dirs; without this, `command -v jq` returns empty and the hook silently drops to degraded mode. No effect on interactive sessions where the shell's PATH already exposes `jq`. Reported by [@JD2005L](https://github.com/JD2005L) in [#20](https://github.com/crisandrews/ClawCode/pull/20).

## [1.4.0] — 2026-04-17

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for eight PRs in a single push, all from running ClawCode 24/7 as a systemd service: the WORKSPACE resolution fix, the service crash-loop PTY wrap, resume-on-restart, service hardening defaults, the `/agent:update` skill + heartbeat version-check, cross-user import discovery, the reconcile fast-path, and the follow-up `DISABLE_AUTOUPDATER` rationale that corrected a review miss on our side. This release is largely JD's work.

### Added

- **Resume-on-restart wrapper.** `/agent:service install` now generates `~/.clawcode/service/<slug>-resume-wrapper.sh` and points the systemd unit / launchd plist at it. The wrapper runs `claude --continue` so a service restart rehydrates the prior conversation instead of starting fresh. Falls back to a plain start on first boot (no prior session jsonl) or when the last session is more than 7 days old. Opt-out via `service_plan({ action: "install", resumeOnRestart: false })`. Cross-platform (GNU `stat -c %Y` with BSD `stat -f %m` fallback). Reported by [@JD2005L](https://github.com/JD2005L) in [#7](https://github.com/crisandrews/ClawCode/pull/7).
- **Service hardening defaults.** `generateSystemdUnit` now emits `Environment=HOME=...`, `Environment=TERM=xterm-256color`, and a `StartLimitIntervalSec=300` / `StartLimitBurst=5` crash-loop guard so a deterministic boot-time error surfaces in `systemctl status` instead of churning forever in journald. `generatePlist` emits an `EnvironmentVariables` dict with HOME and TERM. Default log path moved from `/tmp/clawcode-<slug>.log` (wiped on reboot) to `~/.clawcode/logs/<slug>.log`, with the install plan creating the directory up front since neither `append:` nor `StandardOutPath` create missing parents. Reported by [@JD2005L](https://github.com/JD2005L) in [#8](https://github.com/crisandrews/ClawCode/pull/8).
- **`/agent:update` skill + heartbeat version check.** New user-invocable skill that detects installed vs. available versions of Claude Code (`npm view`) and ClawCode (`git describe --tags upstream/main` — tag-based, not HEAD, so routine upstream commits do not generate notification noise) and prints the safe update commands. Never applies updates itself — detect-and-report only, intentional for daemon mode. Heartbeat gains an "Update check" bullet that fires once per UTC day with per-version dedupe via `memory/.notified-versions.json`, so each new version is announced exactly once. Skill gracefully handles no-network, missing `upstream` remote, and non-git-checkout installs. Template-only change for new agents — existing `HEARTBEAT.md` files are unaffected. Reported by [@JD2005L](https://github.com/JD2005L) in [#12](https://github.com/crisandrews/ClawCode/pull/12).

### Fixed

- **`memory_search` and every other MCP tool that reads `WORKSPACE` now resolves to the user's project dir, not the plugin dir.** `server.ts` used `process.cwd()` for `WORKSPACE`, but `.mcp.json` runs the server with `cd "${CLAUDE_PLUGIN_ROOT}" && exec …`, which silently clobbered the agent's real workspace. Identity injection via hooks was unaffected (hooks already use `${CLAUDE_PROJECT_DIR:-$PWD}`), so the agent felt wired up correctly while memory silently read from the plugin's bundled `memory/` folder. Fix: three-step fallback `CLAUDE_PROJECT_DIR || OLDPWD || process.cwd()`, mirroring the hooks. Closes [#5](https://github.com/crisandrews/ClawCode/issues/5). Reported by [@JD2005L](https://github.com/JD2005L) in [#6](https://github.com/crisandrews/ClawCode/pull/6).
- **Service crash loop on Linux systemd after Claude Code auto-updates mid-run.** When the in-process auto-updater regenerates wrapper scripts while the daemon is running, the resulting invocation runs without a PTY; on the next graceful shutdown the `SessionEnd` hook cannot spawn `/bin/sh`, exits non-zero, and `Restart=on-failure` produces a permanent loop. Fix: wrap `ExecStart` in `/usr/bin/script -q -c '...' /dev/null` so `claude` always has a PTY from the outside, and set `Environment=DISABLE_AUTOUPDATER=1` so the auto-updater cannot regenerate daemon-relevant files mid-run (a file-integrity issue distinct from the PTY crash-loop). Together the two are addressing different failure modes — the PTY wrap covers graceful shutdown, the env var covers version skew between the in-memory process and on-disk binary while the daemon runs. Reported by [@JD2005L](https://github.com/JD2005L) in [#9](https://github.com/crisandrews/ClawCode/pull/9) and clarified via [#17](https://github.com/crisandrews/ClawCode/pull/17) / [#18](https://github.com/crisandrews/ClawCode/pull/18) after an interim removal in #16 proved premature.
- **Service PTY parity on macOS launchd.** `generatePlist` now wraps the invocation in `/usr/bin/script -q /dev/null <claudeBin> <args>` (BSD syntax). launchd services run without a controlling TTY by default, same shape as systemd, so the SessionEnd-hook failure mode fixed on Linux in #9 could in principle hit Mac. Applies the same protection mechanism. [#16](https://github.com/crisandrews/ClawCode/pull/16).
- **Cross-user `/agent:import` discovery.** The import skill looked only under `~/.openclaw/workspace*`, which missed the common container case where OpenClaw ran as `root` and ClawCode runs as a non-root service user. New discovery loop unions readable `$CLAWCODE_OPENCLAW_ROOT`, `$HOME/.openclaw`, and `/root/.openclaw`, silently skipping unreadable roots so the user never sees permission-denied spam. A new Step G in the import flow also scans `~/.claude/settings.json`, `~/.claude/installed_plugins.json`, and `./agent-config.json` for absolute paths pointing at a different user's home directory — when the runtime user switches, those paths become unreachable and skills fail with "unknown skill". ClawCode does not own these files, so Step G is detect-and-warn only (prints a ready-to-run `sed` command); the user decides whether to apply. Reported by [@JD2005L](https://github.com/JD2005L) in [#10](https://github.com/crisandrews/ClawCode/pull/10).

### Performance

- **`hooks/reconcile-crons.sh` fast-path on steady-state sessions.** Every `SessionStart` previously emitted a `ToolSearch` + `CronList` + `CronCreate` envelope to verify that every cron in `memory/crons.json` was live in the harness — a few hundred milliseconds of blocking tool calls for a check that only has real work to do on the first session after install or after external drift. The hook now exits 0 immediately when (a) no migration is pending and (b) every active entry already has a populated `harnessTaskId`. First boot, upgrades from older versions, external `CronDelete` captured by writeback, and corrupt `crons.json` all fall through to the existing envelope path, so the behavior is unchanged in every case that actually needs reconciliation. Worst-case drift is bounded at 30 min by the heartbeat skill's reconcile step — which is tighter than the status quo for workspaces that do not session-start often. Reported by [@JD2005L](https://github.com/JD2005L) in [#11](https://github.com/crisandrews/ClawCode/pull/11).

### Documentation

- `docs/service.md` — updated example systemd unit and launchd plist to reflect the new defaults (`HOME`/`TERM` env, crash-loop guard, persistent log path). Logs section rewritten to describe the new path and explain why the log directory is created at install. Troubleshooting row for restart loops now points at `~/.clawcode/logs/<slug>.log` and mentions `StartLimitBurst=5`. New "Resume-on-restart wrapper" section explaining the default behavior, 7-day stale-session fallback, and the opt-out.
- `docs/autoresearch.md`, `docs/task-guard.md` — *not in this release.* PRs #13 and #14 are deferred to a future session.
- `skills/import/SKILL.md` — discovery loop + Step G "Path sanity check" documented inline, with fix-ready `sed` suggestions.
- `skills/update/SKILL.md` — new user-invocable skill, with permission caveats (root-owned `node_modules/`, need for operator to run the install command) and channel-specific formatting notes (WhatsApp `*bold*` vs. Telegram markdown).
- `templates/HEARTBEAT.md` — new "Update check" bullet with day-gate and per-version dedupe.

## [1.3.0] — 2026-04-15

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for the thorough write-up in [#4](https://github.com/crisandrews/ClawCode/issues/4) — 13 friction points from running ClawCode 24/7 as a systemd service with Telegram on Debian LXC. This release addresses 7 of them directly (item 1 TTY bypass-dialog hang, item 6 multi-instance race on restart, item 10 config-edit MCP drop, item 11 stale plugin paths after user switch, item 12 stale FTS index after import, plus item 5 groundwork via the new opt-in watchdog which is the testable answer to "plugin subprocess dies silently"). Items deferred to future iterations are parked in `ideas/`.

### Fixed
- `memory_search` now picks up files added or edited during a session. Previously the FTS index was only re-synced on the first search after MCP startup or via `/agent:doctor --fix` — files added mid-session (e.g. by `/agent:import` while a session was running, or new WhatsApp / Telegram conversation logs landing under an `extraPaths` directory) stayed invisible until restart. Root cause: the `dirty` flag in `MemoryDB` was initialized to `true` (so the first search synced) but `markDirty()` had no external callers, so subsequent file changes never triggered a re-sync. Fix: the `MemoryDB` constructor now sets up an `fs.watch` on `memory/` (top-level) and on each entry in `memory.extraPaths` (recursive on macOS / Windows; top-level only on Linux due to a Node `fs.watch` limitation). Any `.md` create / edit / rename / delete marks the index dirty so the next search re-syncs. Best-effort with a `try/catch` fallback per watcher — if a watcher cannot be created (missing path, NFS, watcher limits), the existing dirty-on-startup behavior + `/agent:doctor --fix` still cover the user. Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4) item 12; the user's stated symptom ("only `MEMORY.md` indexed after import") was an indirect effect of this bug.

### Added
- `/agent:service install` now pre-checks `~/.claude/settings.json` before writing any service files. If `skipDangerousModePermissionPrompt: true` is missing, the skill explains the consequence (silent hang at startup with no TTY to answer the bypass dialog) and offers to add it via a `jq`-based atomic merge that preserves any existing keys. Decline once and the skill warns; decline twice and install aborts cleanly without touching launchd / systemd. Cross-platform: same fix applies to macOS launchd and Linux systemd because the file is `~/.claude/settings.json` on both.
- **Watchdog (optional)**: new `recipes/watchdog/` folder with an opt-in external health probe for always-on services. A short-lived `watcher.sh` runs every 5 min (via systemd user timer on Linux or launchd `StartInterval` on macOS) and performs up to **5 tiered checks** — service-manager status, HTTP bridge `/health`, new ClawCode `/watchdog/mcp-ping` endpoint, scoped `pgrep -P <main-pid>` against expected channel plugins, and new `/watchdog/llm-ping` which injects a `__watchdog_ping__ PONG-<nonce>` message and polls chat history for the agent's echo to verify the LLM is responding end-to-end. First failing tier short-circuits and triggers `--on-fail` (default: restart) plus optional `--alert-cmd` (Telegram Bot API helper + generic template shipped). New `watchdog_ping` MCP tool and both HTTP routes refuse non-loopback requests regardless of `http.host` (belt-and-suspenders middleware) and inherit the bridge's token auth. Tier 5 LLM ping additionally requires `http.token` (token-drain protection) and is rate-limited to 1/hour per token; watcher also guards with its own `--llm-ping-interval` (default 3600s). Installers auto-detect label / port / token / installed plugins; typical install asks zero or one question. Does not touch the running service during install. Full docs: [`docs/watchdog.md`](docs/watchdog.md). Reported by [@JD2005L](https://github.com/JD2005L) in [#4 item 5](https://github.com/crisandrews/ClawCode/issues/4).
- **Public helper** `isLoopbackAddress(addr: string | undefined): boolean` exported from `lib/http-bridge.ts`. Pure classifier used internally by `/watchdog/*` routes to refuse non-loopback peers (covers IPv4, IPv6, IPv4-mapped-IPv6). External code may consume it; small surface, no runtime behavior change vs. prior inline version.
- `lib/service-generator.ts` now emits `ExecStartPre=-/usr/bin/pkill -f "claude.*--dangerously-skip-permissions"` in the systemd unit on Linux. Prevents the multi-instance race condition where a restart leaves the old `claude` briefly alive next to the new one and both connect to the same channel, fighting for incoming messages. The `-f` filter only matches service-mode invocations, so an interactive `claude` session in another terminal is left alone. macOS plist is unchanged — launchd already guarantees single-instance per Label. Existing installs do not benefit automatically; reinstall (`/agent:service uninstall` + `/agent:service install`) to regenerate the unit. Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4).

### Documentation
- `docs/service.md` — added a "Heads-up" note inside the safety trade-off section and a troubleshooting row explaining that `--dangerously-skip-permissions` alone is not enough under launchd / systemd: bypass mode shows an interactive `WARNING: Bypass Permissions mode — Do you accept?` dialog at startup that a daemon has no TTY to answer, so the service hangs silently before reaching the listening state. Fix: persist `"skipDangerousModePermissionPrompt": true` in `~/.claude/settings.json` before installing the service. Tracked upstream as [anthropics/claude-code#25503](https://github.com/anthropics/claude-code/issues/25503). Only affects service mode; interactive `claude` is unaffected.
- `docs/service.md` — troubleshooting row noting that editing `~/.claude/settings.json` while the service runs reloads MCPs and some plugins (Telegram observed) do not reconnect, leaving the service "active" but dropping messages. Fix: restart the service after any manual edit. Reported by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4).
- `docs/doctor.md` — added "Issues NOT auto-fixed" entry for "unknown skill" errors caused by stale plugin paths in `~/.claude/plugins/installed_plugins.json` after a runtime user change. The file is Claude Code internal (ClawCode does not own it), so doctor cannot safely auto-rewrite. Documented manual `jq` fix (validated by [@JD2005L](https://github.com/JD2005L) in [#4](https://github.com/crisandrews/ClawCode/issues/4)).
- `docs/watchdog.md` — new full user guide for the optional watchdog recipe.
- `docs/INDEX.md` — watchdog row added under "Optional".
- `docs/memory.md` — rewrote the three lines that claimed "re-syncs on next search" to reflect the actual behavior after the `fs.watch` fix; added a paragraph to the `extraPaths` section about the Linux recursive-watch caveat.
- `README.md` — mascot image added above the title; watchdog link added after the always-on-service section.
- `assets/clawcode.png` (new) — mascot artwork used by the README.

## [1.2.2] — 2026-04-13

### Thanks
- @JD2005L for reporting [#1](https://github.com/crisandrews/ClawCode/issues/1) — the investigation into your report surfaced a bug that affected every user silently. Fix below.

### Fixed (GitHub issue #1)
- **Reminders now persist across session closes.** Previously the SessionStart hook relied on a `.crons-created` marker that persisted on disk while the crons themselves died with the session, so heartbeat / dreaming / imported / ad-hoc crons silently disappeared after every restart. The new system keeps a registry at `memory/crons.json` and reconciles it against the live harness on every SessionStart — anything missing is recreated, anything live-but-unknown is adopted.
- **Ad-hoc reminders ("remind me in 4 hours to X") survive restarts.** A PostToolUse hook captures every `CronCreate` call and writes it to the registry; next session, reconcile recreates it.
- **User deletions stay deleted.** `CronDelete` tombstones the registry entry; reconcile skips it.

### Added
- `/agent:crons` skill extended with subcommand dispatcher: `list`, `add`, `delete`, `pause`, `resume`, `reconcile`, plus existing `import`. Aliases: `/agent:reminders`, "list reminders", "show crons", "recordatorios", "mis crons".
- `skills/crons/writeback.sh` — single writer for `memory/crons.json`. Subcommands: `seed-defaults`, `upsert`, `tombstone`, `set-alive`, `adopt-unknown`, `pause`, `resume`, `migration-mark`. Lockfile-protected, atomic-write.
- `hooks/reconcile-crons.sh` — SessionStart hook. Seeds defaults, detects migration need, emits a deterministic reconcile envelope for the agent to execute. Degraded-mode fallback if `jq` is missing.
- `hooks/cron-posttool.sh` — PostToolUse hook on `CronCreate`/`CronDelete`. Captures ad-hoc crons; tombstones on delete. Idempotent via `harnessTaskId` key. Suppressed during reconcile via `memory/.reconciling` marker.
- Migration flow for upgraders who had OpenClaw imports: SessionStart detects `IMPORT_BACKLOG.md` + `~/.openclaw/cron/jobs.json` and offers re-import via native `AskUserQuestion` (Sí / Después / No nunca). Answer persisted in `migration.openclawAnsweredAt`; auto-flagged if user runs `/agent:crons import` manually.
- `docs/crons.md` — user-facing documentation: registry schema, commands, harness assumptions, failure modes.
- Doctor adds two checks: `cron-registry` (parseable + stale tombstone count) and `jq` (presence).
- Tests: `tier1m-cron-registry.sh` (18 unit tests for writeback), `tier2q-reconcile-hook.sh` (10 integration tests for reconcile hook), `tier2r-cron-posttool.sh` (10 integration tests for posttool hook), plus `tests/stubs/Cron{Create,List,Delete}.sh` fakes.

### Removed
- Inline "MANDATORY ACTION REQUIRED" bash block in SessionStart hook — replaced with a single `bash ${CLAUDE_PLUGIN_ROOT}/hooks/reconcile-crons.sh` invocation.
- `server.ts` bootstrap context's inline `CronCreate(..., durable=true)` instructions — replaced with a short reference to the reconcile flow.
- `skills/import/SKILL.md` Step B no longer tells the agent to call CronCreate directly — delegates to `writeback.sh seed-defaults`.
- Legacy `.crons-created` marker at workspace root is now cleaned up automatically by reconcile-crons.sh on first run (kept in `.gitignore` so users mid-upgrade don't accidentally commit it).

## [1.2.1] — 2026-04-13

### Security
- Token is now **required** when HTTP bridge binds to non-localhost (`host != 127.0.0.1`). Bridge refuses to start without one.
- WebChat HTML now requires auth when token is configured (was served without auth before).

### Added
- Webhook tutorials: Cloudflare Email Worker catch-all, Gmail push via Pub/Sub (full code + setup steps)
- Webhook use cases linked from README to detailed docs
- Self-managing heartbeat: agent edits `HEARTBEAT.md` with initiative during conversations
- Lightweight `HEARTBEAT.md` template (5 lines, not 50)
- Heartbeat state tracking via `memory/heartbeat-state.json`
- Plugin update workaround in README (manual method when `/plugin update` says "already at latest")

### Fixed
- Heartbeat template was too heavy — moved behavioral rules to AGENTS.md and skill, kept only the checklist in HEARTBEAT.md

## [1.2.0] — 2026-04-13

### Fixed
- Silent `npm install` failure — errors are now visible instead of "Failed to reconnect" with no explanation
- Dependencies only install if not already present (faster subsequent sessions)

### Added
- Cron persistence limitation documented in troubleshooting

## [1.1.0] — 2026-04-12

### Added
- Active memory with bilingual recall (ES ↔ EN, 40+ synonym pairs)
- Date expansion in memory queries ("hoy" → today's date)
- Voice TTS/STT (sag, ElevenLabs, OpenAI, macOS say, Whisper)
- WebChat browser UI with SSE real-time delivery
- Conversation logging in JSONL + Markdown (same format as WhatsApp plugin)
- HTTP bridge with status/skills/webhook/chat endpoints
- Live config — non-critical settings apply without `/mcp`
- Channel detector + launch command builder
- Command discovery (dynamic `/help`)
- `/doctor` diagnostics with `--fix` auto-repair
- Skill manager — install from GitHub with `owner/repo@branch#subdir`
- Service manager (launchd/systemd)
- AskUserQuestion wizard for import/create flows
- Clean imports — no file annotations, all notes go to IMPORT_BACKLOG.md
- Terse agent behavior by default
- Lifecycle hooks documented (SessionStart, PreCompact, Stop, SessionEnd)
- Language adaptation — responds in user's language

### Fixed
- `CronCreate` parameter is `cron`, not `schedule`
- `CronCreate` is a deferred tool — needs `ToolSearch` first
- Bilingual memory recall: `recencyBoost` was passing `ageDays` instead of `filePath`
- FTS5 query changed from AND to OR (improves cross-language recall)

## [1.0.0] — 2026-04-09

### Added
- Initial release
- Persistent identity (SOUL.md, IDENTITY.md, USER.md)
- Memory system (SQLite + FTS5, temporal decay, MMR)
- QMD optional backend (local embeddings)
- Dreaming (3-phase: Light, REM, Deep with 6 weighted signals)
- Heartbeat (30-min periodic checks)
- Bootstrap ritual (conversational onboarding)
- Import from existing agent workspaces
- Skills: create, import, crons, heartbeat, settings, messaging, status, usage, new, compact, help, whoami
- Hooks: SessionStart, PreCompact, Stop, SessionEnd
- Messaging channel support (WhatsApp, Telegram, Discord, iMessage, Slack)
