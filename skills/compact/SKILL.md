---
name: compact
description: Flush important session context to daily log (manual memory flush). Does NOT invoke native /compact. Triggers on /compact, /agent:compact, /flush, "guarda memoria", "flush".
user-invocable: true
---

# /compact — Manual memory flush

Save the important parts of the current conversation to `memory/YYYY-MM-DD.md`. This is a manual version of what the PreCompact hook does automatically.

## Important — architectural honesty

- **On CLI**: The native `/compact` compacts Claude Code's context. A skill CANNOT invoke it. If you run `/compact` in the REPL, the native one runs (and the PreCompact hook fires to save memory automatically). This skill is only useful if you want a MANUAL flush WITHOUT triggering actual compaction.
- **On messaging channels** (WhatsApp, Telegram, etc.): There is NO native compact. Each message is its own turn. This skill just saves the recent exchange to memory — useful as an explicit "save this" checkpoint.

This skill does NOT say "now run /compact" (that would cause a loop if the user pastes it again). It just saves and confirms.

## Steps

1. **Detect surface**.

2. **Scan the current session** for things worth remembering:
   - Decisions made
   - Facts the user shared
   - Tasks discussed
   - Problems solved

3. **Append to daily log**:
   ```bash
   DATE=$(date +%Y-%m-%d)
   TIME=$(date +%H:%M)
   ```
   
   ```markdown
   
   ## Manual flush (<TIME>)
   
   ### Decisions
   - ...
   
   ### Facts learned
   - ...
   
   ### Open items
   - ...
   ```

4. **Respond** briefly per surface:

### CLI
```
✅ Flush complete → memory/<DATE>.md

If you want Claude Code to also compact the context, run the native /compact.
(The PreCompact hook already saves memory automatically when that happens.)
```

### WhatsApp
```
✅ *Saved* → memory/<DATE>.md
```

### Telegram
```
✅ **Saved** → memory/<DATE>.md
```

**IMPORTANT**: Respond in the user's language. If the user writes in Spanish, translate these templates to Spanish on the fly. Do the same for any other language. The templates above are English defaults — adapt them.

5. **Do NOT** say "now run /compact" — that causes a loop. The user decides if they want to run the native command.

## Important

- APPEND-only.
- If nothing substantive to save, say so: "Nothing important to save right now" (or in user's language).
- The native `/compact` in CLI is the real compaction. This skill is just the memory-save part, usable independently.
- This is the agent-aware memory-flush equivalent.
