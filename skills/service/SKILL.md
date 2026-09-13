---
name: service
description: Run the agent as an always-on background service (launchd on macOS, systemd on Linux). Triggers on /agent:service, /agent:service install, /agent:service status, /agent:service uninstall, /agent:service logs, "always-on", "background service", "correr 24/7", "run as daemon", "launchd", "systemd".
user-invocable: true
argument-hint: install|status|uninstall|logs
---

# Always-on service

Wrap the active runtime in the OS's service manager so ClawCode background work can continue after the terminal closes. Claude Code gets the historical long-running REPL service. Codex gets a one-minute runner for reminders, heartbeat, and dreaming.

This is an OPTIONAL feature. See `docs/service.md` for the full reference, risks, and how to add messaging-channel flags.

## Codex runtime path

If `CLAWCODE_RUNTIME=codex` or the runtime is OpenAI Codex, use `service_plan` normally. It returns a Codex-specific launchd/systemd plan that installs a one-minute runner for `bin/clawcode-codex-cron-runner.mjs`.

Safety copy for Codex install:

> This installs a background runner that uses `codex exec` for due ClawCode reminders, heartbeat, and dreaming. It runs with `--ask-for-approval never` and `--dangerously-bypass-approvals-and-sandbox`, so only install it for workspaces you trust.

For Codex, find the binary with `which codex`, pass it as `codexBin`, and do not pass Claude channel flags in `extraArgs`.

For Codex install/status/uninstall/logs, use the same confirmation and plan execution shape below, but skip Claude-specific prechecks such as `which claude` and `~/.claude/settings.json`.

## ⚠️ Safety — read before install

Installing the Claude Code service runs Claude Code with **`--dangerously-skip-permissions`** in the background. Installing the Codex runner runs `codex exec` with **`--ask-for-approval never`** and **`--dangerously-bypass-approvals-and-sandbox`**. These flags:

- Pre-approves every tool call (Bash, Write, Edit, network requests)
- Cannot be undone per-request — the running service/runner has full permissions over the agent's workspace for its whole lifetime
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
4. **Show the user the warning** (see Safety section). Ask explicitly: *"This will install a background service/runner with pre-approved tool execution. Confirm? [y/N]"*
5. If the user says no, stop with a neutral acknowledgement.
6. If the user confirms:
   - **Pre-check `~/.claude/settings.json`** (prevents the most common install hang — see `docs/service.md` "Heads-up" note):
     - Read the file with `Read(~/.claude/settings.json)`. If it doesn't exist or is empty, treat as `{}`.
     - If `skipDangerousModePermissionPrompt` is already `true`, skip to the next sub-step.
     - Otherwise, tell the user: *"Heads-up: your `~/.claude/settings.json` is missing `\"skipDangerousModePermissionPrompt\": true`. Without it, the service will show a 'Bypass Permissions — Do you accept?' dialog at startup that no daemon (launchd / systemd) can answer, and the install will appear to succeed but the service will hang silently. Add it now? [y/N]"*
     - If yes: merge with `jq` via Bash (preserves any other keys, atomic write):
       `Bash: jq '. + {"skipDangerousModePermissionPrompt": true}' ~/.claude/settings.json > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json`
       (If the file did not exist, first run `Bash: echo '{}' > ~/.claude/settings.json` so `jq` has something to merge into.) Confirm with one line: *"Added skipDangerousModePermissionPrompt: true to ~/.claude/settings.json."*
     - If no: warn explicitly *"Without it the service will hang at startup. Continue anyway? [y/N]"*. On a second `no`, abort with a neutral acknowledgement and do not write any service files. On `yes`, proceed and let the user deal with it.
   - If `plan.extraFiles` is present, for each entry: ensure the parent dir exists (`Bash(mkdir -p <dirname>)`), then `Write(file.path, file.content)`, then `Bash(chmod <octal> <file.path>)` using `file.mode` (default 0o644 when omitted). These are auxiliary scripts the unit file needs to exist before start — e.g. the resume-on-restart wrapper.
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
