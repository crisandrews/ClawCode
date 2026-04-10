# ClawCode

OpenClaw-compatible agent system for Claude Code. Give Claude Code a persistent personality, memory, dreaming, and agent behavior — using the same format as [OpenClaw](https://github.com/openclaw/openclaw).

## What it does

- **Personality** — SOUL.md, IDENTITY.md, USER.md define who the agent is
- **Protocols** — AGENTS.md, TOOLS.md, HEARTBEAT.md define how it operates
- **Memory** — SQLite + FTS5 search with BM25, temporal decay, MMR diversity
- **QMD** (optional) — Local embeddings + vector search + reranking, no API keys
- **Dreaming** — Nightly 3-phase consolidation promotes recalled memories to MEMORY.md
- **Heartbeats** — Periodic memory review every 30 minutes
- **Bootstrap** — Conversational onboarding where the agent discovers its identity
- **Import** — Bring existing OpenClaw agents, memory, and crons over
- **Hooks** — Pre-compaction flush, session summary, dream tracking
- **Plugin coexistence** — Works alongside WhatsApp, Telegram, etc.

## How it works

- MCP server reads bootstrap files and injects them as `instructions` into Claude Code
- Every conversation gets the agent's personality automatically
- Multiple plugins coexist — each MCP server's instructions are injected independently
- ClawCode (personality) + WhatsApp plugin (messaging) work together seamlessly

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- Optional: [QMD](https://github.com/tobi/qmd) for enhanced semantic search

## Quick Setup

**1. Create a folder for your agent** (each agent lives in its own folder):
```sh
mkdir ~/my-agent && cd ~/my-agent
claude
```

**2. Install the plugin:**
```
/plugin marketplace add crisandrews/ClawCode
/plugin install agent@clawcode
```

**3. Create your agent** (starts bootstrap ritual) or **import from OpenClaw:**
```
/agent:create
/agent:import
```

**4. Reload** to apply the personality:
```
/mcp
```

## Bootstrap Ritual

When you create a new agent, a `BOOTSTRAP.md` acts as its "birth certificate":

- Agent sees BOOTSTRAP.md and starts a casual conversation
- Together you discover the agent's name, personality, vibe, emoji
- Agent writes IDENTITY.md, USER.md, adjusts SOUL.md
- Offers to set up QMD for enhanced memory (if installed)
- Writes `agent-config.json` with memory settings
- Deletes BOOTSTRAP.md — the agent is born
- Runs `/mcp` to load its identity

One-time ritual. After that, the agent wakes up with its personality on every session.

## Directory Structure

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
├── templates/            # Templates for new agents
├── lib/                  # Memory engine
├── hooks/                # Lifecycle hooks
├── skills/               # Agent skills
├── server.ts             # MCP server
└── package.json          # Dependencies
```

## Skills

| Skill | Description |
|---|---|
| `/agent:create <name>` | Create a new agent with bootstrap ritual |
| `/agent:import [id]` | Import an OpenClaw agent (personality + memory) |
| `/agent:crons` | Import OpenClaw crons as local scheduled tasks |
| `/agent:heartbeat` | Run memory consolidation and periodic checks |
| `/agent:settings` | View/modify agent config (guided) |
| `/agent:messaging` | Set up a messaging channel (WhatsApp, Telegram, Discord, iMessage, Slack) |
| `/agent:status` | Agent status dashboard (identity + memory + dream stats) |
| `/agent:usage` | Agent resource usage (memory size, files, dreams) |
| `/agent:new` | Save session summary to memory, then prepare for `/clear` |
| `/agent:compact` | Save important context to memory, then prepare for `/compact` |

## MCP Tools

| Tool | Description |
|---|---|
| `memory_search` | Search memory — returns snippets with citations |
| `memory_get` | Read specific lines from a memory file |
| `dream` | Dreaming: `status`, `run`, or `dry-run` |
| `agent_config` | Get/set config programmatically (no JSON editing needed) |
| `agent_status` | Agent identity, memory stats, dream tracking |

### Configuring via tool (no JSON editing)

```
agent_config(action='get')                                    # View all settings
agent_config(action='set', key='memory.backend', value='qmd') # Enable QMD
agent_config(action='set', key='heartbeat.activeHours.start', value='09:00')
agent_config(action='set', key='memory.builtin.halfLifeDays', value='60')
```

After changes: `/mcp` to apply.

## Memory System

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

### Dreaming

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
|---|---|---|
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

## Hooks

| Hook | When | What |
|---|---|---|
| `SessionStart` | Session begins | Shows identity, creates heartbeat + dreaming crons if missing |
| `PreCompact` | Before context compression | Reminds agent to save info to daily log |
| `Stop` | Agent about to stop | Reminds agent to write session summary |
| `SessionEnd` | Session closes | Logs event to dream tracking |

## Importing from OpenClaw

### Agents (`/agent:import`)
- Lists agents from `~/.openclaw/workspace*/`
- Copies bootstrap files (SOUL.md, IDENTITY.md, USER.md, etc.)
- Optionally imports memory (MEMORY.md + recent daily files)
- Adapts AGENTS.md for Claude Code (removes OpenClaw-specific tool references)
- Credentials are never copied

### Crons (`/agent:crons`)
- Reads `~/.openclaw/cron/jobs.json`
- Converts to Claude Code local scheduled tasks (CronCreate)
- Cron expressions kept as-is (local timezone)
- Prompts adapted for Claude Code tools
- Delivery channels mapped to MCP tool instructions
- `durable: true` — persist across restarts (7-day expiration)
- Only run while Claude Code is open

## Multiple agents

Each agent = its own folder. Switch: `cd ~/other-agent && claude`.

## Messaging plugins

Reach your agent from WhatsApp, Telegram, Discord, iMessage, or Slack. Run `/agent:messaging` to get guided setup, or install manually.

### Supported plugins

| Platform | Marketplace | Install |
|---|---|---|
| **WhatsApp** ⭐ | [`crisandrews/claude-whatsapp`](https://github.com/crisandrews/claude-whatsapp) | `/plugin install whatsapp@claude-whatsapp` |
| Telegram | `anthropics/claude-plugins-official` | `/plugin install telegram@claude-plugins-official` |
| Discord | `anthropics/claude-plugins-official` | `/plugin install discord@claude-plugins-official` |
| iMessage (macOS) | `anthropics/claude-plugins-official` | `/plugin install imessage@claude-plugins-official` |
| Slack | `anthropics/claude-plugins-official` | `/plugin install slack@claude-plugins-official` |

### How coexistence works

Each messaging plugin is an independent MCP server. ClawCode and any messaging plugin inject their instructions separately — no conflicts, no fighting for control. When a message arrives via a messaging plugin:

1. Claude Code processes the turn with **both** sets of instructions active
2. The agent responds with **your personality** (from SOUL.md + IDENTITY.md)
3. The agent uses the messaging plugin's `reply` tool with the **correct formatting** for that platform
4. Anything worth remembering is saved to `memory/YYYY-MM-DD.md` — memory works identically across channels

### Quick start (WhatsApp)

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

## Differences from OpenClaw

| Feature | OpenClaw | ClawCode |
|---|---|---|
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

## License

MIT

## Disclaimer

ClawCode is not affiliated with, endorsed by, or associated with OpenClaw, Anthropic, or any of their affiliates. OpenClaw is a trademark of its respective owners. Claude is a trademark of Anthropic, PBC. ClawCode is an independent, open-source project that provides compatibility with OpenClaw's agent file format.
