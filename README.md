# ClawCode

> **Release 1.0** — Persistent agents for Claude Code with memory, dreaming, and personality.

Claude Code is stateless by default. Every session starts from zero — no memory of who you are, what you talked about, or how the agent should behave.

ClawCode turns Claude Code into a stateful autonomous agent. It gives Claude a persistent identity, searchable memory with bilingual recall, nightly dreaming that consolidates important memories, and a terse conversational style. The agent remembers your dog's name, warns you about allergies before suggesting food, and responds in 1–2 lines instead of paragraphs.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+

## Quick Setup

**1. Create a folder for your agent.**

Each agent lives in its own folder. Create one and open Claude Code there:

```sh
mkdir ~/my-agent && cd ~/my-agent
claude
```

**2. Install the plugin.**

Inside Claude Code, add the marketplace:

```
/plugin marketplace add crisandrews/ClawCode
```

Then install the plugin:

```
/plugin install agent@clawcode
```

When prompted for scope, select **"Install for you, in this repo only (local scope)"** — this keeps the agent isolated to this folder.

**3. Create your agent:**

```
/agent:create
```

This starts the bootstrap ritual — a casual conversation where the agent discovers its name, personality, and emoji. You can also import an existing agent instead:

```
/agent:import
```

**4. Reload to apply the personality:**

```
/mcp
```

The agent now wakes up with its identity on every session.

## Skills

| Skill | Description |
| --- | --- |
| `/agent:create` | Create a new agent with bootstrap ritual |
| `/agent:import [id]` | Import an existing agent (personality + memory + skills + crons) |
| `/agent:doctor [--fix]` | Diagnose agent health. `--fix` applies safe auto-repairs |
| `/agent:settings` | View/modify agent config (guided) |
| `/agent:skill install\|list\|remove` | Install community skills from GitHub, list installed, remove by name |
| `/agent:channels` | Show messaging channel status and launch command |
| `/agent:service install\|status\|uninstall\|logs` | Run the agent as an always-on background service |
| `/agent:voice status\|setup` | Set up and test TTS / STT backends |
| `/agent:messaging` | Set up WhatsApp, Telegram, Discord, iMessage, or Slack |
| `/agent:crons` | Import crons as local scheduled tasks |
| `/agent:heartbeat` | Run memory consolidation and periodic checks |
| `/agent:status` | Agent status dashboard |
| `/agent:usage` | Resource usage (memory, files, dreams) |
| `/agent:new` | Save session and prepare for `/clear` |
| `/agent:compact` | Save context before compression |
| `/whoami` | Sender info and agent identity |
| `/help` | List all available commands |

## MCP tools

| Tool | Description |
| --- | --- |
| `memory_search` | Full-text search with BM25, temporal decay, and MMR diversity |
| `memory_context` | Active-memory turn-start reflex — bilingual, date-aware, auto-recall |
| `memory_get` | Read specific lines from a memory file |
| `dream` | Dreaming: `status`, `run`, or `dry-run` |
| `agent_config` | Get/set config programmatically |
| `agent_status` | Identity, memory stats, dream tracking |
| `agent_doctor` | Diagnose + auto-repair agent health |
| `skill_install` / `skill_list` / `skill_remove` | Manage skills from GitHub or local paths |
| `channels_detect` | Report messaging channel status and build launch command |
| `list_commands` | Dynamic `/help` — scans installed skills across all scopes |
| `voice_speak` / `voice_transcribe` / `voice_status` | TTS and STT across multiple backends |
| `service_plan` | Generate launchd/systemd service files |
| `chat_inbox_read` / `webchat_reply` | WebChat messages (HTTP bridge) |

## Features

### Memory

The agent writes to `memory/YYYY-MM-DD.md` during sessions and searches it automatically at the start of every turn — no need to say "search memory." Bilingual (Spanish ↔ English), date-aware ("what did we discuss yesterday?"), and safety-critical (warns about allergies before suggesting food).

Two backends: **builtin** (SQLite + FTS5, works out of the box) and **QMD** (local embeddings for semantic search — install with `bun install -g qmd`).

Full details: [`docs/memory.md`](docs/memory.md) · [`docs/memory-context.md`](docs/memory-context.md) · [`docs/qmd.md`](docs/qmd.md)

### Dreaming

Nightly cron (3 AM) runs 3-phase memory consolidation — Light, REM, Deep — using 6 weighted signals to promote important memories to `memory/MEMORY.md`. Run manually with `dream(action='run')`.

Full details: [`docs/dreaming.md`](docs/dreaming.md)

### Voice

TTS via sag, ElevenLabs, OpenAI, or macOS `say`. STT via local Whisper or OpenAI Whisper API. The agent auto-selects the best available backend.

Full details: [`docs/voice.md`](docs/voice.md)

### WebChat

Browser-based chat UI with real-time SSE delivery. Enable the HTTP bridge, open `http://localhost:18790`. Dark/light mode, conversation logging in JSONL + Markdown (same format as WhatsApp plugin).

Full details: [`docs/webchat.md`](docs/webchat.md) · [`docs/http-bridge.md`](docs/http-bridge.md)

### Messaging channels

Reach your agent from WhatsApp, Telegram, Discord, iMessage, or Slack. Each messaging plugin is an independent MCP server — no conflicts with ClawCode.

```
/agent:messaging
```

Full details: [`docs/channels.md`](docs/channels.md)

### Community skills

Install skills from GitHub:

```
/agent:skill install alice/pomodoro
/agent:skill install alice/skills@main#weather
/agent:skill list
/agent:skill remove pomodoro
```

Full details: [`docs/skill-manager.md`](docs/skill-manager.md)

### Always-on service

Run the agent as a background service (launchd on macOS, systemd on Linux):

```
/agent:service install
/agent:service status
/agent:service logs
```

Full details: [`docs/service.md`](docs/service.md)

### Configuration

All settings in `agent-config.json`. Edit directly or use `agent_config`:

```
agent_config(action='get')
agent_config(action='set', key='memory.backend', value='qmd')
```

Non-critical settings (halfLifeDays, mmrLambda) apply live. Critical settings (memory.backend, http.enabled) need `/mcp`.

Full details: [`docs/config-reload.md`](docs/config-reload.md)

## Personality files

| File | Purpose |
| --- | --- |
| `SOUL.md` | Core truths and boundaries |
| `IDENTITY.md` | Name, emoji, vibe, birth date |
| `USER.md` | Your info, timezone, language |
| `AGENTS.md` | Operational protocols and behavioral rules |
| `TOOLS.md` | Platform-specific formatting |
| `HEARTBEAT.md` | Periodic check instructions |
| `BOOTSTRAP.md` | First-run ritual (deleted after onboarding) |

## Session & data

```
~/my-agent/
├── SOUL.md, IDENTITY.md, USER.md     # Agent personality
├── AGENTS.md, TOOLS.md, HEARTBEAT.md # Behavioral rules
├── agent-config.json                 # Settings
├── memory/
│   ├── MEMORY.md                     # Long-term curated memory
│   ├── YYYY-MM-DD.md                 # Daily logs (append-only)
│   ├── .memory.sqlite                # Search index (auto-generated)
│   └── .dreams/                      # Dream tracking data
├── .webchat/logs/conversations/      # WebChat logs (JSONL + MD)
├── skills/                           # Installed + imported skills
└── IMPORT_BACKLOG.md                 # Items that couldn't be imported (if any)
```

**Conversation logs** are stored in two formats per channel:
- **JSONL** — one JSON object per line, ideal for programmatic access and memory indexing
- **Markdown** — human-readable chat transcript

## Troubleshooting

Run `/agent:doctor` first — it checks everything in one shot. Add `--fix` to auto-repair safe issues.

- **Agent has no personality** — Run `/mcp` to reload.
- **Memory search returns nothing** — Index builds on first search. For QMD: `agent_config(action='set', key='memory.backend', value='qmd')`.
- **Agent doesn't remember things** — The active memory reflex uses bilingual synonyms but not everything. Try different keywords.
- **Config change didn't take effect** — Non-critical settings apply live. Critical ones need `/mcp`. The agent tells you which.
- **Messaging channels** — Run `/agent:channels status` for installed/authenticated/active status with the exact launch command.

## Important

- **Multiple agents** — each agent is its own folder. Switch: `cd ~/other-agent && claude`.
- **Crons only run while Claude Code is open** — for 24/7, use `/agent:service install`.
- **WebChat logs + WhatsApp logs** are indexable via `memory.extraPaths` in config.

## Further reading

Per-feature documentation in [`docs/`](docs/INDEX.md). Each feature has config reference, behavior details, and troubleshooting.

## License

MIT

## Disclaimer

ClawCode is an independent, open-source project. Claude is a trademark of Anthropic, PBC. ClawCode is not affiliated with or endorsed by Anthropic.
