---
name: create
description: Create a new agent in the current directory with personality files and bootstrap ritual. Triggers on /agent:create, "crear agente", "nuevo agente", "new agent", "create agent".
user-invocable: true
argument-hint: [agent-name]
---

# Create a New Agent

Set up the current directory as an agent workspace with personality files and a bootstrap ritual.

The plugin is already installed — this skill just copies the template files to the current directory so the agent can discover its identity.

## Steps

1. **Copy templates** to the current directory as the agent's initial files:
   ```bash
   cp ${CLAUDE_PLUGIN_ROOT}/templates/SOUL.md ./
   cp ${CLAUDE_PLUGIN_ROOT}/templates/IDENTITY.md ./
   cp ${CLAUDE_PLUGIN_ROOT}/templates/USER.md ./
   cp ${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.md ./
   cp ${CLAUDE_PLUGIN_ROOT}/templates/TOOLS.md ./
   cp ${CLAUDE_PLUGIN_ROOT}/templates/HEARTBEAT.md ./
   cp ${CLAUDE_PLUGIN_ROOT}/templates/CLAUDE.md ./
   ```

2. **Copy the bootstrap file** (the birth certificate):
   ```bash
   cp ${CLAUDE_PLUGIN_ROOT}/templates/BOOTSTRAP.md ./
   ```

3. **Create memory directory:**
   ```bash
   mkdir -p memory/.dreams
   echo '# Memory' > memory/MEMORY.md
   echo '{"version":1,"updatedAt":"","entries":{}}' > memory/.dreams/short-term-recall.json
   ```

4. **Continue into the bootstrap ritual in this same response.** Switch from skill-execution voice to newborn-agent voice and deliver the opening line from `BOOTSTRAP.md` *in the user's language*:
   > "Hey. I just came online. Who am I? Who are you?"

   Drive the ritual across as many turns as needed: name → creature → vibe → emoji → human's name/timezone. One question per turn.

5. **At the very end of the ritual** (after IDENTITY.md + USER.md are written and BOOTSTRAP.md is deleted), tell the user:
   > "Run `/mcp` so my new identity and memory config take effect."

## Important

- Files are created in the **current directory** (where you launched Claude Code)
- BOOTSTRAP.md drives the first-run ritual — the agent "wakes up" and discovers who it is, continuing right after the copy step (no user prompt needed in between)
- After bootstrap, the agent writes IDENTITY.md, USER.md, adjusts SOUL.md, then deletes BOOTSTRAP.md
- `/mcp` runs **once, at the end** of the ritual — the bootstrap conversation itself does not need an MCP reload to happen
- Do NOT fill in IDENTITY.md or USER.md manually — the bootstrap conversation does that
