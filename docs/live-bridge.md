# LiveBridge: voice attached to the existing leader

LiveBridge lets a local voice application such as Claude Live converse with the
current ClawCode session and observe its work. ClawCode retains its identity,
memory, permissions and asynchronous delegation. The bridge does not start Claude
workers, create another coordinator, own a WhatsApp connection, or send WhatsApp
messages. It is separate from the existing WebChat/HTTP bridge on port 18790.

## Enable explicitly in a test workspace

The default is disabled: no listener, store, live tools or channel capability. In
the workspace's existing `agent-config.json`, an operator can add:

```json
{
  "liveBridge": {
    "enabled": true,
    "port": 18791,
    "tokenEnv": "CLAWCODE_LIVE_TOKEN",
    "observeHooks": true
  }
}
```

Merge this block into the existing configuration; preserve the other settings.
Set `CLAWCODE_LIVE_TOKEN` to a randomly generated secret of at least 32 characters
in the environment that launches Claude Code. Configure the same value in the
local voice application's backend, never its browser code. The configuration
contains only the environment variable's name. The agent_config tool refuses
changes to the entire `liveBridge` subtree; a host restart applies operator edits.

ClawCode's installed plugin name is `agent` in marketplace `clawcode`. Launch the
chosen session with this custom channel explicitly enabled:

```sh
claude --dangerously-load-development-channels plugin:agent@clawcode
```

Keep any other explicitly enabled channel arguments appropriate to that session.
Custom Channels currently require the development flag and its consent dialog;
organization channel policy still applies. For a bare MCP registration, the
corresponding form is `server:<registered-server-name>`. These are documented in
[Anthropic's Channels reference](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview).
Do not point a daily Cloudy service at an experimental checkout implicitly.

The server binds only `127.0.0.1`. Every endpoint requires
`Authorization: Bearer <secret>` and a local Host header. Browser Origin headers
are refused. The local voice backend connects server to server. There is no
public bind option, CORS interface, URL token, or unauthenticated discovery.
An enabled bridge whose token, store or port is invalid remains unavailable while
the existing ClawCode MCP functionality continues.

## Delivery and ownership

The MCP server declares `experimental['claude/channel']` and sends
`notifications/claude/channel`. MCP logging is not an input transport. On client
initialization, it emits a probe. `channelReady` stays false until the actual
leader echoes that probe through `live_ack`. A successful notification write does
not prove that Channels was enabled or that the leader received it. The probe is
absent from HTTP snapshots and live_status. An authenticated `POST /v1/live/probe`
can retry the readiness probe if necessary.

Voice/web inputs are accepted durably while readiness is false. Once ready,
queued inputs are delivered to the existing session; Channels schedules them for
a turn and may group several pending messages. Each retains its own ID, revision,
origin and optional delegationId. `live_ack` proves that the leader attended that
specific revision; it does not mean the requested task finished. Transport state
is recorded before dispatch. An interrupted or failed write is uncertain and is
never automatically replayed after restart.

All attachments share **one logical owner conversation** per workspace store.
Reattach with its conversationId to recover the same public messages and tasks.
Attachment IDs are connection handles, not user identities or security boundaries.
The bearer token authorizes the local owner; this is not a multi-user or guest API.
Unknown conversation IDs are rejected. Detaching closes that attachment's streams,
without cancelling tasks or terminating ClawCode. A lost HTTP response followed by
reattachment does not submit another task: input IDs/revisions deduplicate across
attachments and restarts.

An owner may explicitly include work begun through WhatsApp in the same public
conversation by publishing `live_work` with that conversationId. No WhatsApp
history, guest envelope or transcript is automatically imported. Incoming Live
messages do not grant permission to send an answer to another channel. Existing
scope and execution gates continue to apply; this bridge does not bypass them.

## Public progress and task board

The leader gets four tools:

| Tool | Meaning |
| --- | --- |
| `live_status` | Public snapshot and readiness; no credentials or probe |
| `live_ack` | Echo probe, or acknowledge an exact input/command ID and revision |
| `live_emit` | Attributed public reply/progress/outcome with an idempotent publication ID |
| `live_work` | Create/update a public task record; no native execution side effect |

Publish live_work before delegating, during execution, and after the outcome is
known. Keep a stable taskId. If native hooks have already registered a nativeId,
update its existing taskId from live_status; the bridge refuses competing mappings.
Task cards contain status, public progress/history, optional parent/native/session
IDs, observedAt and controls. Public leader publications have idempotency keys;
reusing an ID with changed content is rejected. Two or more task cards can progress
independently while another input is queued. Actual parallelism remains the host's
native delegation capability, permissions and resource limits.

The optional hook collector sends only event/session/agent IDs and the readiness
probe on its own live_ack PostToolUse. It never reads transcript_path, assistant
messages, tool arguments/results, files, shell commands or WhatsApp content. That
probe hook binds the authenticated host session_id. Before binding, or for another
session, native observations are ignored. Current-session SubagentStart creates
a card immediately; agent tool hooks publish generic activity. SubagentStop records
that a response ended and leaves the task running until the leader reports the
actual outcome. Stop records a turn boundary without completing background work.
SessionEnd marks unfinished cards stale and removes their controls.

Hook delivery is best effort with a short timeout. Missing hooks are visible via
`observations.hooksSeen`; they are not inferred from installation alone. Explicit
live_work remains the reliable publication path, including native background Bash
jobs, scheduler work and other task types the collector does not discover. Raw
MessageDisplay is deliberately not forwarded because multiple inputs/channels can
share a turn and its output attribution is ambiguous.

Steer and cancel capabilities mean **requests to the leader**. Commands return
pending and require their own live_ack and explicit result. The task does not
become cancelled from command submission or acknowledgement. The leader must use
an available native control and publish the real task outcome with live_work;
unsupported native operations can be reported with command.rejected. No process
is killed by the bridge. Remote approvals and model changes are unsupported and
advertised false; use the normal host controls. No model name is guessed.

## HTTP v1 contract

| Method/path under `/v1/live` | Request / response |
| --- | --- |
| `GET /capabilities` | protocolVersion:1, agent, capabilities, observations, semantics |
| `POST /attachments` | `{conversationId?}` → attachmentId, conversationId, cursor, snapshot |
| `GET /attachments/:id/events?cursor=N` | SSE replay; Last-Event-ID also accepted |
| `POST /attachments/:id/inputs` | `{id,text,revision,origin:'voice'|'web',delegationId?,taskId?}` → inputId, revision, queued/acknowledged, conversationId |
| `POST /attachments/:id/commands` | `{id,kind:'steer'|'cancel',taskId,text?,revision?}` → commandId, pending/completed/rejected, conversationId |
| `DELETE /attachments/:id` | Detach only |
| `POST /probe` | Retry readiness probe; pending response |
| `POST /hooks` | Optional metadata collector; same bearer requirement |

Each SSE event has `id` (string sequence), `seq` (number), `type`, conversationId,
at, data and a **complete authoritative snapshot**. Apply the snapshot on every
event, and deduplicate messages by message.id. Connection events carrying
data.channelReady update transport readiness. State changes and event sequence
commit atomically. A cursor outside retained history yields `work.snapshot` with
`data.resync:true` and the current sequence; consumers replace their state.

Input IDs are stable across retries; new revisions must increase, may skip numbers
when voice fragments were coalesced, and keep their own acknowledgement. New text
replaces the same assignment, not a separate task. Superseded queued revisions are
not delivered; already-delivered revisions are corrected explicitly, and late
publications against an older revision are rejected. Command and publication IDs cannot be repurposed.
Published results require an acknowledged ID from this bridge; arbitrary host text
cannot become a voice reply. Validation errors return 400, auth failures 401,
disallowed origins/hosts 403, missing/detached handles 404, conflicts 409 and
unsupported commands 422. APIs accept JSON bodies up to 64 KiB.

## Persistence, restart and limits

The opt-in store is `.clawcode-live/state.json` in the workspace, mode 0600 within
a mode-0700 directory. It contains the explicitly shared public conversation,
pending inputs, commands, task snapshots, idempotency records and retained events.
Writes use a temporary file, fsync, atomic rename and directory fsync. An exclusive
writer lease prevents two MCP instances from owning the same store. Startup can
reclaim a dead PID's lease under a separate recovery lock; live/reused PIDs and an
abandoned recovery lock require operator inspection, never automatic process kills.
Corrupt or foreign-workspace state is rejected without replacement.

On restart, connection handles are invalidated; reattach to the same conversation.
Channel readiness and observed host identity must be established anew.
Unfinished task cards remain visible but stale, without controls until reconciled
by a current leader publication/observation. Queued, never-attempted inputs can be
dispatched after readiness; uncertain/already-written inputs are not retried.
This preserves delivery ambiguity instead of promising exactly-once execution.

Retention is bounded: 300 visible conversation messages, 100 history entries per
task, 500 task records, 10,000 input revisions, 10,000 commands and 30,000 publication
IDs. Event replay retains up to 1,000 events by default and about 4 MiB, with at
least the latest snapshot. Durable state has a 32 MiB hard ceiling. Existing task
and idempotency records are not silently dropped at the ceiling: the operator must
archive the stopped bridge's store before starting a fresh logical conversation.
There are at most 100 active attachments/streams. Slow SSE clients disconnect and
recover using their cursor.

## Reuse in another Claude Code MCP host

The four `lib/live-{bridge,store,types,tools}.ts` modules depend only on Node's
standard library. They can be used without ClawCode memory, SQLite or Bun:

```ts
const bridge = new LiveBridge({
  workspace, dataDir, token, port: 18792, agent: { id: "claude", name: "Claude" },
  deliver: message => mcp.notification({ method: "notifications/claude/channel", params: message }),
});
await bridge.start();
// Advertise tools plus experimental['claude/channel'] on the MCP Server.
// Append LIVE_INSTRUCTIONS; serve LIVE_TOOLS and bridge.callTool(name, args).
mcp.oninitialized = () => { void bridge.probeChannel(); };
mcp.onclose = () => { void bridge.close(); };
```

Port 0 requests an available loopback port; read bridge.port after start. A different
host can reuse `sanitizeHook` from hooks/live-observe.mjs and route its sanitized
payload with its own secret/port discovery. It must preserve probe/session binding.

## Validation

`npm run test:live` exercises the actual Node HTTP/SSE server and MCP SDK in-memory
transport with synthetic hosts: auth/origin checks, disabled readiness until ACK,
duplicate/revision conflicts, restart, uncertain delivery, two concurrent task cards,
cancel semantics, expired/replayed cursors, hook attribution, task staleness and
single-writer recovery. Run `npm run build:hook` after changes to configuration/scope
guards, then `npm test` for the existing regression suite.

These are deterministic integration tests without Claude model calls or WhatsApp.
They do not certify a paid native Claude Code Channels session or human microphone
interaction. That acceptance requires an explicitly enabled test host and the
corresponding Claude Live client. Existing daily installations are not activated by
this change.
