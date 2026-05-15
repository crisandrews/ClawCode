---
name: scope
description: Channel-scope status, opt-in, and audit. Triggers on /agent:scope, "scope status", "scope wizard", "scope enable", "scope disable", "scope audit".
user-invocable: true
argument-hint: <status|enable|disable|wizard|test|audit> [args...]
---

# Scope

Channel-scope is the per-channel opt-in compatibility layer between ClawCode and messaging plugins that publish their own access governance (today: claude-whatsapp's `historyScope`). When a channel is *armed* (mode != off, governance resolvable), ClawCode's memory surfaces honor the upstream plugin's access rules; when a channel is `mode: off` (the default), behavior is identical to having no scope layer.

This is an OPTIONAL feature — see `docs/channel-scope-compat.md`. Enforcement covers `memory_search`, `memory_get`, `memory_context`, the QMD path, `voice_transcribe`, `dream` promote routing, and `chat_inbox_read`. Per-chat semantics flow through (a) a synthetic per-chat indexer over the upstream `messages.db` which produces per-chat chunks, and (b) a cross-plugin request envelope contract — claude-whatsapp embeds a `requestEnvelopeToken` in each inbound notification, and ClawCode resolves the token to a chat/sender binding for the current MCP call. Owner unlock (declarative `identity = "owner"` + out-of-band trust file) remains the always-available escape hatch; without an envelope (or with an invalid/expired one) under `mode = enforce`, calls fall through to guest `[]`.

Talk to the user in the language they've been using on this turn — never default to a hard-coded language.

## When to use

- After installing claude-whatsapp + pairing it: `/agent:scope status` confirms the adapter sees `access.json`.
- To turn enforcement on: `/agent:scope wizard` walks through the choices, or use the one-liner `/agent:scope enable whatsapp shadow` (or `enforce`).
- To turn it off: `/agent:scope disable whatsapp`.
- To inspect existing channel-derived content in shared memory: `/agent:scope audit`.

## Steps

### Step 1 — Parse the subcommand

The first word in `$ARGS` selects the path:

- `status` → show every configured channel's runtime state
- `enable <channel> [shadow|enforce]` → set `config.scope.<channel>.mode`
- `disable <channel>` → set mode to `off`
- `wizard` → interactive REPL flow via `AskUserQuestion`
- `test <chatId>` → dry-run probe against the adapter (see Step 6)
- `audit` → re-run `mcp__clawcode__agent_doctor` and surface only the `scope-*` rows

If `$ARGS` is empty or the subcommand is unknown, default to `status`.

### Step 2 — `status`

1. Call `mcp__clawcode__agent_config(action='get')` and parse the `scope` block.
2. For each channel under `scope`, display:
   - `mode` (off / shadow / enforce)
   - `identity` (auto / owner / guest)
   - `background.identity` (deny / system-owner)
   - `execGate.mode` (off / shadow / enforce), `execGate.policy` (denylist / allowlist), and `execGate.tools` count (or "defaults" when omitted)
   - WhatsApp only: `accessJsonPath`, `cwdExactMatchOnly`
3. Surface trust file presence (read scope + exec):
   - `<channel>-owner` exists? (yes/no) — gates read scope owner unlock
   - `<channel>-exec` exists? (yes/no) — gates execGate "trust this machine" path
4. Then call `mcp__clawcode__agent_doctor(action='check')` and surface the scope rows (`scope-pre-enforce-audit`, `scope-bypasses`, `scope-quarantine-pending`, `scope-execgate-status`, `scope-execgate-shadow-events`).

If `scope` is absent in config, say so explicitly and recommend `/agent:scope wizard`.

### Step 3 — `enable <channel> [mode]`

**All scope-tree writes are refused by `mcp__clawcode__agent_config(action='set')`** (any key starting with `scope`). The agent cannot silently elevate or relax the policy; every scope key goes through `Bash`, which surfaces a permission prompt to the user.

For `enable <channel> <mode>` the single Bash call covers ALL scope.<channel> keys. Substitute BOTH `<channel>` (validated against the shipped enum `{whatsapp, telegram, discord, imessage, webchat}`) AND `<mode>` ('shadow' or 'enforce'; default 'shadow' when omitted) from `$ARGS`. Refuse any other literal for either parameter — only those values are valid for enable. `cwdExactMatchOnly` preserves the prior value if the user had it `true`:

```
Bash('node -e "const fs=require(\"fs\"),p=\"agent-config.json\";const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,\"utf-8\")):{};c.scope=c.scope||{};const ch=\"<channel>\";const cur=c.scope[ch]||{};c.scope[ch]=Object.assign({},cur,{mode:\"<mode>\",identity:\"auto\",accessJsonPath:cur.accessJsonPath||\"auto\",cwdExactMatchOnly:cur.cwdExactMatchOnly===true,background:Object.assign({},cur.background,{identity:\"deny\"})});fs.writeFileSync(p,JSON.stringify(c,null,2));console.log(\"wrote\",p);"')
```

The `Bash` call surfaces a permission prompt to the user — that's intentional. Default mode when omitted: `shadow`. Confirm by re-running `status`.

Tell the user: "Run `/mcp reconnect clawcode` for changes to take effect."

### Step 4 — `disable <channel>`

First validate `<channel>` is one of the shipped channel names (`whatsapp`, `telegram`, `discord`, `imessage`, `webchat`). Reject any other value with an error message — this defends against future channel IDs that might contain shell metacharacters. Currently shipped names are alphanumeric and safe.

`scope.<channel>.mode` AND `scope.<channel>.execGate.mode` are both on the security-sensitive blocklist, so this also goes through `Bash`. A `disable` resets BOTH read scope AND execGate to off (the user expected "turn the channel off" — they don't expect read scope to flip but exec scope to remain active):

```
Bash('node -e "const fs=require(\"fs\"),p=\"agent-config.json\";const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,\"utf-8\")):{};c.scope=c.scope||{};const cur=c.scope.<channel>||{};c.scope.<channel>=Object.assign({},cur,{mode:\"off\",execGate:{mode:\"off\"}});fs.writeFileSync(p,JSON.stringify(c,null,2));console.log(\"disabled\");"')
```

Also remove BOTH trust files (read-scope owner trust AND exec trust) for THIS workspace. As of 1.7.0 the trust files live under a per-workspace fingerprint subdir; the fingerprint is computed by the bridge script `scripts/print-workspace-fingerprint.mjs` so Bash and TS agree byte-exact:

```
Bash('set -euo pipefail; [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || { echo "CLAUDE_PLUGIN_ROOT unset"; exit 1; }; TS_HASH=$(node "$CLAUDE_PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs" "$CLAUDE_PLUGIN_ROOT/scripts/print-workspace-fingerprint.mjs" "$PWD"); [[ "$TS_HASH" =~ ^[0-9a-f]{32}$ ]] || { echo "bad TS_HASH=$TS_HASH"; exit 1; }; rm -f -- "$HOME/.claude/agent/scope-trust/$TS_HASH/<channel>-owner" "$HOME/.claude/agent/scope-trust/$TS_HASH/<channel>-exec"')
```

so both unlocks are dropped along with the mode flip. Both Bash calls surface a permission prompt — intentional: turning scope off and dropping trust are user-visible state changes. Cross-workspace isolation: this only removes THIS workspace's trust; other workspaces are untouched.

### Step 5 — `wizard` (interactive)

Load `AskUserQuestion` via `ToolSearch(query='select:AskUserQuestion')` first.

Then walk the user through the choices, ONE question per `AskUserQuestion` call. Sample flow (substitute the user's language):

1. **Which channel?**
   - "WhatsApp (claude-whatsapp paired)" → `whatsapp`
   - "Cancel" → exit, no changes
   (Skip channels that are not installed/paired — only offer those whose `agent_doctor` reports installed+authenticated.)

2. **Mode?**
   - "Shadow — collect stats but don't filter (recommended for first week)"
   - "Enforce — filter denied chunks immediately"
   - "Cancel" → exit

3. **¿Sos el owner de este WhatsApp?** (owner-unlock primitive — two-factor: `identity = "owner"` config + out-of-band trust file)
   - "Sí, soy el owner — quiero que ClawCode pueda buscar en mis chats sin restricción" → `identity: owner` AND step 6 will create a **per-workspace** trust file (as of 1.7.0) under `~/.claude/agent/scope-trust/<workspace-fingerprint>/whatsapp-owner` via Bash. Both writes are required: config alone (which the agent can write) does NOT unlock — the trust file (a separate `Bash` call the user approves) is what makes the unlock real. The trust is scoped to THIS workspace; granting in workspace A does NOT unlock workspace B. This closes the prompt-injection escalation surface where an agent could otherwise write a config and simulate being the owner.
   - "No / no estoy seguro — mantener el techo conservador" → `identity: auto` (default; user still has to set `WHATSAPP_OWNER_BYPASS=1` env if they want unlock, or pick "Sí" later)
   - "Soy un guest explícito — denegar siempre canales WA" → `identity: guest` (NO trust file needed — guest is a deny posture, no escalation surface)
   - "Cancel" → exit

4. **Background lane (dreams / indexer)?**
   - "Deny — never read scoped chunks in the dream lane (default, safest)" → `background.identity: deny` (NO trust file)
   - "System-owner — let the dream lane read as if owner (only if you control 100% of the channel and want full dream coverage)" → `background.identity: system-owner` AND step 6 will create the trust file just like the foreground `owner` case. Background `system-owner` without trust file silently degrades to deny in `resolveAllowed`, so the wizard MUST touch the file or the user gets surprising "no dream coverage" behavior.
   - "Cancel" → exit

4a. **¿Activar gate de ejecución?** (execution gate — separate from read scope; blocks destructive tools when the current turn was triggered by a non-owner inbound)
   - "Sí, recomendado — bloquear Bash y writes destructivos si un mensaje de un no-owner los dispara" → `execGate.mode: shadow` initially (will collect would-block events for review)
   - "Sí, modo enforce desde el principio (avanzado)" → `execGate.mode: enforce`
   - "No, dejar abierto (el agente puede ejecutar lo que sea aunque venga de un grupo)" → `execGate.mode: off`
   - "Cancel" → exit

4b. **¿Qué política?** (only if execGate mode is shadow/enforce)
   - "Denylist (recomendado) — bloquear solo tools destructivos (Bash, Write, Edit, MultiEdit, NotebookEdit, agent_config, skill_install/remove, dream)" → `execGate.policy: denylist`, `execGate.tools` omitted (defaults applied)
   - "Allowlist (estricto) — solo permitir tools de lectura/mensajería (Read, Grep, Glob, TodoWrite, WebFetch, WebSearch, reply, react, memory_search/get/context, voice_speak/transcribe)" → `execGate.policy: allowlist`, `execGate.tools` omitted (defaults applied)
   - "Cancel" → exit

4c. **¿Confiar este equipo para ejecutar tools cuando un no-owner mensaje vino del canal armado?** (only if execGate mode is shadow/enforce — this creates the `<channel>-exec` trust file, separate from the `<channel>-owner` read-scope trust file)
   - "Sí, soy el owner — confío en que este equipo puede ejecutar tools incluso cuando un mensaje de otro entró en el window de 60s" → step 6 will create a **per-workspace** exec trust file (as of 1.7.0) under `~/.claude/agent/scope-trust/<workspace-fingerprint>/<channel>-exec` via Bash. The exec-trust file is SEPARATE from the read-scope owner trust file (`<channel>-owner`) — having one does NOT imply the other. This is intentional: a user can read their own chats without granting the agent the right to run shell commands from non-owner-triggered turns. The trust is scoped to THIS workspace; if you have execGate enforce in multiple workspaces, you must opt-in to exec-trust in each one independently.
   - "No, dejar el gate firmado — bloquear cualquier no-owner-inducido tool destructivo hasta que cree el archivo manualmente" → no exec trust file. Useful when the user wants to observe shadow events first before deciding.
   - "Cancel" → exit

5. **Confirmation preview**: show a summary of the writes that will happen, AND a count of currently-visible channel chunks that would be filtered out under the chosen mode.

   To compute the count, call:

   ```
   Bash('node -e "const m=require(\"./lib/memory-db.ts\");const db=new m.MemoryDB(process.cwd(),[],{ headless:true,quietBoot:true});const n=db.countSyntheticChunksForChannel(\"whatsapp\");db.close();console.log(\"PREVIEW_COUNT=\"+n);"')
   ```

   Show the user: "Under the chosen mode, approximately N chunks from this channel would be filtered for non-owner queries (owner mode sees them all)."

   This is a preview — exact filtering depends on per-chat allowlists and is computed at query time.
   - The scope-policy writes go through `Bash` (a `node -e` one-liner that updates `agent-config.json`) because `agent_config(action='set')` refuses scope keys by design. The user gets one Bash permission prompt for the JSON edit.
   - If foreground `owner` OR background `system-owner` was chosen, an additional `Bash('mkdir -p && touch && chmod 600')` runs to create the trust file. Second permission prompt.
   - Explain in plain language: "El trust file es la prueba 'out-of-band' de que vos (no el agente vía MCP) declaraste ownership. Sin el archivo el unlock no aplica, aunque la config diga `identity: owner` o `background.identity: system-owner`. Las dos confirmaciones (config + trust file) son intencionales: cierran el agujero donde un agente prompt-inyectado podía escribir la config y simular ser owner."
   - Caveat to surface explicitly: "Si tenés Bash en auto-allow para esta sesión, el trust file se crea sin prompt — la protección depende de que aprobés cada Bash interactivamente. Si dudás, salí del wizard y corré los comandos a mano."
   - Confirm via `AskUserQuestion`:
     - "Apply" → run the `Bash` config edit + (conditionally) the trust-file touch + close with `status`
     - "Cancel" → exit, no changes

6. **Apply**: execute the calls in this order:
   - Single consolidated config write through Bash (because `agent_config(action='set')` refuses scope.* keys). Substitute `<channel>`, `<mode>`, `<identity>`, `<bg>`, `<egMode>`, `<egPolicy>` from the wizard answers:

     ```
     Bash('node -e "const fs=require(\"fs\"),p=\"agent-config.json\";const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,\"utf-8\")):{};c.scope=c.scope||{};const ch=\"<channel>\";const cur=c.scope[ch]||{};const bg=Object.assign({},cur.background,{identity:\"<bg>\"});const next=Object.assign({},cur,{mode:\"<mode>\",identity:\"<identity>\",accessJsonPath:cur.accessJsonPath||\"auto\",cwdExactMatchOnly:cur.cwdExactMatchOnly===true,background:bg});const eg=\"<egMode>\";next.execGate=eg===\"off\"?{mode:\"off\"}:{mode:eg,policy:\"<egPolicy>\"};c.scope[ch]=next;fs.writeFileSync(p,JSON.stringify(c,null,2));console.log(\"wrote\",p);"')
     ```

     Notes:
     - `cwdExactMatchOnly` preserves the prior value if the user had it `true` — never silently flipped to false.
     - `execGate.tools` is intentionally OMITTED so the resolver applies defaults (`DEFAULT_DENYLIST_TOOLS` / `DEFAULT_ALLOWLIST_TOOLS` from `lib/scope/exec-gate.ts`). If the user picked custom tools in a future wizard branch, set `next.execGate.tools = ["…"]` accordingly.
     - `execGate.mode = "off"` is ALWAYS written so `/agent:scope status` surfaces the explicit "currently off" state and a later wizard run can detect intent.
   - If `identity = "owner"` OR `background.identity = "system-owner"`, create the per-workspace owner trust file. As of 1.7.0 trust files live under a fingerprint subdir keyed by `realpath(workspaceRoot)` so trust in workspace A does NOT unlock workspace B. The bridge script computes the same hex the runtime uses — no Bash-side crypto reimplementation:

     ```
     Bash('set -euo pipefail; [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || { echo "CLAUDE_PLUGIN_ROOT unset"; exit 1; }; TS_HASH=$(node "$CLAUDE_PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs" "$CLAUDE_PLUGIN_ROOT/scripts/print-workspace-fingerprint.mjs" "$PWD"); [[ "$TS_HASH" =~ ^[0-9a-f]{32}$ ]] || { echo "bad TS_HASH=$TS_HASH"; exit 1; }; umask 077; DIR="$HOME/.claude/agent/scope-trust/$TS_HASH"; mkdir -p -- "$DIR"; chmod 700 -- "$DIR"; touch -- "$DIR/<channel>-owner"; chmod 600 -- "$DIR/<channel>-owner"; echo "trust file created: $DIR/<channel>-owner"')
     ```
   - If user opted to trust the machine for execGate (step 4c "Sí"), create the per-workspace exec trust file. SEPARATE trust file from the read-scope owner trust; agent cannot create either via MCP — both go through Bash + user permission prompt. The doctor row `scope-execgate-status` reflects trust validity (mode/uid/symlink checks), not just file presence:

     ```
     Bash('set -euo pipefail; [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] || { echo "CLAUDE_PLUGIN_ROOT unset"; exit 1; }; TS_HASH=$(node "$CLAUDE_PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs" "$CLAUDE_PLUGIN_ROOT/scripts/print-workspace-fingerprint.mjs" "$PWD"); [[ "$TS_HASH" =~ ^[0-9a-f]{32}$ ]] || { echo "bad TS_HASH=$TS_HASH"; exit 1; }; umask 077; DIR="$HOME/.claude/agent/scope-trust/$TS_HASH"; mkdir -p -- "$DIR"; chmod 700 -- "$DIR"; touch -- "$DIR/<channel>-exec"; chmod 600 -- "$DIR/<channel>-exec"; echo "trust file created: $DIR/<channel>-exec"')
     ```

7. After applying, run `status` to display the new state. Then ALSO surface the **first-run banner** to the user once, in their language:

   > **Scope active**. MCP-level filtering covers `memory_search`, `memory_get`, `memory_context`, `voice_transcribe`, dream promote, and `chat_inbox_read`. It does NOT cover native `Read`, `Grep`, or direct SQLite reads over channel log files — those bypass scope by design (MCP scope ≠ filesystem sandbox). If you want hard isolation, that lives at the OS / filesystem-permissions layer.

   Then also create a once-only marker so future wizard runs in this workspace don't repeat the banner:

   ```
   Bash('mkdir -p ~/.claude/agent && touch ~/.claude/agent/.scope-banner-shown')
   ```

   Skip the banner emission if `~/.claude/agent/.scope-banner-shown` already exists — the user has already seen it.

   Finally remind the user to `/mcp reconnect clawcode` for changes to take effect.

If invoked outside an interactive REPL session, abort with: "The wizard requires an interactive REPL — use `/agent:scope enable <channel> [shadow|enforce]` instead."

### Step 6 — `test <chatId>` (read-scope dry-run) and `test exec <senderJid> <toolName>` (execGate dry-run)

Show what a given chat-id (or sender+tool combo) would resolve to under the current scope config — read-only, no writes.

**Read-scope dry-run** (`test <chatId>`):

1. Parse `<chatId>` from `$ARGS`. If missing, prompt the user for one.
2. Call `mcp__clawcode__agent_config(action='get')` and pull `scope.<channel>` (default `whatsapp`).
3. Use Bash to run a dry-run probe:

   ```
   Bash('node -e "const r=require(\"./lib/scope/runtime.ts\");const c=require(\"./lib/config.ts\");const ctx=require(\"./lib/scope/context.ts\");const cfg=c.loadConfig(process.cwd());const rt=r.detectScopeRuntime(cfg,process.cwd());const adapter=r.getScopeAdapter(\"whatsapp\");if(!adapter){console.log(JSON.stringify({error:\"adapter not armed\",mode:cfg.scope?.whatsapp?.mode}));process.exit(0);}const c1=ctx.makeForegroundContext(\"dry-run\");const allowed=adapter.allowedChatIds(c1);const chatIdToTest=process.argv[1]||\"unknown\";const visible=allowed===null||allowed.includes(chatIdToTest);console.log(JSON.stringify({chatId:chatIdToTest,mode:rt.channels.whatsapp?.mode,armed:rt.channels.whatsapp?.armed,allowedShape:allowed===null?\"unrestricted (owner)\":allowed.length===0?\"deny-all (guest)\":\"partial (\"+allowed.length+\" chats)\",visible}));" "<chatId>"')
   ```

4. Surface the JSON output to the user in their language. Translate `visible: true` to "this chat WOULD be visible to the agent under the current scope" and `visible: false` to "this chat would be hidden". Add a line: "This is a dry-run — no config or memory state changed."

**ExecGate dry-run** (`test exec <senderJid> <toolName>`):

Show what the execution gate would decide for a given sender + tool combo. Useful for verifying allowlist/denylist semantics + hard-deny (Bash/Task) + trust file unlock before flipping shadow → enforce.

1. Parse `<senderJid> <toolName>` from `$ARGS`. If missing, prompt the user for both.
2. Invoke the real pure-function resolver (`lib/scope/exec-gate.ts:resolve`) with an injected envelope reader that returns a synthetic non-owner envelope. The resolver honors the actual trust-file check, hard-deny set (`Bash`, `Task`), and protected-paths logic.

   IMPORTANT: this snippet calls into `.ts` files directly so it MUST run under tsx, but invoking via `npx tsx` from the user's workspace cwd is unreliable (npx searches the local `node_modules/.bin` first and fetches from the registry on miss). Use the plugin-local tsx CLI explicitly via `node "$CLAUDE_PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs"`:

   ```
   Bash('node "$CLAUDE_PLUGIN_ROOT/node_modules/tsx/dist/cli.mjs" -e "
const eg = require(\"./lib/scope/exec-gate.ts\");
const c = require(\"./lib/config.ts\");
const r = require(\"./lib/scope/runtime.ts\");
const wa = require(\"./lib/scope/whatsapp.ts\");
const path = require(\"path\");

const cfg = c.loadConfig(process.cwd());
const senderJid = process.argv[1];
const toolName = process.argv[2];
const channel = \"whatsapp\";

const execGate = eg.execGateConfigForChannel(cfg.scope, channel);
const channelDir = r.resolveWhatsappChannelDir(cfg, process.cwd()) || \"\";
const ownerJids = [];
if (channelDir) {
  try {
    const access = wa.loadAccess(path.join(channelDir, \"access.json\"), new Map());
    if (access.resolvable && access.access) ownerJids.push(...(access.access.ownerJids || []));
  } catch {}
}

// Inject a fake envelope reader so the resolver \"sees\" the supplied senderId
// as an in-window non-owner inbound. recordShadow is a no-op for dry-run.
const fakeReader = {
  load: (cd, token, now) => ({
    version: 1, token,
    chatId: senderJid, senderId: senderJid,
    ts: now, expiresAt: now + 60000
  })
};
const fakeFs = {
  readdirSync: () => [\"dryrun.json\"],
  statSync: () => ({ isFile: () => true, mtimeMs: Date.now() })
};

const decision = eg.resolve({
  toolName,
  toolInput: toolName === \"Bash\" ? { command: \"dryrun\" } : {},
  pluginRoot: process.cwd(),
  workspaceRoot: process.cwd(),
  memoryDir: path.join(process.cwd(), \"memory\"),
  armed: [{ channel, channelDir: channelDir || \"/tmp/dryrun\", ownerJids, execGate }],
  reader: fakeReader,
  fsImpl: fakeFs,
  effects: { recordShadow: () => {} }
});

console.log(JSON.stringify({
  senderJid, toolName, channel,
  execGateMode: execGate.mode, policy: execGate.policy,
  ownerJidsKnown: ownerJids.length,
  isOwner: ownerJids.includes(senderJid),
  decision: decision.decision,
  reason: \"reason\" in decision ? decision.reason : null
}, null, 2));
" "<senderJid>" "<toolName>"')
   ```

3. Surface the JSON output. Translate `decision` to plain language (`allow` / `block` / `shadow`). Note: hard-deny tools (`Bash`, `Task`) block regardless of policy. Trust file `<channel>-exec` (if present + valid uid/mode) unlocks any non-owner-induced call. Add: "This is a dry-run — the resolver pure function was invoked but the hook subprocess was NOT spawned. To verify end-to-end including stderr surfacing, send a real test message from `<senderJid>` and observe the agent's response."

### Step 7 — `audit`

Pass-through to `mcp__clawcode__agent_doctor(action='check')`. Filter the doctor card to only the `scope-*` rows and surface them. Reference `docs/channel-scope-compat.md` for what each row means.

## Limitations

- **Owner unlock for WhatsApp**: set `scope.whatsapp.identity = "owner"` via wizard for declarative per-workspace unlock. The wizard also creates the out-of-band trust file `~/.claude/agent/scope-trust/<workspace-fingerprint>/whatsapp-owner` (Bash-prompted; per-workspace as of 1.7.0). Both are required: config alone does NOT unlock. `WHATSAPP_OWNER_BYPASS=1` env is an alternative escape-hatch. Without any of these, foreground calls hit the owner-only ceiling. Trust granted in one workspace does NOT unlock another workspace.
- **Per-chat binding for non-owner senders**: claude-whatsapp publishes a per-inbound `requestEnvelopeToken` in the MCP notification meta. The agent forwards the token to ClawCode memory tools, ClawCode validates the envelope file under `<channel-dir>/.request-envelopes/<token>.json` and emits a per-chat allowlist mirroring upstream `claude-whatsapp/scope.ts:scopedAllowedChats` byte-exact.
- **Residual risks (mirror of `docs/scope-envelope-contract.md` threat model, both kept in sync)**:
  - **Same-uid filesystem forge** (architectural, out of scope): any code running as your user can plant or tamper with channel-state files including the request envelope. The uid match check in the reader rules out cross-user tampering but not same-user adversaries. Scope is a privacy/safety layer between MCP tool calls and the agent, NOT a defense against OS-level adversaries already running as you.
  - **Token confusion across concurrent inbounds**: if two inbounds arrive within the 60s TTL, the agent holds two valid tokens. A prompt injection in inbound A could induce the agent to forward inbound B's token (leaking B's scope). Bounded by recent-inbound set + TTL; not closeable without per-tool-call authority binding.
  - **Within-TTL replay**: same token re-used within 60s by the same agent (required for multi-tool flows like `memory_search` → `memory_get`).
  - **Reply-egress taint**: once a snippet reaches the agent, voice/dream output is not taint-tracked.
- **MCP-level filtering ≠ filesystem sandbox**: native `Read`/`Grep`/SQLite over channel logs always bypass scope by design. If hard isolation is required, that lives at the OS layer.

## Reference

- `docs/channel-scope-compat.md` — full design doc + roadmap
- `docs/doctor.md` — `scope-pre-enforce-audit`, `scope-bypasses`, `scope-quarantine-pending`
- Plan: `~/.claude/plans/como-ves-poder-tener-agile-dove.md`
