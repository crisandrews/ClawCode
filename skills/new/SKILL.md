---
name: new
description: Start a new session — save summary to memory, then mark as reset so next message gets a fresh greeting. OpenClaw-compatible. Triggers on /new, /reset, /agent:new, "nueva sesión", "new session", "reset".
user-invocable: true
---

# /new — Start a new session

Save the current session to memory, then mark it as "reset pending" so the next message triggers a fresh greeting (like OpenClaw).

## How this works (architecture)

OpenClaw's `/new` generates a new session ID and runs a greeting prompt on the next turn. In Claude Code, skills CANNOT invoke native `/clear`. Instead, we:

1. **Save** the current session to `memory/YYYY-MM-DD.md`
2. **Write a marker** `.session-reset-pending` with the greeting prompt
3. **Respond** with a brief "new session" acknowledgement
4. **On the next message**, the agent detects the marker, delivers the greeting, deletes the marker

This is the honest simulation of a session reset when native `/clear` is not invokable.

## Steps

1. **Detect surface** (CLI vs messaging).

2. **Summarize the current session** to memory:
   ```bash
   DATE=$(date +%Y-%m-%d)
   TIME=$(date +%H:%M)
   ```
   
   Append to `memory/$DATE.md`:
   ```markdown
   
   ## Session summary (<TIME>) — before /new
   
   - <key point>
   - <key point>
   
   ### Open items
   - <pending>
   ```
   
   If the session was trivial, skip this step but still do the next one.

3. **Write the reset marker**:
   ```bash
   cat > .session-reset-pending << 'EOF'
   A new session was started via /new or /reset. Greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.
   EOF
   ```
   
   (This is the EXACT prompt from OpenClaw's session-reset-prompt.ts)

4. **Respond** briefly per surface:

### CLI
```
🔄 New session started. Summary saved to memory/<DATE>.md.

Send a message to receive the welcome greeting.
(Or if you also want to clear the REPL context, run /clear afterward.)
```

### WhatsApp
```
🔄 *Session reset*. Send a message and I'll greet you again 👋
```

### Telegram
```
🔄 **Session reset.** Send a message to get the fresh greeting.
```

**IMPORTANT**: Respond in the user's language. The templates above are English defaults — translate on the fly to match the user (Spanish, Portuguese, French, whatever they speak).

5. **Do NOT** invoke `/clear` — you can't. The marker file handles the "fresh start" on the next message.

## On the NEXT message

When the user sends their next message, you will see `.session-reset-pending` in the workspace. If it exists:

1. **Read** the marker contents — that's the greeting prompt
2. **Follow it** — greet the user in your configured persona, 1-3 sentences, ask what they want to do
3. **Delete** `.session-reset-pending`
4. **Then handle** the user's actual message (if they said more than just a greeting trigger)

This makes `/new` feel like a real session reset, even though technically Claude Code's context still has prior turns.

## Important

- APPEND-only to daily logs, never overwrite.
- The marker file is the key mechanism — it lets the NEXT turn deliver the greeting.
- On CLI, the user can additionally run `/clear` to wipe REPL context if desired.
- This is the OpenClaw-parity implementation of `/new`.
