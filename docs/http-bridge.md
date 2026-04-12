# HTTP bridge — local HTTP server

Optional local HTTP server that runs alongside the MCP stdio server inside the ClawCode process. When enabled, it exposes status, webhooks, and WebChat endpoints on `localhost`. Off by default.

## When to enable it

Turn it on if you want any of these:
- **WebChat** — browser chat UI at `http://localhost:<port>` (see [webchat.md](webchat.md))
- **Webhook ingestion** — receive events from GitHub, Stripe, custom apps
- **Status/skills endpoints** — query agent identity, memory stats, installed skills over HTTP
- **REST integration** — scripts or other programs talking to the agent locally

Leave it off if you only use the CLI or messaging channels (WhatsApp/Telegram/etc.) — nothing requires it.

## Enabling

Edit `agent-config.json`:

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

Then `/mcp` to reload. Confirm with `/agent:doctor` — the `HTTP bridge` check should be ✅.

## Config keys

| Key | Default | Notes |
|---|---|---|
| `http.enabled` | `false` | Master switch |
| `http.port` | `18790` | TCP port |
| `http.host` | `"127.0.0.1"` | Bind address. Localhost only by default. Change only if you understand the implications. |
| `http.token` | `""` | Bearer token. Empty = no auth (fine for localhost). Set to a long random string if exposing via tunnel. |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | Public | Liveness probe |
| GET | `/` | Public | WebChat UI (HTML) |
| GET | `/chat`, `/chat.html` | Public | Aliases for the UI |
| GET | `/v1/status` | Token | Agent identity, memory stats, config summary |
| GET | `/v1/skills` | Token | List installed skills with descriptions |
| POST | `/v1/webhook` | Token | Ingest a webhook (queued for agent) |
| GET | `/v1/webhooks` | Token | Drain webhook queue (for agent to consume) |
| POST | `/v1/chat/send` | Token | Send a chat message (WebChat) |
| GET | `/v1/chat/history` | Token | Chat history (optionally `?since=<id>`) |
| GET | `/v1/chat/stream` | Token | SSE stream of chat events (supports `?token=` query) |

All endpoints set permissive CORS. Auth is via `Authorization: Bearer <token>` header, or `?token=...` query string as a fallback for SSE clients that can't set headers.

## Security

- **Binds to 127.0.0.1 by default.** Nobody else on your network can reach it.
- **If you tunnel the port** (ngrok, Cloudflare Tunnel, Tailscale funnel, SSH -R), set a long random `http.token` — otherwise anyone with the URL can chat as you.
- **Do NOT** change `host` to `0.0.0.0` unless you've set a token and understand your network.
- **Webhook bodies are capped at 64 KB** to prevent denial via huge payloads.
- **Webhook queue cap: 1000 entries.** Oldest are evicted FIFO. Chat inbox cap: 500. History cap: 500.

## Operational notes

- Port already in use? The bridge logs `[http-bridge] Port N in use — HTTP bridge disabled` to stderr and the MCP server keeps running. Change the port in config and `/mcp`.
- On `/mcp` reload, SSE clients get disconnected — browsers auto-reconnect after ~2s.
- No external dependencies. Pure Node `http`. Zero npm additions.

## Implementation

| File | Role |
|---|---|
| `lib/http-bridge.ts` | `HttpBridge` class, endpoint routing, SSE management |
| `server.ts` | Reads `config.http`, instantiates bridge, wires message handler → MCP notification |
| `static/chat.html` | Served by `GET /` — documented in [webchat.md](webchat.md) |
| `skills/settings/SKILL.md` | Human-facing config guide |
| `skills/doctor/SKILL.md` | Health check including HTTP probe |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/agent:doctor` shows `HTTP bridge disabled` | `http.enabled: false` (default) | Edit `agent-config.json` and `/mcp` |
| `/agent:doctor` shows `enabled but not reachable` | Port collision or process died | Check `/tmp` logs; change port; `/mcp` |
| 401 on every request | Token set in config, not sent in request | Add `Authorization: Bearer <token>` header |
| Browser can't connect via SSE | Token set but query param missing | Append `?token=<token>` to `/v1/chat/stream` |
