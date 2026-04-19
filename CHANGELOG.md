# Changelog

## [Unreleased]

## [1.4.9] — 2026-04-19

### Fixes

- Skills/release: removed `skills/release/` from the plugin distribution. It was wrongly placed at plugin scope in v1.4.7-v1.4.8 — every end user of an agent (Cloudy, Wally, etc.) saw a "release" skill in their `/plugin` viewer that referenced cutting a ClawCode plugin release, which has nothing to do with their agent. The skill is for the maintainer flow only and now lives at the user-scope path `~/.claude/skills/clawcode-release/SKILL.md` on the maintainer's own machine, not in the published plugin. Plugin manifest, end-user agent config, and runtime behavior are unchanged. v1.4.7 and v1.4.8 GitHub releases that contained the skill in the source tarball are being deleted as part of this cleanup.

## [1.4.8] — 2026-04-19

### Changes

- Skills/release: adopt OpenClaw's release-notes format as the canonical style for both CHANGELOG entries and `gh release` bodies. Two groups only (`### Changes` / `### Fixes`, no Added/Removed/Changed sprawl), bullets prefixed with `Area/subarea:` scope, one-line narrative + outcome, optional `(#PR) Thanks @user.` suffix, link back to CHANGELOG at the end. Mirrors the conventions used by `openclaw/openclaw` (~360k stars) so anyone landing on the ClawCode releases page reads them the same way they read OpenClaw's. Concrete worked example added to the skill body.

## [1.4.7] — 2026-04-19

### Added

- **`/about` and `/version` slash commands** for the agent. Responds with a 3-line card (`🔌 *ClawCode* v<version>` + repo URL + invitation to file issues / star). The version is read dynamically from `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` so it never goes stale. Recognized on every channel (CLI, WhatsApp, Telegram, Discord, iMessage). Surfaces the repo to users who installed via marketplace and would otherwise have no way to find docs / file issues / star the project from inside their agent. Pattern lifted from OpenClaw's HOOK.md `homepage` field convention but inverted: instead of metadata-only discovery via `/plugin` viewer, this is an active surfacing the agent can do mid-conversation when asked. Templates/CLAUDE.md updated; `/help` table includes the new command.
- **`skills/release/` — the release flow as an actual skill**, not just a memory. Documents the 4 mandatory steps for cutting a new ClawCode plugin release (bump versions in both manifests, move `[Unreleased]` to `[X.Y.Z]` in CHANGELOG, commit + push, AND `gh release create`). Exists because the agent maintaining the plugin has repeatedly forgotten step 4 — version went into code but no GitHub Release appeared. JC flagged it as a recurring miss on 2026-04-19; this skill makes it impossible to skip. Triggers on `/agent:release`, "cut a release", "ship vX.Y.Z", etc.

## [1.4.6] — 2026-04-19

### Added

- **Plugin metadata for the `/plugin` viewer.** `.claude-plugin/plugin.json` now declares `homepage`, `repository`, `license`, and `author.url` — without these the `/plugin` view rendered the plugin card with no link back to the repo, which meant users who installed via the marketplace had no way to find docs, file issues, or star the project from inside Claude Code. Mirrors the field set already used by `crisandrews/claude-whatsapp` so both plugins surface the same way. Pure metadata, no behavior change.

## [1.4.5] — 2026-04-19

### Fixed

- **Reminders now actually survive `/exit` + relaunch.** Three concatenated bugs in v2.1.114 silently broke the persistence promise of the cron registry; verified end-to-end on a live WhatsApp agent before/after fix:
  - **PostToolUse hook regex was stale.** Claude Code v2.1.114 changed the `CronCreate` `tool_response` from a plain string (`"Scheduled <id> (<cron>)"`) to a JSON object (`{"id":"<id>","humanSchedule":"<cron>","recurring":<bool>,"durable":false}`). The hook's regex looked for the legacy string, missed the object form, and silently exited — every ad-hoc reminder went uncaptured. Hook now parses `.tool_response.id` first and falls back to the regex for older harnesses; same fallback shape added for `CronDelete` (`.tool_response.cancelled`). `tool_response.durable` is `false` regardless of input — the harness is overriding `durable: true` upstream. Confirmed by reading the live payload via a temporary trace hook in the cache directory; trace removed after diagnosis.
  - **`reconcile-crons.sh` fast-path skipped recreation after every restart.** SessionStart hook checked whether all active registry entries had a `harnessTaskId` and, if so, skipped the entire reconcile envelope — assuming "bootstrapped" meant "alive in harness". Combined with upstream `durable: true` being broken, the stale `harnessTaskId` from the dead session was always present, so the envelope was never re-emitted, the agent never recreated the crons, and reminders never fired post-restart. Fast-path removed; the envelope is now emitted on every SessionStart so the agent's `CronList` check authoritatively decides what to recreate. When upstream `durable` lands, this can be re-enabled with a session-scoped staleness signal (e.g. comparing `lastSeenAlive` against session start, or stamping `sessionId` in writeback).
  - **`crons` skill didn't auto-load on natural-language reminder requests.** Description triggered only on `/agent:crons`, `recordatorios`, etc. — phrases like "recordame en X", "remind me in X", "todos los lunes a las Y" never loaded the skill, so the agent fell through to in-session `ScheduleWakeup` (dies on `/exit`) or a verbal-only commitment. Description expanded with the full natural-language trigger set in ES + EN (recordame, recuérdame, me recuerdas, hazme acordar, agendame, avísame, remind me, remind me in, schedule a reminder, every Monday/lunes at, todos los días a las, cada N minutos/horas, etc.).
- **Cron expressions are now computed by a deterministic helper, not the LLM.** New `bin/cron-from.sh` (BSD- and GNU-`date`-aware, single-shot JSON output) handles `relative`, `absolute`, `recurring daily`, `recurring weekly`, `recurring every N`. Skill `crons` ADD subflow rewritten to mandate calling the helper before every `CronCreate`; SOUL.md adds "time commitments are sacred" to the Boundaries block; `templates/CLAUDE.md` adds two CronCreate gotchas (never compute expressions yourself; never use `ScheduleWakeup` for user commitments); `skills/messaging/SKILL.md` cross-references the crons skill for any time-based commitment via messaging channels. The helper exists because LLMs miscompute timezones inconsistently — verified live: same agent in same session generated `52 12 19 4 *` for "12:52 local" (correct) and `33 17 19 4 *` for "13:33 local" (off by exactly the UTC offset). Daemon interprets cron in host LOCAL time (verified empirically); helper does epoch arithmetic and reformats in host TZ so cron + human-display always agree. Includes `tier1q-cron-from.sh` with 27 test cases covering relative units, absolute today/tomorrow, recurring daily/weekly/every, day-of-week named + numeric, error paths, and the exact "in 3 minutes" reproducer that originally surfaced the bug.
- **`hooks/cron-posttool.sh` now has its own test suite (`tier1p-cron-posttool.sh`, 15 tests).** Pre-fix the hook had no unit tests and the regex bug shipped silently. Suite covers both response shapes (modern object + legacy strings recurring/one-shot), captured-field correctness, audit log append, recursion-marker suppression with stale-marker fallback, idempotency, non-Cron-tool ignore, malformed payloads, `CronDelete` tombstoning (success and failure cases), empty-stdin defense, and the failure-mode contract (always exits 0).
- **Documentation (`docs/crons.md`)** — new "Time arithmetic — `bin/cron-from.sh`" section with the full intent → helper-call mapping table; user-commands section now leads with natural-language triggers and notes auto-loading on any future-time commitment via any channel.

## [1.4.4] — 2026-04-19

### Fixed

- **Plugin no longer fails to load on Claude Code ≥ 2.1.114 with "Duplicate hooks file detected".** `.claude-plugin/plugin.json` declared `"hooks": "./hooks/hooks.json"` since v1.0.0, but Claude Code auto-loads `hooks/hooks.json` from the standard plugin path — the explicit declaration was redundant. Recent Claude Code versions added a duplicate-detection guard that rejects the redundant declaration and skips loading every hook (SessionStart reconcile, PostToolUse cron capture, PreCompact memory flush, Stop summary prompt, SessionEnd dreams event). Removed the line; the hooks now load via auto-load, same file, same behavior. Zero impact on older Claude Code: auto-load has always been the documented default, and `manifest.hooks` is spec'd only for *additional* hook files beyond the standard path. New `dev-tests/tier1n-plugin-manifest.ts` regression guard asserts the field stays absent.

## [1.4.3] — 2026-04-18

### Thanks

- **[@JD2005L](https://github.com/JD2005L)** for the version-stamp service-side writer — another production find from his 24/7 ClawCode deployment. Paired with a new in-repo watchdog consumer (see below) to close the silent-stale-code failure mode end-to-end.

### Added

- **Version stamp at service start.** `generateSystemdUnit` and `generatePlist` now write the workspace's current `git HEAD` to a reboot-clean runtime file (`$XDG_RUNTIME_DIR/clawcode-<slug>.version` on Linux, `$TMPDIR/clawcode-<slug>.version` on macOS) before `claude` boots. The service itself never reads the file; it exists so external watchdogs can detect the "user pulled upstream but only ran `/mcp`" case, where plugins keep serving stale code while systemd still reports the unit as active. On Linux this is a best-effort `ExecStartPre=-/bin/bash -c '...'`; on macOS the whole `ProgramArguments` is wrapped in `/bin/sh -c 'git rev-parse HEAD > $TMPDIR/...; exec "$@"'` with the real argv passed as positionals, so a missing `git` or non-git workspace falls through to the normal exec path instead of crash-looping launchd. New exported `versionStampPathExpr(platform, slug)` helper gives consumers the canonical shell expression for the path. `generatePlist` gains a required `slug` option so the stamp filename can be emitted without re-parsing it out of the label. Reported by [@JD2005L](https://github.com/JD2005L) after hitting the silent-stale-code failure mode in production on 2026-04-17. [#22](https://github.com/crisandrews/ClawCode/pull/22).
- **Watchdog tier 6 — version drift detection.** `recipes/watchdog/watcher.sh` gains a sixth tier that reads the service-side stamp, diffs it against `git -C <workspace> rev-parse HEAD`, and returns `FAIL(drift:<old>→<new>)` when they diverge — pushing the existing `--on-fail` restart path to pick up the pulled code. Auto-opt-in: both `install-linux.sh` and `install-mac.sh` append `--tier=6` when the workspace has a `.git` directory, plus a new `--slug=<slug>` argument so the watcher can derive the stamp path per-platform. Non-git workspaces, missing stamps, and missing slugs all silently skip tier 6 — never error out — so the stamp-side's best-effort semantics carry through to the consumer. Without this consumer the stamp was forward-compat infrastructure with nothing in-repo reading it.
- **5 new smoke-test checks for the service-side stamp** (covering per-platform/per-slug path expressions, `ExecStartPre` ordering, the launchd `sh -c` wrapper shape, and `|| true` fallthrough on non-git workspaces) and **5 new end-to-end bash tests for watchdog tier 6** (matching SHA → pass, drift → FAIL, missing stamp → skip, non-git → skip, missing slug → skip). Full smoke-test count: 18 → 28.

### Fixed

- **`/agent:create` now continues the bootstrap ritual inline instead of stopping halfway.** The skill used to tell the user to run `/mcp` and then stop, expecting the agent to "detect BOOTSTRAP.md on next turn and start the ritual". In practice Claude Code doesn't respond without user input, so the user had to type something (e.g. `hola`) before the ritual actually began — three user interactions instead of one. The skill now drives the ritual inline in the same response where the Bash copy steps run. `/mcp` moved to the very end of the ritual, where there are actual memory/config writes for it to pick up.
- **Bootstrap ritual no longer batches every discovery question into a single message.** `templates/BOOTSTRAP.md` listed all discovery items (name, creature, vibe, emoji, human info) as a single bullet block and framed the ritual as "don't interrogate, just talk" — which the model consistently read as "dump every question at once and wait for the user to answer them all in one reply". `CLAUDE.md`'s "Interactive wizards" rule ("one question at a time, `AskUserQuestion` for enumerables") was getting outvoted by the conversational framing of BOOTSTRAP.md itself. Restructured into numbered, sequential steps with an explicit "rule zero: one question per turn" guard-rail at the top of the file. Enumerable choices (vibe, QMD on/off, messaging channel) now call out `AskUserQuestion` explicitly; free text stays for name/creature/emoji. The `agent-config.json` JSON templates moved to a reference section at the bottom so the inline ritual reads cleanly.

## [1.4.2] — 2026-04-17

### Added

- **Listed on Anthropic's `claude-plugins-community` marketplace.** Install via `/plugin marketplace add anthropics/claude-plugins-community` then `/plugin install clawcode@claude-community`. The plugin entry is registered in the official catalog under the name `clawcode` (the marketplace catalog label) — note this differs from the `agent@clawcode` identifier used when installing from this repo's own marketplace, but both install the same code from the same source. The community marketplace syncs nightly from Anthropic's review pipeline, so brand-new fixes can take up to ~24h to land there; install from `crisandrews/ClawCode` directly if you need the absolute latest commit. The two install paths can coexist on the same machine in different workspaces — they live under separate cache directories (`~/.claude/plugins/cache/claude-community/clawcode/<version>/` vs `~/.claude/plugins/cache/clawcode/agent/<version>/`) and Claude Code tracks them as separate `installed_plugins.json` entries.

### Documentation

- `README.md` — Quick Setup install commands now lead with the community marketplace path; the `crisandrews/ClawCode` path is kept as the bleeding-edge alternative for users who need same-day fixes. Update / uninstall / clear-cache sections refactored to cover both install origins explicitly. Troubleshooting row for the "Failed to reconnect" error now lists both possible cache paths. New badge in the header signaling the community listing.

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
