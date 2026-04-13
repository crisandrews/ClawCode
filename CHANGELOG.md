# Changelog

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
