---
name: service
description: Run the agent as an always-on background service (launchd on macOS, systemd on Linux). Triggers on /agent:service, /agent:service install, /agent:service status, /agent:service uninstall, /agent:service logs, "always-on", "background service", "correr 24/7", "run as daemon", "launchd", "systemd".
user-invocable: true
argument-hint: install|status|uninstall|logs
---

# Always-on service

Wrap Claude Code (with ClawCode) in the OS's service manager so the agent keeps running after the terminal closes. This is what makes the HTTP bridge, WebChat, webhooks, and crons work 24/7.

This is an OPTIONAL feature. See `docs/service.md` for the full reference, risks, and how to add messaging-channel flags.

## ⚠️ Safety — read before install

Installing the service runs Claude Code with **`--dangerously-skip-permissions`** in the background. That flag:

- Pre-approves every tool call (Bash, Write, Edit, network requests)
- Cannot be undone per-request — the running service has full permissions over the agent's workspace for its whole lifetime
- Is necessary because a daemon cannot answer interactive tool-approval prompts

This is an **irrevocable trust decision for this workspace**. Only run `/agent:service install` if you understand that.

**Always prompt the user to confirm before installing.** Quote the flag by name in the confirmation. If the user hesitates or asks questions, stop and explain.

## Dispatch

Parse the action and call `service_plan` with it.

| User says | Action argument |
|---|---|
| `/agent:service install` | `install` |
| `/agent:service status` (or no arg) | `status` |
| `/agent:service uninstall` | `uninstall` |
| `/agent:service logs` | `logs` |

## Install flow

1. Find the `claude` binary: `Bash(which claude)`. Trim output. If empty, abort with: *"Can't find `claude` in PATH. Install Claude Code or point me at it manually."*
2. Call `service_plan({ action: "install", claudeBin: <path> })`
3. If the plan has `error` (unsupported OS), print the error and stop.
4. **Show the user the warning** (see Safety section). Ask explicitly: *"This will install a background service that runs with --dangerously-skip-permissions. Confirm? [y/N]"*
5. If the user says no, stop with a neutral acknowledgement.
6. If the user confirms:
   - Write the plist / unit file: `Write(filePath, fileContent)` — the plan tells you the path
   - Run each command from `plan.commands` in order with `Bash`, printing the label before each
   - If any command fails, stop and report the error (do NOT try to roll back — the user can run `uninstall` to clean up)
7. Final line: *"Service installed. Label: `<plan.label>`. Log: `<plan.logPath>`. Run `/agent:service status` to verify."*

## Status flow

1. Call `service_plan({ action: "status" })`
2. Run each command from `plan.commands` with `Bash`
3. Summarize in one line: "Active" / "Not loaded" / "Unknown" based on the command output

## Uninstall flow

1. Call `service_plan({ action: "uninstall" })`
2. Ask the user: *"Remove the `<plan.label>` service? [y/N]"*
3. On confirmation, run each command from `plan.commands`
4. Report: *"Service removed."*

## Logs flow

1. Call `service_plan({ action: "logs" })`
2. Run the single `tail` command and print output directly.

## Response style

- On CLI and WebChat: multi-line with labels.
- On messaging channels: compress to essentials. Command output can get long — if the log dump would exceed ~20 lines, just say "check `/tmp/clawcode-<slug>.log` directly" instead.

## Never

- **Never install the service without the safety confirmation.** If the user insists without reading the warning, say you need them to explicitly confirm the flag.
- Never run `launchctl` or `systemctl` commands that aren't in the plan returned by `service_plan` — the tool is the source of truth.
- Never modify the plist / unit file after creation from an imagined config. If the user wants to add channel flags, re-run `/agent:service install` with the updated flags (future: expose an `extraArgs` UX).

## References

- `docs/service.md` — full doc, risks, channel-flag customization
- `lib/service-generator.ts` — pure generators
- `docs/INDEX.md`
