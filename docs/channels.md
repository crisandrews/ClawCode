# Channels — messaging status and launch

Inspect which messaging channel plugins are installed, authenticated, and (heuristically) active, and get the exact `claude` launch command to load them together. Does not install channels, does not authenticate, does not restart Claude Code.

## When to use it

- You set up a messaging plugin and want to verify it'll load next time
- You forgot the long `--dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --channels plugin:telegram@...` incantation
- You're about to install the always-on service and need the correct command to wrap
- Something stopped working and you want to see what's missing

## Commands and tools

| Surface | Invocation | Effect |
|---|---|---|
| Slash (skill) | `/agent:channels` | Table of all channels + launch command |
| Slash (skill) | `/agent:channels status <name>` | Detail for one channel |
| Slash (skill) | `/agent:channels launch` | Only the launch command |
| Slash (skill) | `/agent:channels launch --with-installed` | Include installed-but-not-authenticated channels in the command |
| Slash (skill) | `/agent:channels launch --skip-permissions` | Append `--dangerously-skip-permissions` (warned) |
| MCP tool | `channels_detect({ format, includeInstalledOnly, skipPermissions })` | Programmatic |

## Channels tracked

| Name | Kind | Plugin id | OS |
|---|---|---|---|
| whatsapp | development | `plugin:whatsapp@claude-whatsapp` | any |
| telegram | official | `plugin:telegram@claude-plugins-official` | any |
| discord | official | `plugin:discord@claude-plugins-official` | any |
| imessage | official | `plugin:imessage@claude-plugins-official` | **macOS only** |
| slack | integration | — | any (uses Claude in Slack, not a plugin) |
| fakechat | development | `plugin:fakechat@fakechat` | any |

**Kinds explained:**

- **development** — loaded via `--dangerously-load-development-channels plugin:<id>`. Each flag carries one plugin.
- **official** — loaded via `--channels plugin:<id>`. Multiple plugins go in one comma-separated flag.
- **integration** — not a Claude Code channel plugin. Slack is an Anthropic-hosted integration (Claude in Slack) and doesn't use launch flags.

## Detection per field

| Field | How it's detected |
|---|---|
| Installed | `~/.claude/plugins/cache/` contains a directory whose name matches the channel's markers (e.g. `claude-whatsapp-*`) |
| Authenticated | Per-channel heuristic: WhatsApp/Telegram check for a session file; Discord checks env vars; iMessage checks `~/Library/Messages/chat.db` access; Slack and Fakechat report N/A |
| Active | Honest `unknown` — we cannot reliably inspect Claude Code's loaded channels from an MCP server. Confirm by sending a test message or running `/mcp` |
| OS supported | Compared against the channel's OS requirement (only iMessage is macOS-only today) |

## Icon key

| Icon | Meaning |
|---|---|
| ✅ | Yes |
| ❌ | No |
| ⏸️ | Not applicable (e.g. Slack doesn't auth locally) |
| ❓ | Unknown (active state can't be confirmed) |

## Launch command generation

The tool builds a single `claude` invocation from the detected state:

- By default, only channels that are **installed + authenticated** are included
- `--with-installed` also adds installed-but-not-authenticated (they'll load but fail at runtime — useful to debug)
- Development and official channels use different flags, handled automatically
- `--skip-permissions` is opt-in — never added silently

Example output:

```bash
claude \
  --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp \
  --dangerously-load-development-channels plugin:fakechat@fakechat \
  --channels plugin:telegram@claude-plugins-official,plugin:discord@claude-plugins-official
```

## Integration with always-on service

When you install the agent as a service (`/agent:service install`), that flow accepts an `extraArgs` list. The launch command this tool produces is the natural source. In v1 you need to wire them manually — run `/agent:channels launch`, copy the flags (minus the leading `claude`), and pass them when planning the service. A `--with-channels` convenience flag is on the roadmap.

## What this does NOT do

- **Doesn't install channels.** Use `/agent:messaging`.
- **Doesn't authenticate.** Use the per-channel skills (e.g. `/whatsapp:configure`).
- **Doesn't restart Claude Code.** You copy the command and run it.
- **Doesn't guess the `active` state.** If we can't tell, we say so.

## Implementation

| File | Role |
|---|---|
| `lib/channel-detector.ts` | Pure detection, static channel registry, launch command builder, table formatter |
| `server.ts` | `channels_detect` MCP tool |
| `skills/channels/SKILL.md` | Dispatch (`list` / `status` / `launch`) with platform-adapted output |

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Channel shows installed but not authenticated after successful setup | Auth artifact lives in a non-standard path | Open an issue or add the path to the channel's `authProbe` in `lib/channel-detector.ts` |
| Active is always `❓` | Expected — we can't detect loaded channels reliably | Confirm by sending a test message or opening `/mcp` |
| Launch command is empty | No channel is installed + authenticated | Install one with `/agent:messaging`, auth it, rerun |
| iMessage shows unsupported on macOS | Platform detection returned non-darwin (shouldn't happen) | `process.platform` must be `darwin` for macOS |
