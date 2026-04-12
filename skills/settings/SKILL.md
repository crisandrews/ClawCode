---
name: settings
description: Configure agent settings — memory backend (builtin/QMD), search mode, temporal decay, citations. Triggers on /agent:settings, "configurar agente", "agent settings", "memory settings", "setup QMD", "configurar QMD", "configurar memoria".
user-invocable: true
argument-hint: [setting]
---

# Agent Settings

View and modify the agent's configuration stored in `agent-config.json`.

## Show current settings

If no argument given, read and display `agent-config.json`:

```bash
cat ${CLAUDE_PLUGIN_ROOT}/agent-config.json 2>/dev/null || echo '(no config — using defaults)'
```

Show defaults:
- Memory backend: **builtin** (SQLite + FTS5 + BM25 + temporal decay + MMR)
- Citations: **auto**
- Temporal decay: **enabled** (half-life 30 days)
- MMR: **enabled** (lambda 0.7)
- Heartbeat: **every 30 min**, active hours 08:00-23:00
- Dreaming: **nightly at 3 AM**

## Available settings

### Memory backend: `builtin` or `qmd`

**builtin** (default):
- SQLite + FTS5 full-text search with BM25 ranking
- Temporal decay for dated files (older = less relevant)
- MMR diversity re-ranking
- Works out of the box, no external tools needed

**qmd** (enhanced):
- External tool by @tobi: https://github.com/tobi/qmd
- Local embeddings via node-llama-cpp (no API keys needed)
- Vector search with semantic understanding
- Reranking for better result quality
- Requires `qmd` binary installed

### Setting up QMD

1. **Check if qmd is installed:**
   ```bash
   qmd --version 2>/dev/null && echo "QMD available" || echo "QMD not found"
   ```

2. **If not installed, guide the user:**
   ```
   Install QMD (local-first search tool, no API keys needed):
   
   bun install -g qmd
   # or download from https://github.com/tobi/qmd/releases
   ```

3. **Configure the backend:**
   Write to `agent-config.json`:
   ```json
   {
     "memory": {
       "backend": "qmd",
       "citations": "auto",
       "qmd": {
         "searchMode": "vsearch",
         "includeDefaultMemory": true,
         "limits": {
           "maxResults": 6,
           "timeoutMs": 15000
         }
       }
     }
   }
   ```

4. **If qmd is in a non-standard path**, set the command:
   ```json
   "qmd": {
     "command": "/path/to/qmd",
     ...
   }
   ```

5. **Reload the MCP server:**
   ```
   /mcp
   ```

### Search modes (QMD only)

| Mode | Description | Speed | Quality |
|---|---|---|---|
| `search` | Basic vector + BM25 hybrid | Fast | Good |
| `vsearch` | Vector search with reranking | Medium | Excellent |
| `query` | Full query expansion + rerank | Slow | Best |

Default: `vsearch` (recommended).

### Temporal decay (builtin only)

Controls how dated files (memory/YYYY-MM-DD.md) lose relevance over time:
- `halfLifeDays: 30` — a 30-day-old file scores at 50% of a today's file
- Set to a larger number (e.g., 90) to keep older memories relevant longer
- Set `temporalDecay: false` to disable

### Citations

- `auto` — show citations in direct chats, suppress in groups
- `on` — always show
- `off` — never show

## Modifying settings

To change a setting:
1. Read current `agent-config.json` (or create if it doesn't exist)
2. Update the relevant field
3. Write back the full config
4. Run `/mcp` to apply

## Heartbeat settings

### Active hours
Restrict heartbeat to the user's active window:
```json
{
  "heartbeat": {
    "schedule": "*/30 * * * *",
    "activeHours": {
      "start": "08:00",
      "end": "23:00",
      "timezone": "America/Santiago"
    }
  }
}
```

Outside these hours, the heartbeat cron still fires but the agent should skip silently.

### Dreaming schedule
```json
{
  "dreaming": {
    "schedule": "0 3 * * *",
    "timezone": "America/Santiago"
  }
}
```

## HTTP bridge + WebChat (optional)

The HTTP bridge is an optional local server that exposes the agent over HTTP — for webhooks, status checks, and a browser-based chat UI (WebChat).

**Off by default.** Enable with:

```json
{
  "http": {
    "enabled": true,
    "port": 18790,
    "host": "127.0.0.1",
    "token": ""
  }
}
```

Settings:
- `enabled` — turn the server on/off (default: `false`)
- `port` — port to listen on (default: `18790`)
- `host` — bind address (default: `127.0.0.1` — localhost only; change only if you know what you're doing)
- `token` — Bearer token for authenticated endpoints. Empty = no auth (fine for localhost-only). Set a value when exposing via tunnel (ngrok, Cloudflare, Tailscale).

### Using WebChat

1. Enable the HTTP bridge (above).
2. Run `/mcp` to reload.
3. Open `http://localhost:18790` in a browser.
4. Type. The agent sees messages as real user input — personality, memory, and commands all work the same as in WhatsApp or the CLI.

Endpoints exposed when `http.enabled: true`:
- `GET /` — WebChat UI
- `GET /health` — liveness (no auth)
- `GET /v1/status` — agent status
- `GET /v1/skills` — installed skills
- `POST /v1/webhook` — ingest webhooks
- `GET /v1/webhooks` — drain webhook queue
- `POST /v1/chat/send` — send a chat message
- `GET /v1/chat/history` — chat history
- `GET /v1/chat/stream` — real-time replies (SSE)

To turn WebChat off without losing other HTTP features, just close the browser tab. To turn the whole bridge off, set `http.enabled: false` and run `/mcp`.

### Security note

Bind to `127.0.0.1` unless you know your network is safe. If you must expose the port (LAN, tunnel), always set a `token` — otherwise anyone who can reach the port can chat as you.

## Important

- After any config change, the user must run `/mcp` to reload
- The builtin backend is always available as fallback even when QMD is configured
- QMD first run downloads embedding models (~100MB) — this is a one-time cost
- Heartbeat active hours are enforced by the agent (instructions), not the cron system
