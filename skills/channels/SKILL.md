---
name: channels
description: Show messaging channel status (WhatsApp, Telegram, Discord, iMessage, Slack, Fakechat) and the launch command to load them. Triggers on /agent:channels, /agent:channels list, /agent:channels status, /agent:channels launch, "ver canales", "estado de canales", "cómo lanzo con whatsapp", "channel status", "messaging status".
user-invocable: true
argument-hint: list|status|launch
---

# Channels — messaging status + launch

Diagnose messaging channel plugins and give the user the exact command to load them. This skill does NOT install channels (use `/agent:messaging`) or authenticate them (per-channel skills like `/whatsapp:configure`) — it reports state and hands back a launch command.

This is a CORE feature. See `docs/channels.md` for details.

## Dispatch

| User says | Action |
|---|---|
| `/agent:channels` or `/agent:channels list` | Call `channels_detect({ format: "table" })` and print card |
| `/agent:channels status [<name>]` | Call `channels_detect({ format: "json" })`, filter by name if given, format single channel |
| `/agent:channels launch` | Call `channels_detect({ format: "launch" })` and print only the command |
| `/agent:channels launch --with-installed` | Call with `includeInstalledOnly: true` — includes installed-but-not-authenticated |
| `/agent:channels launch --skip-permissions` | Call with `skipPermissions: true` — adds the dangerous flag to the command (warn the user) |

## List flow

1. Call `channels_detect({ format: "table" })`
2. Print the returned text verbatim — it already has the table, next-steps hints, the launch command, and a **⚠️ Runtime** block when a channel server is up but not delivering inbound (see Runtime warnings below)
3. If any channels show `❌` under **Installed** and the user is new, remind: "Install a channel with `/agent:messaging <name>`"

## Status flow (single channel)

1. Call `channels_detect({ format: "json" })`
2. Find the entry where `name` matches (case-insensitive)
3. If not found, respond: *"I don't track a channel called `<name>`. Known channels: whatsapp, telegram, discord, imessage, slack, fakechat."*
4. Otherwise print a compact block:

```
📡 <label>
   kind:           <development|official|integration>
   installed:      <✅ | ❌>  (<detail>)
   authenticated:  <✅ | ❌ | ⏸️>  (<detail>)
   active:         <❓ | ❌>  (<detail>)
   next:           <setupHint>
```

5. If the entry has a `runtime` field, surface it — see Runtime warnings.

## Runtime warnings

The JSON entry may carry a `runtime` field read from the channel's live `status.json` (currently WhatsApp). When `runtime.problem` is `true`, the channel server is running but inbound is NOT reaching this session — the classic "I see 'typing…' on my phone but the agent never answers" failure, usually after an in-session update/reload or when a second session (interactive, service, or a still-alive scheduled-task session) holds the single-device lock.

When `runtime.problem` is true, do NOT report the channel as healthy. Lead with the warning, verbatim from `runtime.detail`, and then `runtime.remediation` if present. For example:

```
⚠️ WhatsApp inbound is NOT active in this session — another instance (PID <runtime.holderPid>) holds the single-device lock, so incoming messages go to that session, not this one.
Fix: <runtime.remediation>
```

Key `runtime.status` values: `idle_other_instance` (lock held by another session — the main one), `logged_out` (re-link needed), `lock_error` (filesystem/PID-file problem). Never tell the user to run `/whatsapp:configure reset` for `idle_other_instance` — it's a lock-ownership problem, not a link problem; the fix is to get down to one session and fully relaunch. See claude-whatsapp `docs/troubleshooting.md` → "You see 'typing…' but get no reply".

## Launch flow

1. Call `channels_detect({ format: "launch" })` (with the appropriate flags from the user's command)
2. Print the command in a code block
3. Remind the user: "This command is also what `/agent:service install` will use. Copy it or re-run the service install after any channel change."

If the user included `--skip-permissions`, ADD a warning above the command:

> ⚠️ The `--dangerously-skip-permissions` flag pre-approves every tool call. Use only for background/service runs.

## Response style

- CLI / WebChat: full table
- WhatsApp / Telegram / Discord: collapse to one line per channel using the icons, e.g. `📡 WhatsApp:✅✅❓ · Telegram:✅❌❌ · iMessage:✅✅❓`. The full table is too wide for mobile.

## Never

- Do NOT try to install or authenticate channels from this skill. Redirect to `/agent:messaging` or the channel's own skill.
- Do NOT lie about `active` state — the tool says `❓ unknown` when it can't tell. Pass that through; the user can verify with `/mcp` or by sending a message.
- Do NOT generate a launch command with `--skip-permissions` unless the user explicitly asked for it.

## References

- `docs/channels.md` — full reference
- `lib/channel-detector.ts` — pure detection logic
- `skills/messaging/SKILL.md` — channel installation
- `skills/service/SKILL.md` — always-on, consumes the launch command
