---
name: usage
description: Show usage stats — agent memory stats + native Claude Code token usage. Triggers on /agent:usage, "uso del agente", "agent usage", "cuánto llevo gastado".
user-invocable: true
---

# Agent Usage

Show usage and consumption metrics combining agent-specific stats and session-level usage.

## Steps

1. **Call `agent_status` MCP tool** to get memory/dream stats.

2. **Check memory file sizes and counts**:
   ```bash
   du -sh memory/ 2>/dev/null
   find memory/ -name "*.md" ! -name ".*" 2>/dev/null | wc -l
   wc -c memory/MEMORY.md 2>/dev/null
   ```

3. **Check dream database size**:
   ```bash
   ls -la memory/.memory.sqlite 2>/dev/null
   wc -l memory/.dreams/events.jsonl 2>/dev/null
   ```

4. **Format the output**:

```
📊 Usage Stats

Memory:
  Total size: <du output>
  Files: <count>
  MEMORY.md: <bytes>
  SQLite index: <size>

Dream tracking:
  Events logged: <count>
  Unique memories: <from short-term-recall.json>

For token usage and cost: /usage or /cost (native)
For session stats: /status (native)
```

5. **Remind the user**:
   - `/usage` or `/cost` — native Claude Code token/cost info
   - `/stats` — more detailed native stats

## Notes

- This shows AGENT resource usage (memory, dreams, files).
- Token/API usage is session-level — use native `/usage`.
- If the memory directory is very large (> 500 MB), warn the user and suggest cleanup or archival.
