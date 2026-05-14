# Scope Envelope Contract (cross-repo)

> **Status**: 1.0 (stable)
> **Mirrored** between `OpenCLAUDE/docs/scope-envelope-contract.md` and `claude-whatsapp/docs/scope-envelope-contract.md`. Edit BOTH or NEITHER. Drift = contract violation.

## Purpose

claude-whatsapp publishes per-inbound metadata that OpenCLAUDE optionally consumes to scope `memory_search` / `memory_get` / `memory_context` / `voice_transcribe` to the chat that triggered the agent. Without this contract, OpenCLAUDE has no way to know which WhatsApp chat the current MCP call is in service of, so per-chat `historyScope` enforcement is impossible.

Both plugins are independent — each works standalone. Integration activates only when both are installed AND `scope.whatsapp.mode != off` in OpenCLAUDE's config.

## Invariants

1. **Independence**: claude-whatsapp writes envelopes regardless of whether OpenCLAUDE is installed. OpenCLAUDE reads envelopes only when scope is opted-in. Each plugin still operates fully without the other.
2. **Fail-closed**: when `scope.whatsapp.mode === "enforce"` and no valid envelope is consumed, OpenCLAUDE returns guest `[]` (no chats). Owner unlock path (`identity:"owner"` + trust file) is the only opt-out — and it's declared out-of-band, not through the envelope.
3. **Envelope token is the authority**: OpenCLAUDE reads `chatId`/`senderId` from the envelope file on disk, NOT from the notification payload. The notification's existing `meta.chat_id` / `meta.user_id` fields are agent-display data only — never authoritative for scope decisions. A prompt-injected agent forging `chatId` in tool arguments cannot trick OpenCLAUDE, because OpenCLAUDE ignores tool-arg chatId and uses the envelope file's chatId.
4. **Byte-exact JID round-trip**: senderId and chatId travel as opaque strings. No normalization. Whitespace, case, suffix preserved exactly as upstream emits.

## Constants

```
ENVELOPE_TTL_MS              = 60_000      // 60s freshness window
CLOCK_SKEW_TOLERANCE_MS      = 5_000       // future-ts rejection threshold
TOKEN_BYTES                  = 32          // 256-bit entropy
TOKEN_ENCODING               = base64url   // no padding
TOKEN_LENGTH                 = 43          // chars
TOKEN_REGEX                  = /^[A-Za-z0-9_-]{43}$/
DIR_NAME                     = ".request-envelopes"
DIR_MODE                     = 0o700
FILE_MODE                    = 0o600
ROTATION_CAP                 = 500         // claude-whatsapp prunes oldest envelopes past this count
LRU_CONSUMED_TOKENS_CAP      = 256         // OpenCLAUDE in-memory consumed-token cache
ENVELOPE_MAX_BYTES           = 1024        // defensive cap on file size at read time
```

## File location

```
<channel-dir>/.request-envelopes/<token>.json
```

- **claude-whatsapp side**: `<channel-dir>` is the plugin's `CHANNEL_DIR`, resolved at `server.ts:121` as `process.env.CLAUDE_PROJECT_DIR ?? detectProjectDir()`. `detectProjectDir()` reads `~/.claude/plugins/installed_plugins.json` to find the local-scope `projectPath` for the `whatsapp@claude-whatsapp` install matching the current cwd. The same dir already holds `access.json`, `messages.db`, and `.last-inbound.json` (last-inbound marker).
- **OpenCLAUDE side**: same path resolved via `lib/channel-detector.ts:detectWhatsappProjectDir(home, cwd, { cwdExactMatchOnly })`, which reads the SAME `installed_plugins.json`. Returns `null` gracefully when claude-whatsapp is not installed (independence preserved). There is no dedicated env var for the envelope dir — discovery flows through the existing install-registry mechanism.

`<token>` is the base64url-encoded 32-byte payload; it MUST match `TOKEN_REGEX` and MUST equal the `token` field inside the JSON.

## Payload schema

```json
{
  "version": 1,
  "token": "<43-char base64url string, matches TOKEN_REGEX>",
  "chatId": "<JID, e.g. 5491112345678@s.whatsapp.net or 1234567890@g.us>",
  "senderId": "<JID, e.g. 5491112345678@s.whatsapp.net>",
  "ts": 1715500000000,
  "expiresAt": 1715500060000
}
```

Field semantics:
- `version`: schema version. Today 1. Future bumps reserve the right to add fields; readers MUST tolerate unknown extra fields (forward-compat); writers MUST emit `version: 1` until the schema changes.
- `token`: must equal the filename stem (defense against forged filenames pointing at a different token's payload).
- `chatId`: WhatsApp chat ID where the inbound arrived. For 1-on-1 DMs this is the contact's JID. For groups this is the group JID (suffix `@g.us`).
- `senderId`: WhatsApp sender JID of the specific message that triggered the notification. For 1-on-1 DMs this equals `chatId`. For groups this is the group member's JID.
- `ts`: epoch milliseconds of envelope write time (writer's clock).
- `expiresAt`: hard ceiling. MUST equal `ts + ENVELOPE_TTL_MS`. Any later value is a contract violation; readers should reject.

## Writer responsibilities (claude-whatsapp)

For every inbound message that the plugin handles AND about which it emits a `notifications/claude/channel` notification to the host MCP client:

1. Generate a fresh `token`: `crypto.randomBytes(32).toString("base64url")`.
2. Compute `ts = Date.now()` and `expiresAt = ts + 60_000`.
3. Atomically write `<channel-dir>/.request-envelopes/<token>.json` containing the full payload:
   - Open a temp file in the same directory with `fs.openSync(tmpPath, 'wx', 0o600)`.
   - Write the JSON.
   - `fs.fsync` is NOT required (TTL is a freshness model, not durability — node will write soon enough).
   - `fs.renameSync(tmpPath, finalPath)`.
4. Embed the token in the existing `notifications/claude/channel` payload's `meta` block as a new field `requestEnvelopeToken`. The existing `meta.chat_id` / `meta.user_id` fields stay as-is (agent display data only — not authoritative for scope decisions). Example:
   ```json
   {
     "method": "notifications/claude/channel",
     "params": {
       "content": "<message text>",
       "meta": {
         "chat_id": "<existing display field>",
         "user_id": "<existing display field>",
         "requestEnvelopeToken": "<43-char token>",
         "...": "..."
       }
     }
   }
   ```
   The agent extracts `requestEnvelopeToken` from notification meta and forwards it to OpenCLAUDE tools. OpenCLAUDE NEVER trusts `chat_id`/`user_id` from the notification or from tool args — it reads identity from the envelope file on disk.
5. Best-effort housekeeping on each write:
   - Glob `.request-envelopes/*.json`; if count > `ROTATION_CAP`, unlink oldest by mtime.
   - Unlink files where `expiresAt < Date.now() - CLOCK_SKEW_TOLERANCE_MS` (drop with skew tolerance).
6. Tolerate transient filesystem errors (ENOSPC, EROFS): log warning, skip envelope write, dispatch notification WITHOUT token. OpenCLAUDE will see absent token and fail-closed (acceptable degradation).

## Reader responsibilities (OpenCLAUDE)

`loadEnvelope(channelDir: string, token: string): EnvelopePayload | null`:

1. Validate filename: `TOKEN_REGEX.test(token)` — else return `null` immediately (no FS access).
2. Resolve `filePath = path.join(channelDir, ".request-envelopes", token + ".json")`.
3. `lstat(filePath)`:
   - ENOENT → `null` (independence: no claude-whatsapp installed or no envelope for this token).
   - Other errors → `null`.
4. Open with `fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)`:
   - Symlink → ELOOP → `null`.
   - FIFO/socket/device → blocked or error → `null`.
5. Single-fd `fstat`:
   - Reject if not `S_ISREG`.
   - Reject if `mode & 0o077` (world/group-readable).
   - Reject if `uid !== process.getuid()`.
   - Reject if `size > ENVELOPE_MAX_BYTES`.
6. Read full file via fd, close fd.
7. Parse JSON. Catch errors → `null`.
8. Validate payload:
   - `version === 1` (reject anything else; forward-compat for unknown fields only).
   - `typeof token === "string" && token === <filename token>` (defense against forged token field).
   - `typeof chatId === "string" && chatId.length > 0`.
   - `typeof senderId === "string" && senderId.length > 0`.
   - `typeof ts === "number" && Number.isFinite(ts) && ts > 0`.
   - `typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt === ts + ENVELOPE_TTL_MS`.
9. TTL + skew validation:
   - Compute `now = Date.now()`.
   - Reject if `now - ts > ENVELOPE_TTL_MS` (expired).
   - Reject if `ts > now + CLOCK_SKEW_TOLERANCE_MS` (future-skewed).
10. Bounded-reuse cache (`consumedTokens` LRU cap `LRU_CONSUMED_TOKENS_CAP`):
    - If token in cache AND cached entry still fresh (`now - cachedFirstSeen < ENVELOPE_TTL_MS`): return cached payload (same agent flow reading multiple tools).
    - Else insert `{token, firstSeenMs: now, payload}` and return payload.
    - LRU evicts when capacity exceeded.
11. Realpath confirmation (path traversal defense, even though TOKEN_REGEX already excludes path separators): assert `fs.realpathSync(filePath)` starts with `fs.realpathSync(path.join(channelDir, ".request-envelopes")) + path.sep`. Reject otherwise.

`null` from `loadEnvelope` is the catch-all "envelope unusable" signal. Callers in `enforce` mode MUST map `null` → guest `[]` allowlist.

## Validation table

| Failure mode | Reader returns |
|---|---|
| Token doesn't match regex | `null` |
| File missing (no channel-dir, no envelope) | `null` |
| Symlink target | `null` |
| FIFO/non-regular file | `null` |
| File mode != 0o600 | `null` |
| File owned by another uid | `null` |
| File size > 1024 bytes | `null` |
| JSON parse error | `null` |
| `version !== 1` | `null` |
| Missing/wrong-type field | `null` |
| `payload.token !== filename stem` | `null` |
| `expiresAt !== ts + 60000` | `null` |
| `now - ts > 60000` (expired) | `null` |
| `ts > now + 5000` (future-skewed) | `null` |
| Path traversal post-realpath | `null` |
| Cache hit within TTL | cached payload |
| Cache hit past TTL | `null` (evicted + treated as miss) |
| Successful load | parsed payload |

## Token consumption policy

Tokens are **bounded-reuse within TTL**, NOT single-use. The same token MAY be loaded multiple times within its 60s window. This is required for multi-tool agent flows (e.g., `memory_search` → `memory_get` of a hit). After TTL expiry the token is rejected even if its file still exists on disk.

claude-whatsapp emits ONE token per inbound notification, NOT per MCP tool call. The agent passes the same token to every tool it calls in service of that inbound.

## Resolver semantics (byte-exact mirror of `claude-whatsapp/scope.ts:71` `scopedAllowedChats`)

Upstream scope semantics are 100% **chat-level**. There is NO within-chat sender-level filtering. `historyScope: "own"` means "only this chat" (not "only my own messages within this chat"). The envelope's `senderId` is used ONLY for the owner check; `chatId` is the discriminator for the actual scope rule.

```
resolveAllowed(envelope, access):
  // Out-of-band escape hatches (declarative, not envelope-driven)
  if (identity === "owner" + trust file present)         → null  // unlimited
  if (env.WHATSAPP_OWNER_BYPASS === "1")                  → null
  // Bootstrap fail-open (only when access was auto-discovered)
  if (envelope absent + access.ownerJids === [] + isAutoDiscovered) → null
  if (envelope absent + mode === "enforce")               → []     // guest

  // With envelope
  if (access.ownerJids.includes(envelope.senderId))       → null  // owner unlock via envelope

  isGroup = envelope.chatId.endsWith("@g.us")
  historyScope = isGroup
    ? access.groups[envelope.chatId]?.historyScope
    : access.dms[envelope.chatId]?.historyScope
  // Default when undefined: "own"
  scope = historyScope ?? "own"

  universe = new Set([...access.allowFrom, ...Object.keys(access.groups)])

  if (scope === "all")              → null  // unlimited within universe (SQL prefilter constrains source_channel != ?)
  if (scope === "own")              → [...new Set([envelope.chatId])].filter(c => universe.has(c))
  if (Array.isArray(scope))         → [...new Set([envelope.chatId, ...scope])].filter(c => universe.has(c))
  // Unknown historyScope value (forward-compat): treat as "own", emit warn log
  default                           → [...new Set([envelope.chatId])].filter(c => universe.has(c))
```

Note: `groups[chatId].allowFrom` exists in the real `AccessState` but is **inbound admission control** (server.ts:643 — used to decide whether an inbound message gets accepted), NOT read scope. OpenCLAUDE's resolver MUST NOT consult `groups[chatId].allowFrom` when computing read-scope chat lists.

## Rejected scope values

`historyScope === "members"` (and any other value outside `{"own", "all", string[]}`) is treated as the conservative default `"own"` and a warn is logged. Forward-compat: future schema additions don't break readers. Both repos enforce identical rejection behavior.

## senderId / chatId canonicalization

There is NO normalization layer. JIDs travel as opaque strings, byte-exact, between claude-whatsapp's source (the upstream WA library) and OpenCLAUDE's indexer + envelope reader. Whitespace, case, suffix (`@s.whatsapp.net`, `@g.us`) preserved.

A mismatch caused by normalization on one side would silently break filtering. If either side introduces a normalization pass in the future, the contract version MUST bump.

## Compatibility matrix

| claude-whatsapp | OpenCLAUDE | mode | envelope token | behavior |
|-----------------|------------|------|----------------|----------|
| pre-1.19.0 | pre-1.5.0 | n/a | n/a | pre-contract baseline |
| 1.19.0+ | pre-1.5.0 | n/a | written but ignored | pre-contract baseline |
| pre-1.19.0 | 1.5.0+ | enforce | absent | OpenCLAUDE reads token=null → guest `[]`. **Surface in doctor as warn**: "OpenCLAUDE expects requestEnvelopeToken but claude-whatsapp doesn't emit it; upgrade claude-whatsapp or set scope.whatsapp.mode=off". Workaround: owner unlock (identity:"owner"+trust file) unaffected. |
| 1.19.0+ | 1.5.0+ | off | n/a | scope inactive |
| 1.19.0+ | 1.5.0+ | shadow | n/a | shadow logs but doesn't filter |
| 1.19.0+ | 1.5.0+ | enforce | valid | partial allowlist emitted per chat/sender binding |
| 1.19.0+ | 1.5.0+ | enforce | invalid/expired/replayed/missing | guest `[]` |

## Threat model

**Closed**:
- Concurrent inbound race: each inbound generates its own token; concurrent inbound B's token does not appear in agent's tool call A.
- Request-confusion (binding from notification meta → exact file): closed.
- Foreground/other-channel bleed: without token agent's foreground call falls to guest.
- Symlink, FIFO, world-readable, wrong-uid, oversized file, replay-across-TTL-boundary: all closed by reader hardening.

**Open (residual, accepted under agent-trust-boundary)**:
- **Same-uid filesystem forge (architectural, OUT OF SCOPE)**: any code running as the user can write/read files in the user's `<channel-dir>`. The envelope's `uid === process.getuid()` reader check rules out cross-user tampering (different uid → reject), but it cannot distinguish "claude-whatsapp's writer" from "another process running as the same user with a forged envelope." On-disk JSON cannot prevent this. The threat model is: scope is a privacy/safety layer between MCP tool calls AND the agent, not a defense against an OS-level adversary already running as the user. Documented in `docs/channel-scope-compat.md` and `PRIVACY.md`.
- **Token confusion across concurrent inbounds**: if inbounds from chat A and chat B both arrive within TTL, the agent has two valid tokens. A prompt-injected payload in A could induce the agent to use B's token while ostensibly handling A → B's scope leaks into A's response. Bounded by recent-inbound set + TTL; not closeable without per-tool-call authority binding (which MCP-siblings topology doesn't provide).
- Within-TTL replay (same-token re-use within 60s): TTL + bounded-reuse cache reduce window but don't close.
- Native FS bypass (`Read` / `Grep` / SQLite direct): architectural.
- Reply-egress taint: once snippet reaches the agent, voice/dream output is not taint-tracked.

## Versioning

This contract is `version: 1`. Any schema field change, constant change, or semantic change MUST bump the major version AND coordinate a synchronized release between both repos. Bumps:
- Writer emits new version.
- Reader rejects mismatched version (returns `null`) until updated.

Version skew between installed plugins is detected at runtime by the reader: an envelope with `version !== 1` returns `null` (treated as malformed → guest fail-closed under enforce). A future doctor check could probe upstream's envelope schema version directly from `installed_plugins.json`, but that work is deferred — the runtime fail-closed already prevents incorrect scope decisions, just without surfacing the cause in `/agent:doctor`.

## References

- claude-whatsapp `scope.ts:71` — `scopedAllowedChats(context, access)` — the reference logic that OpenCLAUDE's resolver mirrors.
- claude-whatsapp `server.ts:694, 701` — current `currentInboundContext` + `setInboundContext` — the hook point where envelope writing is wired.
- OpenCLAUDE `lib/scope/whatsapp.ts` — adapter; extends `normalizeAccess`, `resolveAllowed`, and `allowedChatIds` to consume envelope-bound foreground contexts.
- OpenCLAUDE `lib/scope/envelope.ts` — reader.
- OpenCLAUDE `lib/scope/context.ts:ForegroundContext` — extended with optional `envelope` field.
- OpenCLAUDE `lib/channel-detector.ts:detectWhatsappProjectDir` — channel-dir resolution.

## Golden fixture

A shared golden fixture (`tests/fixtures/scope-envelope-v1.json`) MUST exist in both repos with identical bytes. Both writer (claude-whatsapp) and reader (OpenCLAUDE) consume the fixture in tier1 tests to verify the schema round-trips without drift.
