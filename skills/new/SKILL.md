---
name: new
description: Start a new session — saves current context to memory first, then tells user to run /clear. Triggers on /agent:new, "nueva sesión", "new session", "empezar de nuevo", "reiniciar".
user-invocable: true
---

# Start a New Session

Save important context from the current session to memory, then prepare for a fresh session.

## Why this exists

Claude Code's native `/clear` drops all conversation context. If you just run `/clear`, the agent forgets everything that happened this session. `/agent:new` saves what matters first.

## Steps

1. **Summarize the current session** — what was discussed, decisions made, tasks completed, open items. Be concise (5-15 bullet points).

2. **Write the summary to today's daily log**:
   ```bash
   DATE=$(date +%Y-%m-%d)
   # Append to memory/$DATE.md (create if doesn't exist)
   ```
   Format:
   ```markdown
   ## Session summary (HH:MM)

   - <bullet 1>
   - <bullet 2>
   - ...

   ### Open items
   - <pending thing>
   ```

3. **Verify the write** succeeded (cat the file).

4. **Tell the user** what was saved and give the next step:
   ```
   Session summary saved to memory/YYYY-MM-DD.md.

   Now run /clear to start a fresh session. Your next session will
   still remember this via memory_search.
   ```

5. **Do NOT** try to invoke `/clear` yourself — you can't. Just tell the user.

## Important

- If the session was trivial (just a greeting), skip the summary and just say "nothing important to save, go ahead and /clear".
- Respect APPEND-only — never overwrite existing entries in the daily log.
- This is the agent-aware version of `/clear`. It does the memory work first.
