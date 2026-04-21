# Run ClawCode on Windows via WSL2

ClawCode is a Claude Code plugin. Its Linux code paths (systemd service, memory DB, voice, messaging, hooks) expect a real Unix shell, so ClawCode needs Claude Code running **inside a WSL2 Linux distro** — not Claude Code running natively on Windows in PowerShell or cmd.

If you already have Claude Code on native Windows you don't have to uninstall it. The two installs (native + WSL2) coexist fine; ClawCode just lives in the WSL2 one.

## Where is your Claude Code running right now?

In the terminal where you launched `claude`, run:

```sh
uname -a
```

- **Output contains `Linux … microsoft … WSL2`** → you're already inside WSL2. Your deps and Claude Code install in WSL2 may already be fine — skim steps 2-3 to verify, then go straight to step 4.
- **`uname` not found, or output looks like Windows version info** → your Claude Code is running on native Windows. Follow steps 1-4 to set up a second Claude Code install inside WSL2.

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

Node must be ≥ 18. If `node --version` reports older, install a current LTS from [NodeSource](https://github.com/nodesource/distributions) or use [nvm](https://github.com/nvm-sh/nvm).

## 3. Install Claude Code inside WSL2

Still in the Ubuntu shell:

```sh
npm install -g @anthropic-ai/claude-code
```

If you hit `EACCES` permission errors, either prefix with `sudo` or configure a user-global npm prefix: `npm config set prefix ~/.npm-global` and add `~/.npm-global/bin` to your `PATH`. `nvm`-managed Node installs don't need sudo.

Confirm:

```sh
claude --version
```

This Claude Code install is independent from any you have on native Windows — they coexist.

## 4. Install ClawCode

From here the main [README](../README.md#quick-setup) applies unchanged:

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

## 5. Always-on service

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

Same limitation as native Linux (not WSL2-specific): `fs.watch` does not recurse on Linux, so files added into nested subdirectories under a configured `memory.extraPaths` entry are not auto-indexed. Only top-level files trigger updates. See the `extraPaths` section of [memory.md](memory.md).

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
