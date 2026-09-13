# Guided ClaudeLive setup

Available in ClawCode 1.8.0 from [PR #38](https://github.com/crisandrews/ClawCode/pull/38). Use ClaudeLive 0.8.2+ for automatic first-use selection of the external agent. Installing or merging code does not enable Live in an existing workspace.

## From the agent's conversation

Tell your ClawCode agent **“Enable ClaudeLive for this agent and keep WhatsApp”**, or run:

```text
/agent:live setup
```

Your ClawCode agent checks the workspace and current launcher, prepares a plan, and applies the requested configuration under its ordinary tool permissions. It installs the ClaudeLive web plugin locally and provides the complete restart command. No hand-written JSON or copied bridge token is needed. If the existing launch arguments cannot be determined, it asks for that command to preserve the session, channels, Chrome and permissions accurately.

Exit the current interactive Claude process, then use the generated command in the same directory. The owner must perform this restart: native Channels flags and background-subagent environment belong to the Claude process itself. Loading an MCP or `/reload-plugins` cannot add missing startup flags. Do not run the new command while another process still owns the same ClawCode agent session.

After restart:

```text
/agent:live status
/claude-live:start
```

The web opens in **Connect agent** automatically for a fresh ClaudeLive workspace. Previously saved selections remain authoritative; choose Connect agent once if this workspace was already using another mode. Existing work and uncertain deliveries are not replayed automatically. Start the microphone only after the native channel is verified.

An OpenAI API key is still required for GPT-Live. Use the protected OpenAI field in `/plugin configure claude-live@claude-live` or your existing environment/secret manager; never send it as a chat message. Node.js 24+ is required for ClaudeLive. Use Claude Code 2.1.251+ to include model-switch observation; the launcher's 2.1.232 minimum checks the background delegation policy only. See the [PostModelSwitch requirement](https://code.claude.com/docs/en/hooks#postmodelswitch).

## Setup contract

These two MCP tools are always available, including while Live is disabled or failed to start:

| Tool | Behavior |
| --- | --- |
| `live_setup_plan` | Read-only plan: current status, proposed port preflight, exact config/credential paths, blockers, warnings, plugin install and restart commands, and an opaque fingerprint. Options: `enabled`, `bridgePort`, `webPort`, `maxConcurrent`, `extraArgs`, `liveChannelTarget`. |
| `live_setup_status` | Read-only configuration and runtime diagnostics. Does not send a probe, replay work, install anything, or expose credentials. |

`extraArgs` is the existing Claude argument vector, not a shell string. The planner preserves it and adds the ClawCode Live channel. Missing arguments are explicitly marked unconfirmed; channel detection then produces suggestions, not a certified replacement for the existing launcher. The normal target is `plugin:agent@clawcode`; a bare MCP installation supplies its actual `server:<name>` registration.

The trusted Live skill applies `commands.apply` through the plugin's installed `scripts/live-setup.ts` helper. There is no MCP mutation tool and `agent_config` continues to refuse the privileged `liveBridge` subtree. The helper validates the fingerprint again before writing, merges only Live settings, preserves unrelated configuration and fails on malformed files. Normal permission and owner checks still apply.

The generated default policy is `host_native`: memory, skills, MCPs and WhatsApp retain their ordinary tools and permissions. Native background admission is configurable (default 3, or the existing configured value); the launch environment matches that setting. It is not a durable queue or a universal cap on resumed agents.

## Credentials and multiple agents

The helper creates/reuses these workspace-local files:

| Path | Purpose |
| --- | --- |
| `.clawcode-live/bridge.token` | Private bridge credential, mode 0600. |
| `.clawcode-live/claude-live.env` | Private web environment with the same credential and bridge URL. |
| `.clawcode-live/setup-owner.json` | Private ownership metadata and credential digest. |
| `agent-config.json` → `liveBridge.tokenFile` | Absolute path to the credential, never its value. |

The shared plain-Node credential reader is used by both the MCP server and native hooks. Explicit managed files must belong to the canonical workspace, be private regular files in a private directory, and cannot be symlinks or hardlinks. An invalid explicit file never falls back to an unrelated environment token. Legacy `tokenEnv` hosts remain supported; migration reuses the existing credential and refuses to rotate it silently when unavailable.

Claude Code stores plugin options globally even when installation scope is local. Consequently the guided installer does **not** write `--config` values. Its restart command supplies `CLAUDE_LIVE_HOST_BRIDGE=0`, `CLAUDE_LIVE_PORT` and this workspace's canonical `CLAUDE_LIVE_ENV_FILE` path, which take precedence over shared plugin options. It removes `CLAUDE_LIVE_BRIDGE_URL`, `CLAUDE_LIVE_BRIDGE_TOKEN` and `CLAUDE_LIVE_DEFAULT_MODE` from the new process environment so the protected file is authoritative. Use the complete generated command, including these unset operations; copying only its trailing `claude` arguments loses that workspace isolation. No credential is present in the command or tool response.

Give each simultaneous agent separate workspaces, web ports and bridge ports. The setup never terminates another port owner. The ClaudeLive plugin creates a web process owned by its CLI; ending voice alone preserves the agent's tasks, while exiting that CLI closes its owned web.

## Existing services

Setup writes configuration but never installs, replaces or restarts a launchd/systemd service. If the owner uses a service, preserve its existing arguments/options and use `/agent:service install` through that skill's existing service-consent flow. The generated service plan appends the opted-in ClawCode channel without replacing WhatsApp or other arguments. Its wrapper applies the managed web environment and delegation limit from workspace configuration.

The interactive setup does not add `--dangerously-skip-permissions`. The optional service flow has its own explicit permission-bypass behavior and authorization; requesting voice setup alone does not authorize enabling it.

## Reading status and recovering

| State | Meaning / next step |
| --- | --- |
| `configured` / `enabled` | Saved configuration exists / opts in. Neither proves execution. |
| `bridgeListener` / `webListener` | TCP availability only; another process could own that port. |
| `runtimeActive` | This ClawCode MCP actually owns a running bridge, when queried through MCP. |
| `configurationMatchesRuntime` | Saved settings match this running host; a changed port or policy requires restart. |
| `channelVerified` | Native probe ACK **and** matching native hook verified the leader. |
| `restartPending` | Saved enablement or configuration differs from the running host. |

The plan's `status` describes current configuration; `preflight` describes the proposed ports. CLI-only inspection has no native-session evidence and returns unknown where appropriate. An enabled bridge additionally exposes `handshake` through `live_status`: bounded initialization retries recover late native handler installation, stop after receipt ACK and never resend user work. `awaiting_hook` and `recovery_required` need their respective hook check or explicit owner session-recovery flow, not repeated acknowledgements.

If a fingerprint changed, request a fresh plan. If JSON, ownership, credential permissions or files are inconsistent, the helper refuses rather than overwriting them. Normal apply failures roll back newly created setup files and changed environment content. A process crash between multiple file writes can leave an incomplete setup requiring owner review; this is not a crash-atomic multi-file transaction. Never delete the whole `.clawcode-live` directory to fix setup: it also contains work and delivery state.

To disable:

```text
/agent:live disable
```

This saves `liveBridge.enabled=false` and keeps credentials/history/tasks. The running bridge stops after its normal operator-controlled restart. Remove only the Live channel from a future launcher if requested, preserving WhatsApp and the rest. A saved disablement is not proof that the old process has stopped.

## Verification limits

Automated tests exercise the real MCP server, native collector, private-file credentials, setup application and rollback, stale plans, listener identity, service launch environment and the actual ClaudeLive external adapter. No test sends WhatsApp, runs Claude inference or verifies human microphone playback. The real same-agent WhatsApp-to-voice pilot remains a separate acceptance step. Host cost reporting, remote model changes and remote permissions remain unsupported. See the [1.8.0 verification record](live-verification.md) for counts, reproduction commands and the exact limits.
