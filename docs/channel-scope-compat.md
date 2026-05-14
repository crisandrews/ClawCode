# Channel-scope compatibility

OpenCLAUDE indexes content from external channel plugins (today: `claude-whatsapp`'s WhatsApp logs, transcripts, voice notes) into a shared memory store, then exposes that content through MCP search/recall, dreams, and inbox surfaces. Without coordination, the agent would see every chat regardless of the upstream plugin's own per-chat access governance (`historyScope` in claude-whatsapp).

Channel scope is the **optional, per-channel** opt-in layer that mirrors the upstream plugin's access rules at OpenCLAUDE's MCP boundary. It is `mode: off` by default — users who don't configure it see no behavior change, and OpenCLAUDE works exactly as before.

This document covers: what scope enforces, how to turn it on, the cross-plugin contract that makes per-chat semantics possible, and the residual risks (especially native-filesystem bypass) that scope **does not** close.

## How to enable

Use `/agent:scope wizard` — an interactive REPL that walks the user through:

1. **Channel** (today: `whatsapp`)
2. **Mode** (`off | shadow | enforce`)
3. **Foreground identity** (`auto | owner | guest`)
4. **Background identity** (`deny | system-owner`) — what dreams/indexer see when no inbound is in flight

The wizard writes the scope tree to `agent-config.json` via `Bash` (which surfaces a permission prompt — the agent cannot silently elevate the policy via MCP because `agent_config(action='set')` refuses any scope key). If the user picks `owner` or `system-owner`, the wizard also creates an out-of-band trust file `~/.claude/agent/scope-trust/<channel>-owner` (a second `Bash` prompt). Both writes are required for owner unlock: config alone does not escalate.

The first wizard apply also surfaces a one-time banner clarifying that MCP scope is not a filesystem sandbox.

## Modes

- **`off`** (default) — no filtering for that channel; behavior identical to having no scope layer at all.
- **`shadow`** — adapters compute filter decisions and emit stats / logs, but search results are NOT dropped and `memory_get` is NOT blocked. Useful as an observation window before flipping to `enforce`. Shadow does not provide privacy guarantees on its own.
- **`enforce`** — filter actively drops disallowed chunks at every MCP read surface.

## What enforcement covers

When a channel is `mode: enforce` and the upstream plugin's governance is resolvable (e.g. `access.json` parses), enforcement runs at these chokepoints:

- `memory_search`, `memory_get`, `memory_context` — per-row filtering by `source_channel` + `source_chat_id` (SQL pre-filter when the allowlist can be computed eagerly, post-filter with refill otherwise).
- The QMD adapter path — skipped for scoped queries when a partial allowlist applies (QMD's external indexer doesn't honor `source_chat_id`); owner unlock keeps QMD in the path.
- `voice_transcribe` — refuses absolute paths that reverse-map (via realpath + longest-prefix-wins) into an armed channel's `extraPath` unless the call carries a valid envelope.
- The dream promote path — channel-derived candidates route to the scoped lane (`memory/.scoped/<channel>/MEMORY.<encoded-chat>.md`); locals continue to `memory/MEMORY.md`; mixed sets fall to worst-contributor-wins.
- `chat_inbox_read` — gates on `runtime.channels.webchat?.armed === true && mode === "enforce"` (defensive scaffolding; no webchat adapter ships today).

## Owner unlock (two-factor)

To let an agent acting on the user's behalf see all chats indexed under a channel:

1. **Config**: set `scope.<channel>.identity = "owner"` (foreground) or `scope.<channel>.background.identity = "system-owner"` (dreams + indexer). The wizard does this via `Bash`.
2. **Out-of-band trust file**: create `~/.claude/agent/scope-trust/<channel>-owner` (any file with mode `0o600`; presence + uid is the signal). The wizard does this via a second `Bash` prompt.

Both are required. The trust file exists because the agent can write the config via `Bash` (which a permissive auto-allow setup could approve silently), but the second `Bash` to touch the trust file is a separate, deliberate confirmation — closing the prompt-injection escalation surface where a hijacked agent could otherwise simulate owner consent. **Caveat**: if `Bash` is on auto-allow for the session, the trust file is created without an interactive prompt; in that case the user should review the wizard's confirmation preview before approving the apply step, or run the commands manually outside the agent.

`WHATSAPP_OWNER_BYPASS=1` in the shell env is an alternative escape hatch — agents launched with that env can read scoped content as owner. Useful for owner-launched terminal sessions where no inbound has happened recently.

## What scope does NOT cover

- **Native filesystem bypass**: `Read`, `Grep`, direct SQLite reads, or any non-MCP tool can read raw channel log files (e.g. `~/claude-whatsapp/extras/<chat>/<date>.md`). MCP scope filters at the MCP boundary, not at the OS layer. If hard isolation is required, use filesystem permissions or sandboxed user accounts.
- **Same-uid filesystem forging**: any process running as the same user can plant or tamper with channel-state files (including `access.json`, the request envelope, and the trust file). The uid check in readers rules out cross-user tampering but not same-user adversaries. Scope is a privacy/safety layer between MCP tool calls and the agent — not a defense against OS-level adversaries already running as you.
- **Reply-egress taint**: once a snippet reaches the agent, voice (`speak`) and dream output is not tracked. A search hit's text is in the agent's context; gating the egress side would require end-to-end taint propagation across every output surface.
- **Within-TTL replay of envelopes**: the cross-plugin request envelope token is single-use bounded-reuse within its 60-second TTL (multi-tool agent flows require reuse). A prompt-injected payload in one inbound can induce the agent to reuse the wrong inbound's token — `docs/scope-envelope-contract.md` documents this as the "token confusion" residual.

## Cross-plugin request envelope contract

When both `claude-whatsapp` and OpenCLAUDE are installed and OpenCLAUDE has scope opted-in, per-chat semantics flow through a **request envelope token**:

- claude-whatsapp emits a 32-byte random token for every inbound, written atomically to `<channel-dir>/.request-envelopes/<token>.json` (mode `0o600`, dir `0o700`).
- The token is embedded in the inbound's notification meta as `meta.requestEnvelopeToken`.
- When OpenCLAUDE's memory tools (`memory_search`, `memory_get`, `memory_context`, `voice_transcribe`) accept the optional `requestEnvelopeToken` arg and the agent forwards the token, OpenCLAUDE resolves the envelope and emits an allowlist that mirrors `claude-whatsapp/scope.ts:scopedAllowedChats` byte-exact.
- Without forwarding the token under `mode = enforce`, calls fall through to guest `[]`. Owner unlock (`identity:"owner"` + trust file) is the always-available escape hatch and is unaffected by envelope absence.

Full wire-level contract: `docs/scope-envelope-contract.md` (mirrored byte-exact in both repos).

## Architecture surfaces (developer reference)

- `lib/scope/runtime.ts` — `detectScopeRuntime(config, workspaceRoot?)` returns `{anyArmed, anyEnforceConfigured, channels}`. Adapter instantiation is gated on `mode != off && adapterAvailable && governanceResolvable`. The `anyEnforceConfigured` flag covers the visibility window where a user has configured `mode: enforce` but the adapter is currently unavailable (uninstalled plugin, deleted access.json) — fail-closed at every chokepoint.
- `lib/scope/whatsapp.ts` — WhatsApp adapter. Mirrors `claude-whatsapp/scope.ts` byte-exact: `normalizeAccess` (forward-compat), `resolveAllowed`, `scopedAllowedChatsFromEnvelope`.
- `lib/scope/envelope.ts` — hardened reader for the cross-plugin request envelope. `O_NOFOLLOW + O_NONBLOCK + fstat + uid + mode 0o077 + size cap 1024 + realpath + TTL + future-skew + LRU bounded-reuse cap 256`.
- `lib/scope/filter.ts` — `filterScopedResults` + `buildSqlPreFilter` + `assertCanReadPath`. SQL pre-filter for deny-all and partial-allowlist cases.
- `lib/scope/cache.ts` — atomic write-temp+rename for `scope-cache.json` with advisory lock + 30s stale-lock recovery.
- `lib/scope/synthetic-indexer.ts` — read-only WAL-respecting reader over upstream `messages.db`. Per-chat synthetic chunks at `extra:claude-whatsapp/messages-db/<chat_id>/<YYYY-MM-DD>`. Cursor + dev:ino identity, in-place truncation + rowid-reuse recovery, throttled reconciliation, PII quarantine on confirmed DB absence with 24h grace.
- `lib/scope/scoped-paths.ts` — `memory/.scoped/<channel>/MEMORY.<encoded-chat>.md` filename encoder/decoder (Windows-safe), advisory lockfile (O_EXCL + PID liveness probe + cross-host timestamp grace), `<scoped:<channel>:<8-char-hash>>` PII redaction markers.
- `lib/scope/trust.ts` — out-of-band trust file primitive.
- `lib/scope/agent-config-guard.ts` — `classifyAgentConfigKey` blocklist for `agent_config(action='set')`. Refuses scope keys, prototype-pollution segments, oversize keys, and privileged keys.
- `lib/scope/lifecycle.ts` — file-watcher on `~/.claude/plugins/installed_plugins.json` (500ms debounce, unrefed timer, parent-dir watch for atomic-rename safety).

## Diagnostics

- `/agent:scope status` — show every configured channel's runtime state.
- `/agent:scope test <chatId>` — dry-run probe against the adapter for a given chat.
- `/agent:scope audit` — re-run doctor and surface only the scope rows.
- `/agent:doctor` — the scope rows on the doctor card cover audit, bypass surfaces, quarantine pending, wizard availability, staleness, owner assertion, schema drift, and indexer health.

## Cross-references

- `PRIVACY.md` — per-channel scope subsection + storage of `source_channel` / `source_chat_id`.
- `docs/scope-envelope-contract.md` — wire-level cross-plugin contract.
- `skills/scope/SKILL.md` — wizard flow + limitations.
- `AGENTS.md` — how the agent forwards `requestEnvelopeToken` to memory tools.
