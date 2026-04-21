# Run ClawCode on Windows via WSL2

ClawCode is a Claude Code plugin. Claude Code runs in a Unix shell. WSL2 gives you a real Linux shell inside Windows, so from ClawCode's point of view it's just "on Linux" — there are no ClawCode-specific Windows steps. Install WSL2, drop into the Ubuntu shell, and follow the normal README from there.

## 1. Install WSL2 + Ubuntu

In an elevated PowerShell:

```powershell
wsl --install -d Ubuntu-22.04
```

Reboot if prompted. On first launch of Ubuntu, set a Linux username and password.

Confirm systemd is running (default on Ubuntu 22.04+):

```sh
systemctl --user is-system-running
```

Expected output: `running` or `degraded`. If you get `offline`, see Troubleshooting below.

For anything deeper on WSL itself, see Microsoft's [WSL docs](https://learn.microsoft.com/en-us/windows/wsl/).

## 2. Install dependencies inside WSL2

From the Ubuntu shell:

```sh
sudo apt update && sudo apt install -y nodejs npm jq git
```

Node must be ≥ 18. If `node --version` reports older, install a current LTS from [NodeSource](https://github.com/nodesource/distributions).

## 3. Install Claude Code and ClawCode

From this point on, follow the main [README](../README.md#quick-setup) — nothing here is Windows-specific:

```sh
mkdir ~/my-agent && cd ~/my-agent
claude
```

Inside Claude Code:

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install clawcode@claude-community
/agent:create
```

## 4. Always-on service

`/agent:service install` writes a systemd user unit at `~/.config/systemd/user/clawcode-<slug>.service`. Check it:

```sh
systemctl --user status clawcode-<slug>
```

To keep the service alive across logout (useful on WSL2, since closing all shells otherwise stops the user instance):

```sh
sudo loginctl enable-linger $USER
```

See [service.md](service.md) for the full explainer and command reference.

## What works

Everything core:

- Memory, dreaming, doctor, identity
- HTTP bridge, WebChat, webhooks
- Messaging: WhatsApp, Telegram, Discord, Slack, Fakechat
- Voice: ElevenLabs, OpenAI TTS/Whisper, `sag`, local whisper-cli, hf-whisper
- Watchdog, service, crons, hooks, SessionStart reconciliation

## What doesn't

- **iMessage** — macOS-only by design. The channel reads `~/Library/Messages/chat.db`, which doesn't exist on Linux. `channels_detect` reports it as unavailable with an OS-mismatch reason; this is expected.
- **macOS `say` TTS backend** — auto-skipped when `process.platform !== "darwin"`. Use ElevenLabs or OpenAI TTS instead; the voice chain falls through automatically.
- **GUI / computer-use skills** — need WSLg (Windows 11) or a third-party X server (Windows 10). ClawCode core does not depend on this; install it only if a specific skill requires a browser or GUI.

## Caveat: memory.extraPaths auto-indexing

Same limitation as native Linux (not WSL2-specific): `fs.watch` does not recurse on Linux, so files added into nested subdirectories under a configured `memory.extraPaths` entry are not auto-indexed. Only top-level files trigger updates. See [memory.md — Live updates and the Linux caveat](memory.md#live-updates-and-the-linux-caveat).

Workaround: run `/agent:doctor --fix` after adding nested files to force a re-index.

## Troubleshooting

**`systemctl --user` says `offline` or `Failed to connect to bus`.**

Enable the user systemd instance, then logout/login:

```sh
sudo systemctl enable --now user@$UID
```

After this, `systemctl --user is-system-running` should return `running`.

**Service log says `claude: not found` after install.**

The unit's `ExecStart` couldn't resolve `claude` on PATH. Pass the absolute path explicitly:

```sh
which claude
# e.g. /home/you/.nvm/versions/node/v20.11.0/bin/claude

/agent:service install claudeBin=/home/you/.nvm/versions/node/v20.11.0/bin/claude
```

Then `systemctl --user restart clawcode-<slug>`.
