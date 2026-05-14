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
| GET | `/` | Token-gated when `http.token` is set; public when no token | WebChat UI (HTML) |
| GET | `/chat`, `/chat.html` | Same as `/` | Aliases for the UI |
| GET | `/v1/status` | Token | Agent identity, memory stats, config summary |
| GET | `/v1/skills` | Token | List installed skills with descriptions |
| POST | `/v1/webhook` | Token | Ingest a webhook (queued for agent) |
| GET | `/v1/webhooks` | Token | Drain webhook queue (for agent to consume) |
| POST | `/v1/chat/send` | Token | Send a chat message; body `{message, sessionId}`. 400 on missing/invalid `sessionId`. |
| GET | `/v1/chat/history` | Token | Chat history; query `?sessionId=<uuid>&limit=&since=<id>`. 400 on missing/invalid `sessionId`. 200 with empty entries on valid-but-unknown UUID. |
| GET | `/v1/chat/stream` | Token | SSE stream of chat events; query `?sessionId=<uuid>` (+ optional `&token=` for clients that can't set headers). 400 on missing/invalid `sessionId`. Server filters broadcasts so only same-session events arrive. |
| GET | `/watchdog/mcp-ping` | Token (+ loopback socket peer only) | Liveness probe for external watchdogs — returns `{ok, version, ts, plugins}`. Route refuses requests whose TCP peer is not `127.0.0.1`/`::1`/`::ffff:127.0.0.1` (`req.socket.remoteAddress`). NOTE: this is socket-peer enforcement — a local reverse proxy or tunnel can still relay remote-origin traffic that appears loopback to the bridge. For tunneled deployments the practical boundary is the token, NOT loopback. See [watchdog.md](watchdog.md). |
| POST | `/watchdog/llm-ping` | Token **required** (+ loopback socket peer only) | End-to-end LLM probe. Injects a `__watchdog_ping__` message into the WebChat inbox with a random nonce and polls for an agent reply containing `PONG-<nonce>`. Returns 200 + latency on match, 504 on timeout. Rate-limited 1/hour per token. Body: optional `{timeout_ms}` (1000-60000). Same socket-peer caveat as `/watchdog/mcp-ping`. See [watchdog.md](watchdog.md). |

All endpoints set permissive CORS. Auth is via `Authorization: Bearer <token>` header, or `?token=...` query string as a fallback for SSE clients that can't set headers.

## Security

- **Binds to 127.0.0.1 by default.** Nobody else on your network can reach it.
- **If you tunnel the port** (ngrok, Cloudflare Tunnel, Tailscale funnel, SSH -R), set a long random `http.token` — otherwise anyone with the URL can chat as you.
- **Do NOT** change `host` to `0.0.0.0` unless you've set a token and understand your network.
- **Webhook bodies are capped at 64 KB** to prevent denial via huge payloads.
- **Webhook queue cap: 1000 entries.** Oldest are evicted FIFO. Chat inbox cap: 500. History cap: 500 per session.
- **WebChat session model**: per-browser UUID v4 in `sessionId` partitions history + SSE-broadcast. `sessionId` is a privacy partition, NOT auth — `http.token` is the auth boundary. See [webchat.md](webchat.md).
- **Active-session limits**: 100 idle sessions (LRU), pinned (live SSE) sessions never evicted; hard cap of 1000 total sessions and 8 SSE clients per session.

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
