# ClawCode

OpenClaw-compatible agent system for Claude Code. Give Claude Code a persistent personality, memory, dreaming, and agent behavior — using the same format as [OpenClaw](https://github.com/openclaw/openclaw).

## What it does

This plugin turns Claude Code into a personal agent with:

- **Personality** (SOUL.md) — Core truths, boundaries, and vibe
- **Identity** (IDENTITY.md) — Name, emoji, communication style
- **User context** (USER.md) — Info about you, your preferences, behavioral rules
- **Operational protocols** (AGENTS.md) — Session protocol, memory rules, safety
- **Memory system** — `memory_search` + `memory_get` tools with dream tracking
- **Memory lifecycle** — Pre-compaction flush, session summaries, heartbeat consolidation
- **Import from OpenClaw** — Bring your existing agents over

## How it works

The plugin runs an MCP server that reads your agent's bootstrap files (SOUL.md, IDENTITY.md, etc.) and injects them as `instructions` into Claude Code's context. Every conversation gets your agent's personality automatically.

Works alongside other plugins (like WhatsApp) — each plugin's instructions coexist independently.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+

## Quick Setup

**1. Create a folder for your agent.**

Each agent lives in its own folder:

```sh
mkdir ~/my-agent && cd ~/my-agent
claude
```

**2. Install the plugin.**

```
/plugin marketplace add crisandrews/ClawCode
/plugin install agent@clawcode
```

**3. Create your agent or import from OpenClaw.**

Create from scratch:
```
/agent:create
```

Or import an existing OpenClaw agent:
```
/agent:import
```

**4. Reload the agent** to load the personality:
```
/mcp reconnect clawcode
```

## Agent Directory Structure

Each agent is a self-contained folder:

```
~/my-agent/
├── SOUL.md              # Personality and core truths
├── IDENTITY.md          # Name, emoji, vibe
├── USER.md              # Human's info and preferences
├── AGENTS.md            # Operational protocols
├── TOOLS.md             # Tool-specific notes
├── HEARTBEAT.md         # Periodic check configuration
├── memory/
│   ├── MEMORY.md        # Long-term curated memory
│   ├── YYYY-MM-DD.md    # Daily logs (append-only)
│   └── .dreams/
│       ├── events.jsonl          # Memory recall log
│       └── short-term-recall.json # Recall scoring index
├── templates/           # Templates for new agents
├── .claude-plugin/      # Plugin config
├── .mcp.json            # MCP server config
├── server.ts            # MCP server
└── package.json         # Dependencies
```

## Skills

| Skill | Description |
|---|---|
| `/agent:create <name>` | Create a new agent in a new directory |
| `/agent:import [id]` | Import an OpenClaw agent into current directory |
| `/agent:crons` | Import OpenClaw crons as local scheduled tasks |
| `/agent:heartbeat` | Run memory consolidation and periodic checks |

## MCP Tools

| Tool | Description |
|---|---|
| `memory_search` | Search memory files (FTS5+BM25 or QMD) — returns snippets with citations |
| `memory_get` | Read specific lines from a memory file |
| `dream` | Run dreaming: `status`, `run` (full sweep), `dry-run` (preview) |
| `agent_status` | Show agent identity, memory stats, and dream tracking |

## Memory System

Two backends available:

### Builtin (default — no setup needed)
- **SQLite + FTS5** with BM25 ranking
- **Temporal decay** — dated files (memory/YYYY-MM-DD.md) lose relevance over time (half-life 30 days)
- **MMR** — diversity re-ranking to avoid redundant results
- **Markdown chunking** — 400 tokens with 80 token overlap
- Works out of the box, no external tools needed

### QMD (optional — enhanced search)
- **Local embeddings** via node-llama-cpp (no API keys needed)
- **Vector search** with semantic understanding (finds related concepts, not just keywords)
- **Reranking** for better result quality
- Requires [QMD](https://github.com/tobi/qmd) binary installed
- Enable via `/agent:settings` or during bootstrap

To install QMD:
```bash
bun install -g qmd
```

Then enable:
```
/agent:settings
```

### Memory lifecycle

**Daily logs** — Agent writes to `memory/YYYY-MM-DD.md` during sessions (append-only).

**Pre-compaction flush** — `PreCompact` hook saves important info before context compression.

**Session summary** — `Stop` hook reminds the agent to write a conversation summary before closing.

**Heartbeat consolidation** — Every 30 min, reviews daily files and consolidates into `MEMORY.md`.

**Dream tracking** — Every `memory_search` is recorded in `memory/.dreams/`. Frequently recalled memories are tracked with concept tags and scores.

**Dreaming** — Nightly 3-phase consolidation:
1. **Light** — ingest signals, record reinforcements
2. **REM** — extract themes and patterns, write reflections
3. **Deep** — rank with 6 weighted signals (frequency, relevance, query diversity, recency, consolidation, conceptual richness), promote winners to `MEMORY.md`, write diary to `DREAMS.md`

## How instructions are injected

The MCP server reads bootstrap files at startup and sets them as `instructions` in the MCP `InitializeResult`. Claude Code injects all MCP server instructions as a `<system-reminder>` on every turn.

This means:
- Your agent's personality applies to ALL interactions (terminal, WhatsApp, etc.)
- Multiple plugins coexist — WhatsApp formatting + agent personality work together
- Instructions are loaded at startup; to reload after changes: `/mcp reconnect clawcode`

## Multiple agents

Each agent is its own folder. To switch: `cd ~/other-agent && claude`.

## Differences from OpenClaw

| Feature | OpenClaw | ClawCode |
|---|---|---|
| Persistent daemon | 24/7 gateway server | Per-session (Claude Code) |
| Multi-channel | Native WhatsApp/Telegram/etc. | Via separate MCP plugins |
| Sub-agents | Persistent with own identity | Ephemeral (Claude Code Agent tool) |
| Heartbeats | Automatic every 30min | Local cron every 30min (auto-created) |
| Crons | Native with sub-second intervals | Local crons (CronCreate, durable) |
| Memory search | SQLite + FTS5 + embeddings | SQLite + FTS5 (+ QMD optional for embeddings) |
| Dreaming | 3-phase (Light/REM/Deep) | 3-phase (Light/REM/Deep) |
| QMD support | Built-in backend option | Optional backend via `/agent:settings` |
| Voice/TTS | Built-in | Requires external tool |

## License

MIT
