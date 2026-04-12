# ClawCode

> **Release 1.0** — Persistent agents for Claude Code with memory, dreaming, and heartbeats.

Claude Code is stateless by default. Every session starts from zero — no memory of who you are, what you talked about, or how the agent should behave. If you want a persistent AI agent that remembers, dreams, and has a personality, you need to build all of that yourself.

ClawCode is a plugin that turns Claude Code into a stateful agent. It gives Claude a persistent identity (name, personality, vibe), a searchable memory system with full-text search and temporal decay, nightly dreaming that consolidates important memories, and periodic heartbeats that keep the agent aware of what matters. Compatible with the [OpenClaw](https://github.com/openclaw/openclaw) agent format — import existing agents with one command.

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

This copies the template files and starts the bootstrap ritual — a casual conversation where the agent discovers its name, personality, and emoji. You can also import an existing OpenClaw agent instead:

```
/agent:import
```

**4. Reload to apply the personality:**

```
/mcp
```

The agent now wakes up with its identity on every session.

## Bootstrap ritual

When you create a new agent, a `BOOTSTRAP.md` acts as its birth certificate:

- Agent sees BOOTSTRAP.md and starts a casual conversation
- Together you discover the agent's name, personality, vibe, emoji
- Agent writes IDENTITY.md, USER.md, adjusts SOUL.md
- Offers to set up QMD for enhanced memory (if installed)
- Writes `agent-config.json` with memory settings
- Deletes BOOTSTRAP.md — the agent is born
- Runs `/mcp` to load its identity

One-time ritual. After that, the agent wakes up with its personality on every session.

## Skills

| Skill | Description |
| --- | --- |
| `/agent:create` | Create a new agent with bootstrap ritual |
| `/agent:import [id]` | Import an OpenClaw agent (personality + memory + crons) |
| `/agent:crons` | Import OpenClaw crons as local scheduled tasks |
| `/agent:heartbeat` | Run memory consolidation and periodic checks |
| `/agent:settings` | View/modify agent config (guided) |
| `/agent:doctor [--fix]` | Diagnose agent health (config, memory, crons, HTTP bridge, etc.). `--fix` applies safe auto-repairs |
| `/agent:skill install\|list\|remove` | Install community skills from GitHub, list installed, remove by name |
| `/agent:channels [list\|status\|launch]` | Show messaging channel status and the launch command |
| `/agent:service install\|status\|uninstall\|logs` | Run the agent as an always-on launchd/systemd service |
| `/agent:messaging` | Set up a messaging channel (WhatsApp, Telegram, Discord, iMessage, Slack) |
| `/agent:status` | Agent status dashboard (identity + memory + dream stats) |
| `/agent:usage` | Agent resource usage (memory size, files, dreams) |
| `/agent:new` | Save session summary to memory, then prepare for `/clear` |
| `/agent:compact` | Save important context to memory before context compression |
| `/whoami` | Show sender info and agent identity |
| `/help` | List all available commands |

## MCP tools

| Tool | Description |
| --- | --- |
| `memory_search` | Search memory with BM25 ranking, temporal decay, and MMR diversity |
| `memory_context` | Active-memory turn-start reflex — derives queries, dedupes, formats digest |
| `memory_get` | Read specific lines from a memory or bootstrap file |
| `dream` | Dreaming: `status`, `run`, or `dry-run` |
| `agent_config` | Get/set config programmatically (no JSON editing needed) |
| `agent_status` | Agent identity, memory stats, dream tracking |
| `agent_doctor` | Diagnose + optionally auto-repair agent health (`action: check \| fix`) |
| `skill_install` | Install a skill from GitHub or local path, with scope and requirements gating |
| `skill_list` | List installed skills across plugin / project / user scopes |
| `skill_remove` | Remove a skill (requires `confirm: true`) |
| `channels_detect` | Report installed/authenticated/active messaging channels and build a launch command |
| `service_plan` | Plan always-on service install/uninstall/status/logs (returns file content + commands; executed by skill) |
| `chat_inbox_read` | Read pending WebChat messages (only when HTTP bridge is on) |
| `webchat_reply` | Send a reply to the open WebChat browser (only when HTTP bridge is on) |

### Configuring via tool

```
agent_config(action='get')                                    # View all settings
agent_config(action='set', key='memory.backend', value='qmd') # Enable QMD
agent_config(action='set', key='heartbeat.activeHours.start', value='09:00')
agent_config(action='set', key='memory.builtin.halfLifeDays', value='60')
```

After changes: `/mcp` to apply.

### When changes take effect

| What you changed | Auto-refresh? | What to do |
| --- | --- | --- |
| `agent-config.json` | No | Run `/mcp` to reload |
| Personality files (SOUL, IDENTITY, USER) | No | Run `/mcp` to reload |
| Memory files (`memory/*.md`) | Yes | Next `memory_search` re-indexes automatically |
| Crons (via CronCreate) | Yes | Takes effect immediately (in-session) |
| HTTP bridge on/off | No | Run `/mcp` to start/stop |
| New skills in `./skills/` | Partial | Agent reads them when triggered, but update AGENTS.md for discovery |

**Rule of thumb:** if it's in `agent-config.json` or a personality file, run `/mcp` after changing it. Memory and crons are live.

## Personality files

Every agent has these files in its root. Templates live in `templates/` and are copied on `/agent:create`.

| File | Purpose |
| --- | --- |
| `SOUL.md` | Core truths and boundaries — the agent's philosophy |
| `IDENTITY.md` | Name, emoji, vibe, birth date |
| `USER.md` | Your info, timezone, language, preferences |
| `AGENTS.md` | Operational protocols and behavioral rules |
| `TOOLS.md` | Platform-specific formatting notes (WhatsApp, Discord, etc.) |
| `HEARTBEAT.md` | Instructions for periodic checks |
| `BOOTSTRAP.md` | First-run ritual (deleted after onboarding) |

These files are injected as system instructions via MCP — every conversation gets the agent's personality automatically.

## Directory structure

```
~/my-agent/
├── SOUL.md               # Personality and core truths
├── IDENTITY.md           # Name, emoji, vibe
├── USER.md               # Your info and preferences
├── AGENTS.md             # Operational protocols
├── TOOLS.md              # Tool-specific notes
├── HEARTBEAT.md          # Periodic check config
├── DREAMS.md             # Dream diary (auto-generated)
├── agent-config.json     # Settings (memory, heartbeat, dreaming)
├── memory/
│   ├── MEMORY.md         # Long-term curated memory
│   ├── YYYY-MM-DD.md     # Daily logs (append-only)
│   ├── .memory.sqlite    # Search index (auto-generated)
│   └── .dreams/          # Dream tracking data
├── hooks/                # Lifecycle hooks
├── skills/               # Agent skills
├── lib/                  # Memory engine
├── server.ts             # MCP server
└── package.json          # Dependencies
```

## Memory system

### Builtin (default)

- **SQLite + FTS5** — full-text search with BM25 ranking
- **Temporal decay** — dated files lose relevance over time (30-day half-life)
- **MMR** — diversity re-ranking to avoid redundant results
- **Chunking** — 400 tokens with 80 token overlap
- **Keyword extraction** — English + Spanish stop word filtering
- Works out of the box, no extra tools needed

### QMD (optional)

- **Local embeddings** via node-llama-cpp — no API keys needed
- **Semantic search** — finds related concepts, not just exact keywords
- **Three search modes:**
  - `search` — fast basic hybrid (vector + BM25)
  - `vsearch` — vector search with reranking (recommended)
  - `query` — full query expansion + rerank (slow, best quality)
- Install: `bun install -g qmd`
- Enable: `agent_config(action='set', key='memory.backend', value='qmd')`
- Falls back to builtin automatically if QMD fails

### Memory lifecycle

- **Daily logs** — Agent writes to `memory/YYYY-MM-DD.md` during sessions (append-only)
- **Pre-compaction flush** — `PreCompact` hook saves info before context compression
- **Session summary** — `Stop` hook reminds agent to write summary before closing
- **Heartbeat** — Every 30 min, reviews daily files and consolidates into MEMORY.md
- **Dream tracking** — Every `memory_search` is recorded with concept tags and scores

## Dreaming

Nightly cron (3 AM) runs 3-phase memory consolidation:

**Light phase:**
- Ingests recent recall signals
- Deduplicates candidates
- Records reinforcement signals

**REM phase:**
- Extracts recurring themes from concept tags
- Identifies multi-day patterns
- Writes reflections to DREAMS.md

**Deep phase — ranks candidates with 6 weighted signals:**

| Signal | Weight | Measures |
| --- | --- | --- |
| Relevance | 0.30 | Average retrieval quality |
| Frequency | 0.24 | Times recalled |
| Query diversity | 0.15 | Distinct days searched |
| Recency | 0.15 | Freshness (7-day half-life) |
| Consolidation | 0.10 | Multi-day recurrence |
| Conceptual richness | 0.06 | Concept-tag density |

- Applies threshold gates (minScore, minRecallCount, minUniqueQueries)
- Rehydrates snippets from live files (skips stale/deleted entries)
- Checks for duplicates in MEMORY.md
- Promotes winners to `memory/MEMORY.md`
- Writes diary to `DREAMS.md`

Run manually: `dream(action='run')` or preview with `dream(action='dry-run')`.

## Hooks

| Hook | When | What |
| --- | --- | --- |
| `SessionStart` | Session begins | Shows identity, creates heartbeat + dreaming crons if missing |
| `PreCompact` | Before context compression | Reminds agent to save info to daily log |
| `Stop` | Agent about to stop | Reminds agent to write session summary |
| `SessionEnd` | Session closes | Logs event to dream tracking |

## Configuration

All settings in `agent-config.json` — edit directly or use the `agent_config` tool.

### Memory backend

```json
{ "memory": { "backend": "builtin" } }
{ "memory": { "backend": "qmd", "qmd": { "searchMode": "vsearch" } } }
```

### Heartbeat active hours

```json
{
  "heartbeat": {
    "schedule": "*/30 * * * *",
    "activeHours": { "start": "08:00", "end": "23:00", "timezone": "America/Santiago" }
  }
}
```

### Dreaming schedule

```json
{ "dreaming": { "schedule": "0 3 * * *", "timezone": "America/Santiago" } }
```

### Builtin search tuning

```json
{
  "memory": {
    "builtin": { "temporalDecay": true, "halfLifeDays": 30, "mmr": true, "mmrLambda": 0.7 }
  }
}
```

## Going further

### Importing from OpenClaw

**Agents** (`/agent:import`):
- Lists agents from `~/.openclaw/workspace*/`
- Copies bootstrap files (SOUL.md, IDENTITY.md, USER.md, etc.)
- Optionally imports memory (MEMORY.md + recent daily files)
- Adapts AGENTS.md for Claude Code (removes OpenClaw-specific tool references)
- Interactive skill import with 3-tier classification:
  - **GREEN** — importable as-is
  - **YELLOW** — needs adaptation (comments added for manual review)
  - **RED** — depends on OpenClaw infrastructure (skipped, documented in IMPORT_BACKLOG.md)
- Skipped items are saved to `IMPORT_BACKLOG.md` with per-item recovery notes
- Import event is logged to memory so the agent remembers what was skipped
- Credentials are never copied

**Crons** (`/agent:crons`):
- Reads `~/.openclaw/cron/jobs.json`
- Converts to Claude Code local scheduled tasks (CronCreate)
- Same 3-tier classification for each cron
- Cron expressions kept as-is (local timezone)
- Prompts adapted for Claude Code tools
- Delivery channels mapped to MCP tool instructions
- `durable: true` — persist across restarts (7-day expiration)
- Only run while Claude Code is open

### Messaging channels

Reach your agent from WhatsApp, Telegram, Discord, iMessage, or Slack. Run `/agent:messaging` to get guided setup, or install manually.

| Platform | Marketplace | Install |
| --- | --- | --- |
| **WhatsApp** | `crisandrews/claude-whatsapp` | `/plugin install whatsapp@claude-whatsapp` |
| Telegram | `anthropics/claude-plugins-official` | `/plugin install telegram@claude-plugins-official` |
| Discord | `anthropics/claude-plugins-official` | `/plugin install discord@claude-plugins-official` |
| iMessage (macOS) | `anthropics/claude-plugins-official` | `/plugin install imessage@claude-plugins-official` |
| Slack | `anthropics/claude-plugins-official` | `/plugin install slack@claude-plugins-official` |

Each messaging plugin is an independent MCP server. ClawCode and any messaging plugin inject their instructions separately — no conflicts. When a message arrives:

1. Claude Code processes the turn with **both** sets of instructions active
2. The agent responds with **your personality** (from SOUL.md + IDENTITY.md)
3. The agent uses the messaging plugin's `reply` tool with the **correct formatting** for that platform
4. Anything worth remembering is saved to `memory/YYYY-MM-DD.md` — memory works identically across channels

**Quick start (WhatsApp):**

```
/plugin marketplace add crisandrews/claude-whatsapp
/plugin install whatsapp@claude-whatsapp
/exit
```

Relaunch with channels enabled:

```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp
```

Then scan the QR code:

```
/whatsapp:configure
```

Now message your WhatsApp number from another phone — your agent responds with its personality.

### WebChat (browser UI)

Talk to your agent from a browser. Enable the HTTP bridge:

```
agent_config(action='set', key='http.enabled', value='true')
/mcp
```

Then open `http://localhost:18790` — a clean chat UI with real-time SSE delivery, message history, and your agent's personality.

Features:
- Dark/light mode (follows system preference)
- Enter to send, Shift+Enter for newline
- Typing indicator while the agent thinks
- History persists across page reloads
- Status dot shows connection state (green = live)

For remote access, set a token: `agent_config(action='set', key='http.token', value='your-secret')` then open `http://host:18790?token=your-secret`.

### HTTP Bridge (API)

When `http.enabled: true`, a local HTTP server runs alongside the MCP server:

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | GET | Always public — `{status: "ok"}` |
| `/v1/status` | GET | Agent identity, memory stats, config |
| `/v1/skills` | GET | List installed skills |
| `/v1/webhook` | POST | Ingest external events (queue up to 1000) |
| `/v1/webhooks` | GET | Drain the webhook queue |
| `/v1/chat/send` | POST | Send a message to the agent |
| `/v1/chat/history` | GET | Chat message history |
| `/v1/chat/stream` | GET | SSE stream for real-time replies |

Default: off, port 18790, localhost only. Configure via `agent-config.json`:

```json
{ "http": { "enabled": true, "port": 18790, "host": "127.0.0.1", "token": "" } }
```

### Multiple agents

Each agent = its own folder. Switch: `cd ~/other-agent && claude`.

### Always-on (run as a background service)

Use the `service` skill — it generates the platform-specific service file (launchd on macOS, systemd on Linux), asks you to confirm the `--dangerously-skip-permissions` trade-off, and loads it:

```
/agent:service install
/agent:service status
/agent:service logs
/agent:service uninstall
```

Full details and safety notes in `docs/service.md`. If you'd rather set it up by hand, the manual templates below still work:

**macOS (launchd):**

Create `~/Library/LaunchAgents/com.clawcode-agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clawcode-agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>claude</string>
        <string>--dangerously-skip-permissions</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USER/my-agent</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/clawcode-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/clawcode-agent.err</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.clawcode-agent.plist
```

**Linux (systemd):**

Create `~/.config/systemd/user/clawcode-agent.service`:

```ini
[Unit]
Description=ClawCode Agent (Claude Code)

[Service]
WorkingDirectory=/home/YOUR_USER/my-agent
ExecStart=claude --dangerously-skip-permissions
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now clawcode-agent
```

## Differences from OpenClaw

| Feature | OpenClaw | ClawCode |
| --- | --- | --- |
| Runtime | 24/7 gateway daemon | Per-session (Claude Code) |
| Multi-channel | Native | Via MCP plugins |
| Sub-agents | Persistent identity | Ephemeral |
| Heartbeats | Built-in 30min | Local cron 30min (auto-created) |
| Crons | Sub-second intervals | Local crons (durable, 7-day expiration) |
| Memory search | SQLite + FTS5 + embeddings | SQLite + FTS5 (+ QMD optional) |
| Dreaming | 3-phase | 3-phase |
| QMD | Built-in option | Optional via `agent_config` |
| Bootstrap | Conversational | Conversational |
| Config | `openclaw.json` | `agent-config.json` + `agent_config` tool |
| Voice/TTS | Built-in | Not included |

## Troubleshooting

- **Agent has no personality after setup** — Run `/mcp` to reload the MCP server. The personality is injected via system instructions on each session start.
- **Memory search returns nothing** — The SQLite index builds automatically on first search. If using QMD, check that `qmd` is installed and the backend is set: `agent_config(action='set', key='memory.backend', value='qmd')`.
- **Dreaming never runs** — Crons only run while Claude Code is open. Check with `dream(action='status')`. For manual consolidation: `dream(action='run')`.
- **Heartbeat runs outside active hours** — Set active hours: `agent_config(action='set', key='heartbeat.activeHours.start', value='08:00')`.
- **Import from OpenClaw fails** — Make sure `~/.openclaw/` exists and contains workspace directories. Run `/agent:import` for an interactive walkthrough.
- **BOOTSTRAP.md won't delete** — The agent deletes it at the end of the bootstrap ritual. If it persists, the ritual didn't complete — run through it again or delete manually.

## License

MIT

## Disclaimer

ClawCode is an independent, open-source project. Claude is a trademark of Anthropic, PBC. ClawCode is not affiliated with or endorsed by Anthropic.
