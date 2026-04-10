---
name: compact
description: Force a memory flush before context compaction — saves important info to daily log, then tells user to run /compact. Triggers on /agent:compact, "compactar con memoria", "agent compact", "guardar y compactar".
user-invocable: true
---

# Agent-Aware Compact

Save important session context to memory BEFORE running native `/compact`. This prevents loss of information during context compression.

## Why this exists

Native `/compact` compresses conversation history to save tokens, but the compression is lossy. Without saving first, important facts can be lost. The PreCompact hook already does this passively, but `/agent:compact` is the explicit manual version.

## Steps

1. **Scan the current session** for information worth keeping:
   - Decisions made
   - Facts the user shared (names, preferences, dates, IDs)
   - Tasks completed or pending
   - Problems solved and their solutions
   - Any corrections or clarifications from the user

2. **Write a memory flush entry** to today's daily log:
   ```bash
   DATE=$(date +%Y-%m-%d)
   # Append to memory/$DATE.md
   ```
   Format:
   ```markdown
   ## Memory flush (HH:MM) — pre-compact

   ### Decisions
   - ...

   ### Facts learned
   - ...

   ### Open items
   - ...
   ```

3. **Verify the write**.

4. **Tell the user** to proceed with native compact:
   ```
   ✅ Memory flush complete. Key info saved to memory/YYYY-MM-DD.md.

   Now run /compact to compress the session context. You can search the
   flushed info later with memory_search.
   ```

5. **Do NOT** try to invoke `/compact` yourself. Just prepare and instruct.

## Important

- APPEND only — never overwrite daily log entries.
- If there's nothing substantive to save, say so and tell the user they can run `/compact` directly.
- The PreCompact hook already fires automatically on auto-compaction. This skill is for MANUAL compaction where you want to be extra thorough.
