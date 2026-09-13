# Codex Compatibility

This fork adds an OpenAI Codex packaging layer for ClawCode.

## Status

Supported under Codex:

- Codex plugin manifest (`.codex-plugin/plugin.json`)
- Local Codex marketplace manifest (`.agents/plugins/marketplace.json`)
- ClawCode MCP server over stdio
- Workspace memory tools: `memory_search`, `memory_get`, `memory_context`
- Agent config/status/doctor tools
- Manual `dream` runs
- Registry-backed reminders and dreaming through the ClawCode Codex runner
- Voice and WebChat tools when configured
- Skill listing/install/remove with Codex-aware skill paths
- Service planning for macOS launchd and Linux systemd timers

Claude Code-specific surfaces are kept separate:

- Claude Code channel launch flags
- Claude Code messaging plugins such as `claude-whatsapp`
- Native Claude Code cron tools (`CronCreate`, `CronList`, `CronDelete`)
- Claude Code always-on service mode (`claude --continue`)
- Plugin-packaged lifecycle hooks under Codex

Codex uses its own adapters instead of those Claude Code APIs. In particular,
`/agent:crons` writes `memory/crons.json`, and `/agent:service install` creates
a one-minute launchd/systemd timer that runs `bin/clawcode-codex-cron-runner.mjs`
with `codex exec`.

## Local Install

From this repository root:

```sh
codex plugin marketplace add "$(pwd)"
codex plugin add clawcode@clawcode-local
```

Then restart Codex.

For development without installing the plugin, register the MCP server with an
explicit workspace:

```sh
CLAWCODE_RUNTIME=codex \
CLAWCODE_WORKSPACE=/absolute/path/to/agent-workspace \
bash ./bin/clawcode-mcp.sh
```

Codex should normally provide `CODEX_HOME`. If it does not expose the project
directory to MCP servers, set `CLAWCODE_WORKSPACE` in the MCP config so memory
is stored in the intended agent workspace rather than the plugin directory.

## Runtime Paths

Under Codex:

- User skills: `$CODEX_HOME/skills` or `~/.codex/skills`
- Project skills: `<workspace>/.codex/skills`
- Agent memory: `<workspace>/memory`
- Codex runner state: `<workspace>/memory/.codex-cron-runner-state.json`

Under Claude Code, existing `.claude` paths are preserved.
