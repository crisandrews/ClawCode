# ClawCode Feature Documentation

Master index of every capability. The agent reads this first when it needs to recall how something works. Always keep entries in sync with the code.

## Core (always available)

| Feature | Doc | Commands | MCP tools |
|---|---|---|---|
| Memory system | [memory.md](memory.md) | — | `memory_search`, `memory_get` |
| Active memory (turn-start reflex) | [memory-context.md](memory-context.md) | — | `memory_context` |
| Dreaming | [dreaming.md](dreaming.md) | `dream` tool | `dream` |
| Agent status | _(retro-doc pending)_ | `/agent:status`, `/status` | `agent_status` |
| Agent config | _(retro-doc pending)_ | `/agent:settings` | `agent_config` |
| Doctor | [doctor.md](doctor.md) | `/agent:doctor [--fix]` | `agent_doctor` |
| Config hot-reload | [config-reload.md](config-reload.md) | — (automatic) | — |
| Skill manager | [skill-manager.md](skill-manager.md) | `/agent:skill install\|list\|remove` | `skill_install`, `skill_list`, `skill_remove` |
| Command discovery | [command-discovery.md](command-discovery.md) | `/help` (uses it) | `list_commands` |
| Channels | [channels.md](channels.md) | `/agent:channels [list\|status\|launch]` | `channels_detect` |
| Hooks (lifecycle) | [hooks.md](hooks.md) | — (automatic) | — |

## Optional (user enables)

| Feature | Doc | Config key | Default | Notes |
|---|---|---|---|---|
| HTTP bridge | [http-bridge.md](http-bridge.md) | `http.enabled` | `false` | Local HTTP server for status, webhooks, skills |
| WebChat | [webchat.md](webchat.md) | `http.enabled` | `false` | Browser chat UI served by the HTTP bridge |
| Always-on service | [service.md](service.md) | — (installed via skill) | not installed | Run agent as launchd / systemd service 24/7 |
| Voice (TTS + STT) | [voice.md](voice.md) | `voice.enabled` | `false` | Speak text, transcribe audio — backends: sag, elevenlabs, openai-tts, say, whisper |
| QMD backend | [qmd.md](qmd.md) | `memory.backend: "qmd"` | builtin | External semantic search via qmd |

## Rules for agents

- **Before using a feature you're unsure about, read its doc file in this folder.**
- **If a user asks "what can you do?", scan this INDEX** for current capabilities — don't invent features that aren't here.
- **If a feature is marked optional + disabled**, say so honestly rather than pretending it works.

## Rules for contributors

- Every feature change must update its doc in the **same commit** as the code.
- New features add an entry here before merging.
- Removed features delete their doc and remove the entry here.
- "_(retro-doc pending)_" markers are a to-do, not a permanent state.
