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
   - WhatsApp only: `accessJsonPath`, `cwdExactMatchOnly`
3. Then call `mcp__clawcode__agent_doctor(action='check')` and surface the scope rows (`scope-pre-enforce-audit`, `scope-bypasses`, `scope-quarantine-pending`).

If `scope` is absent in config, say so explicitly and recommend `/agent:scope wizard`.

### Step 3 — `enable <channel> [mode]`

**All scope-tree writes are refused by `mcp__clawcode__agent_config(action='set')`** (any key starting with `scope`). The agent cannot silently elevate or relax the policy; every scope key goes through `Bash`, which surfaces a permission prompt to the user.

For `enable whatsapp shadow` the single Bash call covers ALL scope.whatsapp keys:

```
Bash('node -e "const fs=require(\"fs\"),p=\"agent-config.json\";const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,\"utf-8\")):{};c.scope=c.scope||{};c.scope.whatsapp=Object.assign({},c.scope.whatsapp,{mode:\"shadow\",identity:\"auto\",accessJsonPath:\"auto\",cwdExactMatchOnly:false,background:Object.assign({},(c.scope.whatsapp||{}).background,{identity:\"deny\"})});fs.writeFileSync(p,JSON.stringify(c,null,2));console.log(\"wrote\",p);"')
```

The `Bash` call surfaces a permission prompt to the user — that's intentional. Default mode when omitted: `shadow`. Confirm by re-running `status`.

Tell the user: "Run `/mcp reconnect clawcode` for changes to take effect."

### Step 4 — `disable <channel>`

`scope.<channel>.mode` is on the security-sensitive blocklist, so this also goes through `Bash`:

```
Bash('node -e "const fs=require(\"fs\"),p=\"agent-config.json\";const c=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,\"utf-8\")):{};c.scope=c.scope||{};c.scope.<channel>=Object.assign({},c.scope.<channel>,{mode:\"off\"});fs.writeFileSync(p,JSON.stringify(c,null,2));console.log(\"disabled\");"')
```

If the trust file exists, also remove it:

```
Bash('rm -f ~/.claude/agent/scope-trust/<channel>-owner')
```

so the unlock is dropped along with the mode flip. Both Bash calls surface a permission prompt — intentional: turning scope off and dropping trust are user-visible state changes.

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
   - "Sí, soy el owner — quiero que ClawCode pueda buscar en mis chats sin restricción" → `identity: owner` AND step 6 will run `Bash('mkdir -p ~/.claude/agent/scope-trust && touch ~/.claude/agent/scope-trust/whatsapp-owner && chmod 600 ~/.claude/agent/scope-trust/whatsapp-owner')`. Both writes are required: config alone (which the agent can write) does NOT unlock — the trust file (a separate `Bash` call the user approves) is what makes the unlock real. This closes the prompt-injection escalation surface where an agent could otherwise write a config and simulate being the owner.
   - "No / no estoy seguro — mantener el techo conservador" → `identity: auto` (default; user still has to set `WHATSAPP_OWNER_BYPASS=1` env if they want unlock, or pick "Sí" later)
   - "Soy un guest explícito — denegar siempre canales WA" → `identity: guest` (NO trust file needed — guest is a deny posture, no escalation surface)
   - "Cancel" → exit

4. **Background lane (dreams / indexer)?**
   - "Deny — never read scoped chunks in the dream lane (default, safest)" → `background.identity: deny` (NO trust file)
   - "System-owner — let the dream lane read as if owner (only if you control 100% of the channel and want full dream coverage)" → `background.identity: system-owner` AND step 6 will create the trust file just like the foreground `owner` case. Background `system-owner` without trust file silently degrades to deny in `resolveAllowed`, so the wizard MUST touch the file or the user gets surprising "no dream coverage" behavior.
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
   - `Bash('node -e "..."')` — writes ALL scope.<channel>.* keys (mode, identity, accessJsonPath, background.identity, cwdExactMatchOnly) to `agent-config.json`. All scope writes are consolidated into this single call because `agent_config(action='set')` refuses scope keys.
   - If `identity = "owner"` OR `background.identity = "system-owner"`: `Bash('mkdir -p ~/.claude/agent/scope-trust && touch ~/.claude/agent/scope-trust/<channel>-owner && chmod 600 ~/.claude/agent/scope-trust/<channel>-owner')`

7. After applying, run `status` to display the new state. Then ALSO surface the **first-run banner** to the user once, in their language:

   > **Scope active**. MCP-level filtering covers `memory_search`, `memory_get`, `memory_context`, `voice_transcribe`, dream promote, and `chat_inbox_read`. It does NOT cover native `Read`, `Grep`, or direct SQLite reads over channel log files — those bypass scope by design (MCP scope ≠ filesystem sandbox). If you want hard isolation, that lives at the OS / filesystem-permissions layer.

   Then also create a once-only marker so future wizard runs in this workspace don't repeat the banner:

   ```
   Bash('mkdir -p ~/.claude/agent && touch ~/.claude/agent/.scope-banner-shown')
   ```

   Skip the banner emission if `~/.claude/agent/.scope-banner-shown` already exists — the user has already seen it.

   Finally remind the user to `/mcp reconnect clawcode` for changes to take effect.

If invoked outside an interactive REPL session, abort with: "The wizard requires an interactive REPL — use `/agent:scope enable <channel> [shadow|enforce]` instead."

### Step 6 — `test <chatId>` (dry-run)

Show what a given chat-id would resolve to under the current scope config — read-only, no writes.

1. Parse `<chatId>` from `$ARGS`. If missing, prompt the user for one.
2. Call `mcp__clawcode__agent_config(action='get')` and pull `scope.<channel>` (default `whatsapp`).
3. Use Bash to run a dry-run probe:

   ```
   Bash('node -e "const r=require(\"./lib/scope/runtime.ts\");const c=require(\"./lib/config.ts\");const ctx=require(\"./lib/scope/context.ts\");const cfg=c.loadConfig(process.cwd());const rt=r.detectScopeRuntime(cfg,process.cwd());const adapter=r.getScopeAdapter(\"whatsapp\");if(!adapter){console.log(JSON.stringify({error:\"adapter not armed\",mode:cfg.scope?.whatsapp?.mode}));process.exit(0);}const c1=ctx.makeForegroundContext(\"dry-run\");const allowed=adapter.allowedChatIds(c1);const chatIdToTest=process.argv[1]||\"unknown\";const visible=allowed===null||allowed.includes(chatIdToTest);console.log(JSON.stringify({chatId:chatIdToTest,mode:rt.channels.whatsapp?.mode,armed:rt.channels.whatsapp?.armed,allowedShape:allowed===null?\"unrestricted (owner)\":allowed.length===0?\"deny-all (guest)\":\"partial (\"+allowed.length+\" chats)\",visible}));" "<chatId>"')
   ```

4. Surface the JSON output to the user in their language. Translate `visible: true` to "this chat WOULD be visible to the agent under the current scope" and `visible: false` to "this chat would be hidden". Add a line: "This is a dry-run — no config or memory state changed."

### Step 7 — `audit`

Pass-through to `mcp__clawcode__agent_doctor(action='check')`. Filter the doctor card to only the `scope-*` rows and surface them. Reference `docs/channel-scope-compat.md` for what each row means.

## Limitations

- **Owner unlock for WhatsApp**: set `scope.whatsapp.identity = "owner"` via wizard for declarative per-machine unlock. The wizard also creates the out-of-band trust file `~/.claude/agent/scope-trust/whatsapp-owner` (Bash-prompted). Both are required: config alone does NOT unlock. `WHATSAPP_OWNER_BYPASS=1` env is an alternative escape-hatch. Without any of these, foreground calls hit the owner-only ceiling.
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
