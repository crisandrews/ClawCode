# WebChat — browser chat UI

A local browser-based chat interface for talking to your agent without the terminal. Ships as a single HTML file (zero build, zero dependencies) served by the HTTP bridge. Off by default — requires the HTTP bridge enabled.

## When to use it

- You want a chat surface without setting up WhatsApp/Telegram
- You're showing the agent to someone else locally
- You prefer a browser over a terminal REPL
- You want to test the agent's personality and memory with a lightweight UI

Everything that works in WhatsApp works here: slash commands (`/status`, `/help`, `/whoami`), personality injection, memory save/retrieve, heartbeats.

## Enable and open

1. Turn on the HTTP bridge — see [http-bridge.md](http-bridge.md)
2. `/mcp` to reload
3. Open `http://localhost:18790` (or whatever port you set) in a browser

That's it. Agent greeting loads from `/v1/chat/history`; new messages stream in via SSE.

If you set a token, append `?token=<your-token>` to the URL.

## How a message round-trip works

1. **User types and hits Enter.** Browser does `POST /v1/chat/send` with `{message}`.
2. **HTTP bridge queues it** in the chat inbox AND echoes it to connected SSE clients (so the sender sees their own message immediately).
3. **MCP notification fires** (`notifications/message` with `logger: "webchat"`) to Claude Code's side. If Claude Code surfaces it, the agent sees the message inline.
4. **Agent reads inbox** — on every heartbeat and every turn, the agent calls `chat_inbox_read` to pull any pending WebChat messages.
5. **Agent processes and replies** via the `webchat_reply` MCP tool.
6. **Bridge broadcasts the reply** to all open SSE clients. Browser renders it.

The inbox + tool path is the reliable layer. The notification is opportunistic — if it works, replies arrive instantly; if not, the agent catches messages on the next tool-read cycle.

## MCP tools

| Tool | Use |
|---|---|
| `chat_inbox_read({limit?})` | Read pending WebChat messages; drains the inbox. Returns messages in order. |
| `webchat_reply({message})` | Send an agent reply to the open browser via SSE. Required — plain text output will NOT reach WebChat. |

Both tools return a friendly hint when the HTTP bridge is off ("WebChat is not enabled. Enable via /agent:settings").

## UI behavior

| Feature | Implementation |
|---|---|
| Dark/light mode | Follows `prefers-color-scheme` |
| Auto-grow textarea | Up to 140px before scrolling |
| Enter to send | Shift+Enter adds newline |
| Optimistic render | User message shown immediately; if send fails, toast appears |
| Typing indicator | "…thinking" appears between send and first reply |
| Connection dot | Green = SSE connected; red = reconnecting |
| Auto-reconnect | After 2s on SSE error |
| Agent name | Populated from `/v1/status` IDENTITY.md Name field |
| Reload-safe | Last 50 messages reload from `/v1/chat/history` |

## Endpoints used by the UI

- `GET /` — page itself
- `GET /v1/status` — agent identity for header
- `GET /v1/chat/history?limit=50` — initial render
- `GET /v1/chat/stream` — live updates (SSE with `event: hello` / `event: message`)
- `POST /v1/chat/send` — outgoing messages

All documented in [http-bridge.md](http-bridge.md).

## Limits

- Messages capped at 32 KB (413 returned if exceeded)
- Chat history: last 500 messages retained in memory
- Inbox: 500 max (oldest evicted FIFO)
- SSE heartbeat: 20s comment lines keep connection alive through proxies
- No media (images/audio) in v1 — text only

## Security

- Default bind is `127.0.0.1` — not reachable from the network
- Set `http.token` if tunneling the port (ngrok, Cloudflare, Tailscale)
- Browser loads token from URL `?token=<t>` param — use incognito to avoid leaking in history

## Implementation

| File | Role |
|---|---|
| `static/chat.html` | The entire UI (HTML + inline CSS + inline JS) |
| `lib/http-bridge.ts` | Serves `chat.html`, routes `/v1/chat/*`, manages SSE + inbox + history |
| `server.ts` | `chat_inbox_read` and `webchat_reply` MCP tools + MCP notification bridging |
| `templates/AGENTS.md` | Instructions telling agents to call `chat_inbox_read` + reply with `webchat_reply` |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page loads but stays disconnected | Token required, not in URL | Add `?token=<t>` to URL |
| Messages send but no reply | Agent not calling `chat_inbox_read` on heartbeats | Reload personality with `/mcp`; check AGENTS.md has the WebChat block |
| Replies appear delayed | SSE proxy/firewall | Ensure no reverse proxy is buffering — use a tunnel that supports SSE |
| Empty screen, no UI | `static/chat.html` missing | Reinstall plugin |
