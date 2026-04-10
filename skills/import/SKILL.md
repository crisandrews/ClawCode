---
name: import
description: Import an existing OpenClaw agent from its workspace directory into the current project. Triggers on /agent:import, "importar agente", "traer de openclaw", "import agent".
user-invocable: true
argument-hint: [agent-id]
---

# Import an OpenClaw Agent

Import an existing agent from an OpenClaw installation into this directory, then offer the same setup steps a new agent gets (QMD, messaging, crons).

## Part 1: Copy the agent

1. **List available OpenClaw agents**:
   ```bash
   ls -d ~/.openclaw/workspace* 2>/dev/null
   ```
   
   For each workspace, read IDENTITY.md to show the agent's name:
   - `~/.openclaw/workspace/` — default agent (main)
   - `~/.openclaw/workspace-eva/` — agent "eva"
   - `~/.openclaw/workspace-jack/` — agent "jack"

2. **Let the user choose** which agent to import (or use argument if provided).

3. **Determine the source path**:
   - Default/main: `~/.openclaw/workspace/`
   - Named agent: `~/.openclaw/workspace-{id}/`

4. **Copy bootstrap files** to the current project root:
   Files to copy from the source workspace:
   - `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md`
   
   Also copy CLAUDE.md from the plugin templates (NOT from OpenClaw):
   ```bash
   cp ${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md ./
   ```

5. **Import memory** (ask user first):
   - Copy `MEMORY.md` to `./memory/MEMORY.md`
   - Copy recent memory files from `memory/` (last 30 days by default, or all if user wants full history)
   - Create `./memory/.dreams/` directory with empty `short-term-recall.json`
   - **NEVER copy** files with `credential`, `password`, `secret`, `.env` in their name

6. **Adapt AGENTS.md** for Claude Code:
   After copying, remove or comment out sections referencing OpenClaw-specific tools:
   - `sessions_spawn`, `message tool`, `browser tool`
   - `gateway`, `cron tool` (native OpenClaw cron), OpenClaw CLI commands
   - `HEARTBEAT_OK`, `NO_REPLY`, `ANNOUNCE_SKIP`, `SILENT_REPLY_TOKEN`
   
   **Keep**: safety rules, behavioral rules, memory protocols, learning rules, personal conventions.

## Part 2: Post-import setup (offer the same as /agent:create)

After the files are copied, the imported agent is functional but not fully configured. Offer the same setup steps a new agent gets, so imported agents end up with full parity.

### Step A — Memory backend (QMD vs builtin)

Check if QMD is installed:
```bash
qmd --version 2>/dev/null
```

**If QMD is available**, offer to enable it:
> "I detected QMD on your system. It gives you much better memory — local embeddings, semantic search, reranking. Want me to enable it for this imported agent?"

If yes, write `agent-config.json`:
```json
{
  "memory": {
    "backend": "qmd",
    "citations": "auto",
    "qmd": {
      "searchMode": "vsearch",
      "includeDefaultMemory": true,
      "limits": { "maxResults": 6, "timeoutMs": 15000 }
    }
  }
}
```

**If QMD is NOT available**, explain the option:
> "I'm using built-in search (SQLite + FTS5). For semantic search you can install QMD later (`bun install -g qmd`) and enable it with `/agent:settings`."

Write default config:
```json
{
  "memory": {
    "backend": "builtin",
    "citations": "auto",
    "builtin": {
      "temporalDecay": true,
      "halfLifeDays": 30,
      "mmr": true,
      "mmrLambda": 0.7
    }
  }
}
```

### Step B — Default crons (heartbeat + dreaming)

Check if crons are already configured:
```bash
test -f .crons-created && echo "already done" || echo "pending"
```

If pending, create the two default crons by calling `CronCreate` MCP tool:

1. **Heartbeat** (every 30 min):
```
CronCreate(
  schedule: "*/30 * * * *",
  prompt: "Run /agent:heartbeat",
  durable: true
)
```

2. **Dreaming** (nightly at 3 AM):
```
CronCreate(
  schedule: "0 3 * * *",
  prompt: "Use the dream tool: dream(action=run)",
  durable: true
)
```

3. After both succeed, mark as done:
```bash
touch .crons-created
```

### Step C — Messaging channel (optional)

Ask the user:
> "Your agent is imported. Want to also connect it to WhatsApp, Telegram, Discord, or iMessage so you can reach it from your phone? I can guide you through the setup."

If yes:
- Run the `/agent:messaging` skill flow
- Default recommendation: WhatsApp via `crisandrews/claude-whatsapp`
- The skill shows the exact commands for the user to run (plugin install + relaunch with channel flags)

If the user already has a messaging plugin installed (from a previous agent), offer to add its log directory to `memory.extraPaths` so past conversations become searchable.

### Step D — Reload

Tell the user to reload the MCP server so all the new config takes effect:
```
/mcp
```

Select `clawcode` and reconnect.

## Part 3: Report

Summarize what was imported and what was set up:

```
✅ Import complete

Agent: <Name> <emoji>
Files copied: <N> bootstrap + <M> memory files
Memory backend: <builtin | qmd>
Crons: <set up | pending>
Messaging: <not yet | <platform> | skipped>

Next: /mcp to reload and start using the agent.
```

## Important

- **Never copy credential files** (API keys, passwords, tokens, `.env`).
- **Always ask** before overwriting existing files in the current directory.
- **AGENTS.md adaptation is critical** — remove OpenClaw tool references, keep behavioral rules.
- **Part 2 (post-import setup) is what makes imports reach full parity** with freshly-created agents. Don't skip it — an imported agent without crons and memory config is half-installed.
- If the user is in a hurry, they can skip Part 2 and run `/agent:settings`, `/agent:messaging` etc. later.
