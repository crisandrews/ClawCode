# Channel-scope compatibility

ClawCode indexes content from external channel plugins (today: `claude-whatsapp`'s WhatsApp logs, transcripts, voice notes) into a shared memory store, then exposes that content through MCP search/recall, dreams, and inbox surfaces. Without coordination, the agent would see every chat regardless of the upstream plugin's own per-chat access governance (`historyScope` in claude-whatsapp).

Channel scope is the **optional, per-channel** opt-in layer that mirrors the upstream plugin's access rules at ClawCode's MCP boundary. It is `mode: off` by default — users who don't configure it see no behavior change, and ClawCode works exactly as before.

This document covers: what scope enforces, how to turn it on, the cross-plugin contract that makes per-chat semantics possible, and the residual risks (especially native-filesystem bypass) that scope **does not** close.

## How to enable

Use `/agent:scope wizard` — an interactive REPL that walks the user through:

1. **Channel** (today: `whatsapp`)
2. **Mode** (`off | shadow | enforce`)
3. **Foreground identity** (`auto | owner | guest`)
4. **Background identity** (`deny | system-owner`) — what dreams/indexer see when no inbound is in flight

The wizard writes the scope tree to `agent-config.json` via `Bash` (which surfaces a permission prompt — the agent cannot silently elevate the policy via MCP because `agent_config(action='set')` refuses any scope key). If the user picks `owner` or `system-owner`, the wizard also creates an out-of-band trust file `~/.claude/agent/scope-trust/<workspace-fingerprint>/<channel>-owner` (a second `Bash` prompt; per-workspace as of 1.7.0). Both writes are required for owner unlock: config alone does not escalate.

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
2. **Out-of-band trust file**: create `~/.claude/agent/scope-trust/<workspace-fingerprint>/<channel>-owner` (any file with mode `0o600`; presence + uid is the signal). The wizard does this via a second `Bash`, invoking the bridge script `scripts/print-workspace-fingerprint.mjs` so the Bash subdir name matches the TS helper byte-exact.

Both are required. The trust file exists because the agent can write the config via `Bash` (which a permissive auto-allow setup could approve silently), but the second `Bash` to touch the trust file is a separate, deliberate confirmation — closing the prompt-injection escalation surface where a hijacked agent could otherwise simulate owner consent. **Caveat**: if `Bash` is on auto-allow for the session, the trust file is created without an interactive prompt; in that case the user should review the wizard's confirmation preview before approving the apply step, or run the commands manually outside the agent.

### Trust files are per-workspace (1.7.0+)

As of 1.7.0, trust files live in a subdirectory keyed by a fingerprint of the workspace path: `~/.claude/agent/scope-trust/<workspace-fingerprint>/<channel>-{owner,exec}`. The fingerprint is `SHA256(realpath(workspaceRoot))` (with case-fold applied per-workspace based on a filesystem probe rather than the platform default — case-sensitive APFS volumes don't get over-folded), truncated to 32 hex chars.

Granting trust in workspace A does NOT silently unlock workspace B — `agent-config.json` was already per-workspace, so a global trust file would have been a category error. Re-run `/agent:scope wizard` in each workspace where you want trust granted.

**1.6 → 1.7 migration** (hard cutover, no automatic upgrade):
- Legacy `~/.claude/agent/scope-trust/<channel>-{owner,exec}` files (the pre-1.7 layout) are ignored as of 1.7.0.
- Three surfaces nudge you to re-grant: a SessionStart hook stderr line, a `console.warn` when an armed channel first detects the mismatch, and a doctor row `scope-trust-legacy` that lists the exact paths plus the `rm` command to clean them up after re-granting.
- The SessionStart advisory is dismissible per workspace via `~/.claude/agent/scope-trust/<workspace-fingerprint>/.scope-trust-legacy-dismissed` (workspace-scoped, not global — dismissing in workspace A still warns in workspace B).

`WHATSAPP_OWNER_BYPASS=1` in the shell env is an alternative escape hatch — agents launched with that env can read scoped content as owner. Useful for owner-launched terminal sessions where no inbound has happened recently.

## Execution scope (optional, separate from read scope)

Read scope filters what the agent **sees**. Execution scope restricts what the agent **does** when the current turn was triggered by a non-owner messaging-channel inbound.

The threat model: a prompt-injected message in a group chat could induce the agent to invoke destructive tools (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`) or sensitive MCP tools (`agent_config`, `skill_install`, `dream`). Without execution scope, the only defense is the LLM's safety training plus the system prompt — best-effort, not deterministic.

Execution scope is configured per channel under `scope.<channel>.execGate`, **independent** of the read-scope `mode` above:

- **`mode`** — `off | shadow | enforce` (default `off`). `shadow` logs what would be blocked without actually blocking; `enforce` blocks.
- **`policy`** — `denylist | allowlist` (default `denylist`). With denylist, the listed tools are blocked when the gate fires; with allowlist, ONLY the listed tools are allowed.
- **`tools`** — array of tool names. Defaults to a "destructive set" (`Bash`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, plus selected MCP tools) under denylist policy, or a "safe set" (`Read`, `Grep`, `Glob`, `memory_*`, `reply`, `react`, etc.) under allowlist.
- **`lookbackMs`** — how far back (in ms) the gate looks at the channel-dir's `.request-envelopes/` to decide whether the current turn is influenced by a non-owner inbound. Default `60_000`.

When the gate fires (mode != off + a non-owner envelope exists in the lookback window AND no execution-trust file is present), `Bash` AND `Task` are hard-denied regardless of `tool_input` content. `Bash` because shell command grammar is too rich to safely parse for output redirection; `Task` because it spawns a subagent and Claude Code's hook propagation to subagents is not guaranteed — wholesale deny is the only defensible posture for both. Other tools are blocked or allowed per the policy + `tools[]` list.

`shadow` mode logs would-block decisions to `memory/.execgate-shadow.jsonl` (atomic 1 MB rotation to `.1` backup; older history dropped). Each event captures sender hash, tool name, effective mode, policy, expanded tools, hook version, config hash, lookback window, and envelope count — enough to replay the decision after a config change. The doctor check `scope-execgate-shadow-events` summarizes these events (warns when any are within the last 7 days, prompting review before flipping to enforce).

**Always-on protected paths** (independent of mode/policy, fires even with `mode: off`): writes via `Write`, `Edit`, `MultiEdit`, or `NotebookEdit` to a fixed self-protecting list — `<plugin-root>/hooks/` directory (incl. the PreToolUse hook script `exec-gate-pretool.sh`), `<plugin-root>/dist/exec-gate-resolver.cjs`, the four exec-gate source files (`<plugin-root>/lib/scope/exec-gate.ts`, `exec-gate-hook-entry.ts`, `protected-paths.ts`, `agent-config-guard.ts`), `<workspace>/agent-config.json`, `~/.claude/`, `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, `~/.kube/`, `~/.docker/`, shell init files (`~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.config/fish/config.fish`, etc.), `~/Library/LaunchAgents/`, `~/.config/systemd/user/`, the `.mcp.json` / `.claude-plugin/plugin.json` files, and every configured channel's `access.json` (regardless of channel mode). The agent cannot self-modify the gate, plant a persistence backdoor through MCP write tools, or corrupt channel governance to soft-DoS the owner.

**Execution-trust file** (separate from read-scope owner trust): `~/.claude/agent/scope-trust/<workspace-fingerprint>/<channel>-exec` unlocks the gate for that channel in THIS workspace. Created via `Bash` in the wizard — the agent cannot create it through any MCP tool, ensuring the unlock requires deliberate user consent. The `<channel>-owner` (read scope) and `<channel>-exec` (execution scope) trust files are independent — neither implies the other. You can opt into reading all your channels' content from your own machine without also granting non-owner group chats the power to invoke destructive tools. Per-workspace as of 1.7.0; if you want exec-trust in multiple workspaces, opt in to each one separately.

**Trade-off — false-positives in mixed-traffic groups**: the gate fires whenever ANY non-owner envelope exists in the lookback window, even if the current turn is responding to a different inbound. Under context-contamination model this is correct: if the agent processed a non-owner message within the last 60s, its working context likely includes that content, and blocking destructive operations prevents action-on-injected content even when authority is ambiguous. Mitigations: create the `<channel>-exec` trust file, tighten `lookbackMs`, or run owner-driven destructive operations from a terminal (where no channel envelope is present → gate doesn't fire).

## What scope does NOT cover

- **Native filesystem bypass**: `Read`, `Grep`, direct SQLite reads, or any non-MCP tool can read raw channel log files (e.g. `~/claude-whatsapp/extras/<chat>/<date>.md`). MCP scope filters at the MCP boundary, not at the OS layer. If hard isolation is required, use filesystem permissions or sandboxed user accounts.
- **Same-uid filesystem forging**: any process running as the same user can plant or tamper with channel-state files (including `access.json`, the request envelope, and the trust file). The uid check in readers rules out cross-user tampering but not same-user adversaries. Scope is a privacy/safety layer between MCP tool calls and the agent — not a defense against OS-level adversaries already running as you.
- **Reply-egress taint**: once a snippet reaches the agent, voice (`speak`) and dream output is not tracked. A search hit's text is in the agent's context; gating the egress side would require end-to-end taint propagation across every output surface.
- **Within-TTL replay of envelopes**: the cross-plugin request envelope token is single-use bounded-reuse within its 60-second TTL (multi-tool agent flows require reuse). A prompt-injected payload in one inbound can induce the agent to reuse the wrong inbound's token — `docs/scope-envelope-contract.md` documents this as the "token confusion" residual.

## Cross-plugin request envelope contract

When both `claude-whatsapp` and ClawCode are installed and ClawCode has scope opted-in, per-chat semantics flow through a **request envelope token**:

- claude-whatsapp emits a 32-byte random token for every inbound, written atomically to `<channel-dir>/.request-envelopes/<token>.json` (mode `0o600`, dir `0o700`).
- The token is embedded in the inbound's notification meta as `meta.requestEnvelopeToken`.
- When ClawCode's memory tools (`memory_search`, `memory_get`, `memory_context`, `voice_transcribe`) accept the optional `requestEnvelopeToken` arg and the agent forwards the token, ClawCode resolves the envelope and emits an allowlist that mirrors `claude-whatsapp/scope.ts:scopedAllowedChats` byte-exact.
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
