# Changelog

## [1.2.2] — 2026-04-13

### Thanks
- @JD2005L for reporting [#1](https://github.com/crisandrews/ClawCode/issues/1) — the investigation into your report surfaced a bug that affected every user silently. Fix below.

### Fixed (GitHub issue #1)
- **Reminders now persist across session closes.** Previously the SessionStart hook relied on a `.crons-created` marker that persisted on disk while the crons themselves died with the session, so heartbeat / dreaming / imported / ad-hoc crons silently disappeared after every restart. The new system keeps a registry at `memory/crons.json` and reconciles it against the live harness on every SessionStart — anything missing is recreated, anything live-but-unknown is adopted.
- **Ad-hoc reminders ("recordame en 4 horas X") survive restarts.** A PostToolUse hook captures every `CronCreate` call and writes it to the registry; next session, reconcile recreates it.
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
