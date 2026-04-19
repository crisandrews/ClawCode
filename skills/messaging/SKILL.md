---
name: messaging
description: Set up a messaging channel (WhatsApp, Telegram, Discord, iMessage, Slack) to reach this agent from outside Claude Code. Triggers on /agent:messaging, "configurar whatsapp", "setup messaging", "conectar telegram", "agregar canal".
user-invocable: true
argument-hint: [platform]
---

# Set Up a Messaging Channel

Guide the user through installing a messaging plugin so they can reach this agent from their phone or desktop.

**IMPORTANT — architectural limitation**: The agent CANNOT execute `/plugin marketplace add` or `/plugin install` — these are REPL-only commands. This skill SHOWS the user the exact commands to run, and guides them through the flow.

## Available platforms

| # | Platform | Marketplace | Launch flag | Notes |
|---|---|---|---|---|
| 1 | **WhatsApp** ⭐ | `crisandrews/claude-whatsapp` | `--dangerously-load-development-channels` | Rich access control, voice transcription (Whisper local), Baileys (unofficial WhatsApp Web API). Not on official allowlist. |
| 2 | **Telegram** | `anthropics/claude-plugins-official` | `--channels` | Official Bot API, pairing. Requires Bun + claude.ai login. |
| 3 | **Discord** | `anthropics/claude-plugins-official` | `--channels` | Official Bot API, requires bot creation + Message Content Intent. |
| 4 | **iMessage** | `anthropics/claude-plugins-official` | `--channels` | macOS only. Reads chat.db directly, no token. Needs Full Disk Access. |
| 5 | **Fakechat** (demo) | `anthropics/claude-plugins-official` | `--channels` | Localhost UI for testing the channel flow. No real platform. |

**Note**: Slack is NOT a channel plugin. See [Claude in Slack](https://code.claude.com/docs/en/slack) for the different integration model.

**Prerequisites for official channels** (Telegram/Discord/iMessage/Fakechat):
- Claude Code v2.1.80 or later
- [Bun](https://bun.sh) installed
- claude.ai login (API key auth is NOT supported for channels)
- Team/Enterprise: admin must enable channels in managed settings

## Steps

1. **Ask the user** which platform (unless specified in the argument). Default recommendation: WhatsApp.

2. **Check if the plugin is already installed**:
   ```bash
   ls ~/.claude/plugins/cache/ 2>/dev/null | grep -iE "whatsapp|telegram|discord|imessage|slack"
   ```
   If already installed, skip to the relaunch step.

3. **Show the EXACT commands from the plugin's README** (do not invent or simplify):

### WhatsApp — complete flow (from `crisandrews/claude-whatsapp` README)

**Prerequisites**: Node.js v18+

**Step 1 — Create a folder for the WhatsApp agent** (if not already in one):
```sh
mkdir ~/my-whatsapp-agent && cd ~/my-whatsapp-agent
claude
```

**Step 2 — Install the plugin** (inside Claude Code):
```
/plugin marketplace add crisandrews/claude-whatsapp
/plugin install whatsapp@claude-whatsapp
```
When prompted for scope, select **"Install for you, in this repo only (local scope)"** — isolates the agent to this folder.

**Step 3 — Exit and relaunch with the channel flag**:
```sh
/exit
```
Then from the terminal:
```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions
```

**Flag explanation**:
- `--dangerously-load-development-channels plugin:whatsapp@claude-whatsapp` — loads the whatsapp channel plugin
- `--dangerously-skip-permissions` — agent executes tools without asking for confirmation (recommended for smooth WhatsApp flow, otherwise every reply would need approval)

**First launch**: installs dependencies in the background (~60-90 seconds). Wait for the "dependencies installed" notification.

**Step 4 — Scan the QR code**:
```
/whatsapp:configure
```
Opens a QR code on screen. Scan from phone: WhatsApp → Settings → Linked Devices → Link a Device.

Session is saved to `.whatsapp/auth/` — you won't scan again unless you log out.

**Step 5 — Pair** (first-time contact):
Message your own WhatsApp number from another phone. It replies with a 6-character code. Then in Claude Code:
```
/whatsapp:access pair <code>
```

**Step 6 — Lock down access**:
```
/whatsapp:access policy allowlist
```
Now only approved contacts can reach the agent.

### Optional: autonomous mode with web browsing
For an agent that doesn't ask permission and can browse the web:
```sh
claude --dangerously-load-development-channels plugin:whatsapp@claude-whatsapp --dangerously-skip-permissions --chrome
```
The `--chrome` flag enables browser automation (via claude-in-chrome MCP).

### Optional: voice transcription

> When recommending these commands to a user, substitute `<lang>` with the language they're actually using in the conversation (e.g. `en`, `es`, `pt`). Do not default to `es`.

After the plugin is running:
```
/whatsapp:configure audio
```
Downloads local Whisper model (~77 MB) — no API keys needed, runs entirely on device. Whisper auto-detects the spoken language.

Optionally pin the language for better accuracy on short clips:
```
/whatsapp:configure audio <lang>
```
Supported: `en`, `es`, `pt`, `fr`, `de`, `it`, `ja`, `zh`, `ko`, `ar`, `ru`, `hi`.
Examples: `/whatsapp:configure audio en` (English), `/whatsapp:configure audio es` (Spanish), `/whatsapp:configure audio pt` (Portuguese).

### Optional: run as background service
See the README at https://github.com/crisandrews/claude-whatsapp for macOS launchd and Linux systemd examples.

---

---

### Telegram (official — complete flow from https://code.claude.com/docs/en/channels)

**Prerequisites**: [Bun](https://bun.sh) installed (`bun --version` to verify). Claude Code v2.1.80+. claude.ai login (API key auth not supported for channels).

**Step 1 — Create a Telegram bot**:
1. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`
2. Give it a display name and a unique username ending in `bot`
3. Copy the token BotFather returns

**Step 2 — Install the plugin**:
```
/plugin install telegram@claude-plugins-official
```
If "plugin not found", run `/plugin marketplace update claude-plugins-official` (or `/plugin marketplace add anthropics/claude-plugins-official` if never added). Then retry.

After installing: `/reload-plugins` to activate the configure command.

**Step 3 — Configure the token**:
```
/telegram:configure <token>
```
Saves to `~/.claude/channels/telegram/.env`. (Alternatively, set `TELEGRAM_BOT_TOKEN` in shell env before launching Claude Code.)

**Step 4 — Restart with channels enabled**:
```sh
/exit
```
```sh
claude --channels plugin:telegram@claude-plugins-official
```

**Step 5 — Pair account**:
- Send any message to your bot on Telegram
- Bot replies with a pairing code
- In Claude Code:
```
/telegram:access pair <code>
/telegram:access policy allowlist
```

---

### Discord (official — complete flow from https://code.claude.com/docs/en/channels)

**Prerequisites**: Same as Telegram (Bun, v2.1.80+, claude.ai login).

**Step 1 — Create a Discord bot**:
1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → name it
2. In **Bot** section: create username, click **Reset Token**, copy the token
3. Scroll to **Privileged Gateway Intents** → enable **Message Content Intent**

**Step 2 — Invite the bot to your server**:
1. Go to **OAuth2 → URL Generator**
2. Select scope: `bot`
3. Enable permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions
4. Open the generated URL to add bot to your server

**Step 3 — Install the plugin**:
```
/plugin install discord@claude-plugins-official
```
Then `/reload-plugins`.

**Step 4 — Configure the token**:
```
/discord:configure <token>
```
Saves to `~/.claude/channels/discord/.env`.

**Step 5 — Restart with channels**:
```sh
/exit
claude --channels plugin:discord@claude-plugins-official
```

**Step 6 — Pair account**:
- DM the bot on Discord
- Bot replies with pairing code
- In Claude Code:
```
/discord:access pair <code>
/discord:access policy allowlist
```

---

### iMessage (official, macOS only — from https://code.claude.com/docs/en/channels)

**Prerequisites**: macOS, Bun, Claude Code v2.1.80+, claude.ai login. No bot token or external service needed — reads Messages database directly, sends via AppleScript.

**Step 1 — Grant Full Disk Access**:
The Messages database at `~/Library/Messages/chat.db` is protected. On first launch, macOS prompts for access — click **Allow**. The prompt names the app that launched Bun (Terminal, iTerm, etc.).

If no prompt or you clicked "Don't Allow", grant manually: **System Settings → Privacy & Security → Full Disk Access** → add your terminal. Without this, server exits with `authorization denied`.

**Step 2 — Install the plugin**:
```
/plugin install imessage@claude-plugins-official
```
If "not found": `/plugin marketplace update claude-plugins-official` first.

**Step 3 — Restart with channels**:
```sh
/exit
claude --channels plugin:imessage@claude-plugins-official
```

**Step 4 — Text yourself**:
- Open Messages on any device signed into your Apple ID
- Send a message to yourself — reaches Claude immediately (self-chat bypasses access control)
- On first reply: macOS prompts to let terminal control Messages → click **OK**

**Step 5 — Allow other senders** (optional):
```
/imessage:access allow +15551234567
```
Handles are phone numbers (`+country` format) or Apple ID emails (`user@example.com`).

---

### Slack

Slack is NOT in the official channels list. If the user wants Slack, direct them to:
- [Claude in Slack](https://code.claude.com/docs/en/slack) — different integration model, uses Claude web sessions instead of channels
- This is NOT a plugin — it's configured via Slack app + claude.ai settings
- Refer to the docs, don't try to install it as a plugin

---

### Fakechat (demo for testing)

For quick testing without setting up any real platform:
```
/plugin install fakechat@claude-plugins-official
/exit
claude --channels plugin:fakechat@claude-plugins-official
```
Opens a chat UI at http://localhost:8787 — type messages, Claude replies back. Good for verifying the channel flow before setting up WhatsApp/Telegram/etc.

## How it works with ClawCode

- **Both plugins coexist** — each is an independent MCP server. No conflicts.
- **Your personality applies** — when a message arrives, you respond as yourself (from SOUL.md + IDENTITY.md), not as a generic Claude.
- **Formatting is automatic** — each messaging plugin injects its own format rules (e.g., WhatsApp uses `*bold*`, not `**bold**`).
- **Memory is shared** — what the user tells you via WhatsApp is saved to `memory/YYYY-MM-DD.md` just like in terminal.
- **Time commitments persist** — if the user requests a reminder, recurring task, or any future-time commitment via the messaging channel ("recordame en X", "remind me in X", "every Monday at X"), route it through the `crons` skill. It uses `bin/cron-from.sh` for deterministic time math and `CronCreate(durable: true)` so the cron survives session restarts. Never promise a reminder using `ScheduleWakeup` or verbal-only — see `skills/crons/SKILL.md` ⛔ FORBIDDEN block.

## Verifying the setup

After installing and relaunching:

1. Run `/mcp` — should show both `clawcode` and the messaging plugin as connected.
2. Send a test message from your phone.
3. The agent should respond with its personality (not generic Claude).
4. Ask `/status` in the chat — should show the agent's identity card.

## Index conversation logs in memory (recommended)

Messaging plugins log conversations to disk. These logs are valuable context that the agent should be able to search. ClawCode can index them automatically via `memory.extraPaths` in `agent-config.json`.

**IMPORTANT**: Only index `.md` log files, NOT `.jsonl`. Most plugins (including claude-whatsapp) write both formats — indexing both would duplicate content.

### Known log locations

| Plugin | Log path | Format |
|---|---|---|
| claude-whatsapp (local scope) | `./.whatsapp/logs/conversations/` | `.md` + `.jsonl` |
| claude-whatsapp (user scope) | `~/.claude/channels/whatsapp/logs/conversations/` | `.md` + `.jsonl` |

### Enable log indexing

After the messaging plugin is installed, add its log directory to `agent-config.json`:
```
agent_config(
  action='set',
  key='memory.extraPaths',
  value='["./.whatsapp/logs/conversations"]'
)
```

Then `/mcp` to reload. Next `memory_search` will find content from those conversations. Only `.md` files are indexed.

Log entries appear in search results with `extra:` prefix, e.g. `extra:conversations/2026-04-09.md`.

## Important reminders

- The agent cannot install plugins directly. Always show commands for the user to run.
- After installing a messaging plugin, the user MUST restart Claude Code with the `--dangerously-load-development-channels` flag.
- Verify with `/mcp` after relaunch.
- For WhatsApp, the first connection requires scanning a QR code — cannot be automated.
- Canonical reference: https://github.com/crisandrews/claude-whatsapp
