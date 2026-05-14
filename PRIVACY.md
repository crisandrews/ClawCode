# Privacy Policy

_Last updated: 2026-04-28_

ClawCode is a local-first plugin for [Claude Code](https://claude.com/claude-code). It runs entirely on the user's machine. This document explains what data the plugin handles, where it is stored, and which third-party services it may contact — but only when the user explicitly enables them.

## 1. Who we are

ClawCode is an open-source project maintained by **crisandrews** and distributed under the [MIT License](./LICENSE). It is **not** operated as a hosted service. There is no ClawCode server, no account system, and no backend that receives user data.

- Source: https://github.com/crisandrews/ClawCode
- Issues / contact: https://github.com/crisandrews/ClawCode/issues

## 2. Data the plugin stores locally

All data created or managed by ClawCode lives on the user's filesystem, inside the project directory or the user's home directory. Nothing is transmitted to the plugin author.

Typical local artifacts:

- `SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md` — agent personality and user profile files authored by the user.
- `memory/*.md` and `memory/MEMORY.md` — searchable notes written by the agent during conversations.
- `memory/.memory.sqlite` — local SQLite database used for memory indexing and recall. Created with mode `0o600`; parent `memory/` directory created with mode `0o700`. **When channel-scope is armed (e.g. WhatsApp paired and `/agent:scope` enabled), this database also stores chat identifiers (JIDs) under `chunks.source_chat_id` so per-chat scope filters can run** — see "Channel-scope storage" below.
- `HEARTBEAT.md` — local heartbeat log.
- `logs/` and `conversations/` — optional local transcripts of CLI, WebChat, and messaging-channel sessions.
- `.claude/settings.json`, `.claude/hooks.json`, cron definitions — local configuration.
- `~/.claude/agent/scope-trust/<channel>-owner` — out-of-band trust marker created by the user via `/agent:scope wizard` (Bash-prompted). Empty file; presence + ownership = consent that this machine can act with owner privileges for the named channel. Created with mode `0o600`.

### Channel-scope storage

When the user opts into channel-scope for a paired channel (today: WhatsApp via `claude-whatsapp`), ClawCode reads upstream's `messages.db` read-only and indexes per-chat synthetic chunks into `memory/.memory.sqlite`. Concretely, two columns on `chunks` are populated:

- `source_channel` — the channel name (e.g. `"whatsapp"`).
- `source_chat_id` — the upstream chat identifier as a string (full WhatsApp JID, e.g. `<phone>@s.whatsapp.net` for DMs, `<group-id>@g.us` for groups).

These identifiers are stored cleartext, mirroring upstream's own storage. They are **not** transmitted off the machine by ClawCode. They are needed locally so the scope filter can answer "does this chunk belong to a chat the current operator is allowed to see" — without them, the per-chat allowlist couldn't be enforced.

The user can inspect or delete these rows directly via the SQLite CLI; removing `memory/.memory.sqlite` removes them with the rest of the index. ClawCode's cleanup sweep does not auto-remove synthetic chunks even when the underlying messages.db row is gone — re-indexing is incremental, by design.

The user may inspect, edit, export, or delete any of these files at any time. Removing the project directory removes all ClawCode data.

### Channel scope (per-channel opt-in)

ClawCode ships an opt-in per-channel scope layer that, **when set to `mode: enforce` and armed**, filters MCP `memory_*` queries so the agent only sees chunks belonging to chats the current operator is allowed to see (mirroring upstream plugins' own access governance — today, claude-whatsapp's `historyScope`). The default is `mode: off` for every channel.

Three modes per channel:

- **`off`** (default) — no scope filtering for that channel; behavior identical to having no scope layer.
- **`shadow`** — adapters compute filter decisions and emit stats / logs, but search results are NOT dropped and `memory_get` is NOT blocked. Useful for one-week observation before flipping to enforce. Shadow does NOT provide privacy guarantees on its own.
- **`enforce`** — filter actively drops disallowed chunks at every MCP read surface.

Activation goes through `/agent:scope wizard`, which writes both `agent-config.json: scope.<channel>` (via Bash, surfacing a permission prompt) and an out-of-band trust file (also via Bash). Both writes are required for owner-level unlock — config alone does not escalate.

**Important — what scope does NOT cover**: even at `mode: enforce`, the filter operates at the MCP boundary. Native `Read`, `Grep`, and direct SQLite reads over channel log files always bypass the filter by design. If hard isolation is required, that lives at the OS / filesystem-permissions layer. Same-uid filesystem forging (any other process running as your user could plant or tamper with channel-state files, including the cross-plugin request envelope) is also out of scope — scope is a privacy/safety layer between MCP tool calls and the agent, not a defense against OS-level adversaries already running as you. See `docs/channel-scope-compat.md` and `docs/scope-envelope-contract.md` for the full design.

### WebChat session model

When the HTTP bridge (`http.enabled: true`) is on, every browser tab gets a UUID v4 `sessionId` (persisted in `localStorage`) that partitions per-session chat history and SSE-broadcast. Two browsers with the same `http.token` cannot see each other's chat history or live agent replies. `sessionId` is a privacy partition, NOT auth — `http.token` is the auth boundary. Same-profile tabs share `localStorage` and therefore share a session.

**Known caveat — sessionId is not authentication**: anyone with the `http.token` who knows another user's `sessionId` (e.g. via a network trace, shared clipboard, or shoulder-surfing the URL) can read that session's history and impersonate it on `webchat_reply`. There is no enumeration endpoint, but a leaked UUID is sufficient to take over the session. If you tunnel the bridge to mutually untrusted users, set per-user tokens or run a separate bridge per user. See `docs/webchat.md`.

## 3. Data the plugin does **not** collect

ClawCode does not:

- Send telemetry, analytics, crash reports, or usage metrics to the author or any third party.
- Include tracking pixels, fingerprints, or remote loggers.
- Upload memory, conversations, or configuration anywhere by default.
- Require an account, email, or any form of registration.

## 4. Third-party services (opt-in only)

ClawCode can integrate with third-party services, but **only when the user explicitly configures them** (by providing API keys, installing a channel plugin, or enabling a feature). The plugin itself does not share data with these services on the user's behalf — it only acts as a pass-through when the user invokes a feature that uses them.

When enabled, data sent to these services is governed by the respective provider's privacy policy:

| Feature | Provider(s) | Data sent |
|---|---|---|
| Core LLM | Anthropic (Claude API) | Prompts, conversation context, tool calls — as required by Claude Code itself |
| Text-to-speech | ElevenLabs, OpenAI, or local macOS `say` | Text to be spoken |
| Speech-to-text | OpenAI Whisper API or local Whisper | Audio to be transcribed |
| Video analysis | Google Gemini | Video content submitted by the user |
| Messaging channels | WhatsApp, Telegram, Discord, iMessage, Slack (via separate MCP plugins) | Messages the user sends or receives through those channels |
| Community skills | GitHub | Repository fetches during skill installation |

Local alternatives (`say`, local Whisper, no-channel mode) are available for users who prefer to avoid remote services.

API keys are stored in the user's local environment or configuration files and are never transmitted to the plugin author.

## 5. Network features (off by default)

Two optional features open local network endpoints. Both are **disabled by default** and require explicit user action to enable:

- **HTTP bridge** — an optional local HTTP server for external integrations. When enabled, it requires a bearer token for any request originating from a non-loopback address.
- **Webhooks** — inbound webhook receiver. Also requires a token when exposed beyond localhost.

Neither feature initiates outbound calls to the plugin author.

## 6. User-provided content and responsibility

The user decides what to put into memory, identity, and conversation files. ClawCode does not classify, redact, or filter that content. Users should avoid storing sensitive information (secrets, credentials, regulated personal data, information about minors) in plain-text memory files if that is not appropriate for their environment.

When using third-party channels (WhatsApp, Telegram, etc.), the user is responsible for complying with the terms of service and applicable laws of those platforms, including obtaining any consent required from other participants in a conversation.

## 7. Children's privacy

ClawCode is a developer tool and is not directed at children under 13. The plugin does not knowingly collect information from children.

## 8. Security

Because all data is local, security is primarily a function of the user's own machine: filesystem permissions, disk encryption, and the secrecy of any API keys placed in the user's environment. Users should protect their project directory and configuration files accordingly.

Tokens for the optional HTTP bridge and webhook receiver should be treated as secrets.

## 9. Changes to this policy

If this policy changes, the updated version will be committed to this repository and the `Last updated` date above will be revised. Because the plugin runs locally, users receive changes only when they update their installed copy.

## 10. Contact

Questions, concerns, or requests related to this policy can be filed as an issue at:

https://github.com/crisandrews/ClawCode/issues
