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

1. **User types and hits Enter.** Browser does `POST /v1/chat/send` with `{message, sessionId}`. The browser generates a UUID v4 the first time the page loads and persists it in `localStorage`; subsequent sends reuse it.
2. **HTTP bridge appends to the per-session history** AND echoes to SSE clients **of that session only** (so the sender sees their own message; other browsers in other sessions never see it).
3. **MCP notification fires** (`notifications/message` with `logger: "webchat"`, including `sessionId`) to Claude Code's side. If Claude Code surfaces it, the agent sees the message inline.
4. **Agent reads inbox** — on every heartbeat and every turn, the agent calls `chat_inbox_read` to pull any pending WebChat messages. Each entry is prefixed with `[sessionId=<uuid>]` so the agent knows which browser tab to reply to.
5. **Agent processes and replies** via `webchat_reply({message, sessionId})`. The agent must copy the `sessionId` verbatim from the inbox entry — passing the wrong one routes the reply to the wrong user.
6. **Bridge broadcasts the reply** to SSE clients of that session only. Other browsers see nothing.

The inbox + tool path is the reliable layer. The notification is opportunistic — if it works, replies arrive instantly; if not, the agent catches messages on the next tool-read cycle.

## MCP tools

| Tool | Use |
|---|---|
| `chat_inbox_read({limit?})` | Read pending WebChat messages; drains the inbox. Each entry is tagged with its `sessionId` for routing replies. |
| `webchat_reply({message, sessionId})` | Send an agent reply to one specific browser session via SSE. Required — plain text output will NOT reach WebChat. The `sessionId` must match the one from the inbox entry. |

Both tools return a friendly hint when the HTTP bridge is off ("WebChat is not enabled. Enable via /agent:settings").

## Privacy partitioning (sessions)

Every browser tab carries its own UUID v4 `sessionId`, stored in `localStorage` and sent with every fetch. The bridge keeps a per-session history bucket and an SSE-broadcast filter that ONLY delivers messages back to clients in the same session.

**What `sessionId` is**: a privacy partition. Two different browsers (or two browser profiles) cannot see each other's chat history or live SSE replies, even with the same token.

**What `sessionId` is NOT**: authentication. The `http.token` (when set) is the auth boundary. Anyone with the token can supply any UUID and read/write that session — there's no enumeration endpoint, but a UUID known via a network trace or a clipboard share IS sufficient to impersonate that session. If you tunnel the bridge to mutually untrusted users, set per-user tokens or run a separate bridge per user.

**Tab vs profile**: `localStorage` is shared across same-profile tabs of the same browser. Two tabs in the same Chrome profile share the same `sessionId` (and so see each other's history). Two different browsers, or a private/incognito window, get distinct sessions. To force per-tab isolation, clear `localStorage` in one of the tabs (the page generates a new UUID on next load).

**Clearing `localStorage`** loses the link to your prior conversation history (the on-disk JSONL retains everything; the agent can still recall facts via memory_search). Acceptable trade-off: clearing browser data is an explicit user action.

**Legacy logs**: pre-v1.5 JSONL entries (no `sessionId` field) load into an internal `_legacy` bucket. They're never accepted from any public surface, so no fresh client ever sees them — they're preserved only for the agent's continuity.

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
- `GET /v1/chat/history?sessionId=<uuid>&limit=50&since=<id>` — initial render + slow-client catch-up. 400 on missing/invalid `sessionId`; 200 with empty entries on valid-but-unknown UUID.
- `GET /v1/chat/stream?sessionId=<uuid>` — live updates (SSE with `event: hello` / `event: message`). 400 on missing/invalid `sessionId`. SSE-broadcast is filtered server-side; only this session's messages arrive.
- `POST /v1/chat/send` — outgoing messages; body is `{message, sessionId}`. 400 on missing/invalid `sessionId`.

All documented in [http-bridge.md](http-bridge.md).

## Limits

- Messages capped at 32 KB (413 returned if exceeded)
- Chat history: last 500 messages retained per session
- Active sessions: cap of 100 idle sessions (LRU evicted, oldest first); sessions with a live SSE client are pinned and never evicted
- Hard cap of 1000 total sessions (pinned + idle); when reached, new SSE subscriptions and new sends from previously-unseen sessions return 503
- Per-session SSE-client cap: 8 concurrent streams
- Inbox: 500 max (oldest evicted FIFO; one global queue with sessionId tags)
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
