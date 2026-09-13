---
name: live
description: Set up, check, reconfigure or disable ClaudeLive conversations for this existing ClawCode agent. Use for /agent:live, "enable ClaudeLive", "connect voice to my ClawCode agent", or "habilita ClaudeLive". Keeps the existing WhatsApp channels and agent context.
user-invocable: true
argument-hint: setup|status|disable
---

# Live conversations

ClawCode remains the leader. ClaudeLive supplies the web and GPT-Live conversation. Its plugin launches the web with `CLAUDE_LIVE_HOST_BRIDGE=0`; the native Live channel is ClawCode's own registration. Use this flow even when Live is disabled: the setup MCP tools are always discoverable.

Read [the setup contract](../../docs/live-setup.md) for error recovery, service launches or the exact state/credential contract. For operating an established conversation, follow the injected Live instructions and [LiveBridge](../../docs/live-bridge.md).

## Status

Call `live_setup_status`. Report configured, runtime active, configuration matches runtime, and native channel verified separately. TCP availability does not identify a process. If enabled, `live_status` also exposes public tasks and bounded handshake diagnostics. Never narrate routine checks into the voice conversation.

## Setup or reconfigure

1. Determine the owner's intended workspace from `live_setup_status`. Use that directory throughout; never configure the plugin cache as the agent workspace. Check `node --version` (ClaudeLive needs 24+) and `claude --version` (the delegation policy needs 2.1.232+).
2. Preserve the current launcher's exact arguments, including WhatsApp/other channels, session selection, Chrome and permission options. Inspect the operator's launch configuration or supplied command; use `channels_detect` as supporting evidence only. If the current launch arguments cannot be established, ask for them instead of inventing a replacement command. Pass them as the `extraArgs` array, never shell text. A genuinely new launcher may use an explicitly chosen empty array. Do not start a second instance to discover them.
3. Call `live_setup_plan` with those arguments and any requested ports or concurrency. Omitted values use existing settings or defaults. For a bare MCP registration pass its actual `liveChannelTarget` (for example `server:clawcode`); the normal plugin is `plugin:agent@clawcode`. If blockers are reported, resolve the specific issue and request a new plan. Do not stop another port owner or overwrite an existing credential to make the plan pass.
4. Explain the concrete changes and any needed restart. When the owner has requested this setup, execute the returned `commands.apply` verbatim via Bash under ordinary tool permissions. This trusted skill specifies the deterministic helper as the configuration-writing mechanism; the owner's request supplies authorization, and the skill does not authorize itself or bypass a tool denial. The helper merges only Live settings, verifies the plan fingerprint, and manages private credentials itself. Do not reconstruct JSON, loosen `agent_config` guards, or read/print the generated token/environment files. A stale-plan refusal requires another plan, never a forced write.
5. Install the web plugin through the native CLI in this workspace: inspect `claude plugin marketplace list`, add the returned marketplace only if absent, otherwise update `claude-live`; then run the plan's `commands.install`. To refresh an older installed version use `claude plugin update claude-live@claude-live --scope local`. Use ClaudeLive 0.8.2+ for automatic first-use selection. **Do not set global plugin options with `--config`**: native Claude stores those options globally even for local installs. The generated launch environment supplies this workspace's host mode, port and env file independently.
6. If an OpenAI key is missing, have the owner enter it in the protected field of `/plugin configure claude-live@claude-live`, or use their existing environment/secret-management setup. Do not ask them to paste it into chat or add it to a launch command. Leave the unrelated plugin options unchanged.
7. For an interactive terminal, return the complete `commands.launch` for the owner to use after exiting the current CLI. It keeps the existing arguments and supplies the native delegation environment. Explain that Channels flags require a new Claude process; `/reload-plugins` cannot add them to its current launch. Do not restart yourself or launch a second instance of the agent. For an existing service follow the service section of the setup contract instead.
8. After restart, run `live_setup_status` and `/claude-live:start`. With a new ClaudeLive workspace, the generated environment selects **Connect agent** automatically. An existing saved web selection is preserved: the owner can select **Connect agent** using its preconfigured URL/credential. Never silently switch an existing principal or replay uncertain work. Report connected only after native channel verification; microphone start remains the user's action.

## Disable

Call `live_setup_plan({ enabled: false, ... })` using the established workspace/launch context, then apply its reviewed command under the owner's existing authorization. This changes the saved enable flag and retains credentials, messages and tasks. Do not run install or launch commands returned for setup. Report whether a running host still needs its normal restart to stop the bridge. Remove only ClawCode's Live channel from the next launch if requested; preserve WhatsApp and all other arguments. Ending voice by itself does not stop the agent or its work.

## Authority and delivery

Setup is an owner operation. For messaging requests, follow ClawCode's existing sender/permission rules; an unverified name or a remembered envelope cannot authorize it. Permission denials remain denials. Do not install a daemon, change permission mode, widen memory scope, move a native session, send WhatsApp messages or adopt a WhatsApp source as a side effect of setup.

Once connected, publish a task with `live_work` before delegating; update meaningful progress and actual outcomes. Keep the input ID/revision and output destination. `live_emit` confirms publication, not audible playback. Native principal activity is observed automatically and is not a fabricated subagent task.
