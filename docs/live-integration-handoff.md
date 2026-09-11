# Integrating Live voice and the conversational leader

Review and integration handoff for [PR #38](https://github.com/crisandrews/ClawCode/pull/38). The PR targets `main`; its branch is `feat/live-voice-bridge`. The conversational policy builds on native continuity commit `11362a596f0619b176088bc436d5b9e7b0341f75` in that same PR. No daily Cloudy installation has been changed or restarted.

## What this PR changes

ClawCode remains the sole owner of the existing Claude session. LiveBridge adds authenticated HTTP/SSE input, public progress, task cards and explicit delivery receipts to that leader. It preserves native session binding, recovery review, task identities and opt-in owner source adoption.

The optional `liveBridge.leaderPolicy` adds a native `PreToolUse` guard. The principal retains dialogue, coordination and exact Live/WhatsApp reply tools; it delegates operational tools to native background subagents. The guard returns a deny decision or passes through to normal permissions. It never approves a tool, widens memory scope, or removes the existing guest execution gate. Workers are identified by native `agent_id` and retain their normal capabilities and checks.

The generated launcher requires Claude Code 2.1.232 or later for this policy and sets `CLAUDE_CODE_FORK_SUBAGENT=1` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. Conflicting background-disabled configuration is rejected before launch. New installs and existing services with the option absent keep their prior behavior.

## Review from the ClawCode repository

```sh
git fetch origin feat/live-voice-bridge
git switch --create review/live-voice-bridge origin/feat/live-voice-bridge
npm install
npm run test:live
npm run build:hook
npm test
```

Use the PR diff to review `lib/live-*`, `lib/host-session.ts`, `lib/service-generator.ts`, the opt-in configuration and native hooks. Review the existing scope gate regression separately from the new conversational restriction. ClaudeLive vendors the shared bridge and pure policy helper; changed relative imports are the only intended source differences.

The tests use isolated workspaces, synthetic native events and generated launcher processes. They do not send WhatsApp, enable a daily service, or certify human voice interaction. ClaudeLive additionally validates the managed native callback against a real isolated Claude process; that is evidence for the managed mode, not the Cloudy Channels pilot.

## Activation after review

Start with an isolated test workspace and a supported Claude CLI. Preserve the existing channel, scope, permission and authentication settings. Merge these fields into its configuration rather than replacing the configuration file:

```json
{
  "liveBridge": {
    "enabled": true,
    "observeHooks": true,
    "port": 18791,
    "tokenEnv": "CLAWCODE_LIVE_TOKEN",
    "leaderPolicy": {
      "enabled": true,
      "maxConcurrent": 6
    }
  }
}
```

Supply the bridge credential through the named environment variable; never commit it. Regenerate the launcher through ClawCode's existing service setup so the new policy wrapper is used. The launcher's native environment settings must be present in the same Claude process that loads the hooks. Loading only the MCP server does not install or verify the hook. Consent to the native Channels feature is still required.

Connect ClaudeLive to that host's loopback bridge using its credential. Readiness requires both the leader's probe ACK and the corresponding native hook. A public policy setting describes configuration; `hookObserved:false` or `runtimeConfirmed:false` must not be presented as tested runtime enforcement. Exact alternative channel tool names can be added using `coordinationTools` after review; this is not a wildcard permission grant.

## Acceptance in the real host

1. An owner sends a WhatsApp task that runs long enough to overlap another turn. It receives its ordinary WhatsApp reply.
2. Attach voice to that same native session; verify its identity and visible task cards. Ask about the task and continue the strategy discussion while it runs.
3. Start a separate task from voice. Its reply stays in Live; WhatsApp replies are not mirrored automatically. Explicit cross-channel requests are treated separately.
4. Verify that an operational tool is blocked for the principal but reaches the worker's existing permission path after background delegation. A guest denial remains a denial.
5. Configure native spawn limits of 1 and 6. Verify observed launches, rejection at capacity, pending work reporting and the ability to continue talking. Do not call this an automatic queue.
6. Disconnect/reconnect Live, then restart a test host. Check task identities, delivery reconciliation and native session recovery without duplicate execution.

## Explicit follow-up work

- **Native admission queue:** Claude rejects spawns at capacity. This PR does not implement durable automatic admission of those pending jobs. `SendMessage` can resume completed subagents outside the native spawn cap; user commands and separate runtime features also have exceptions. It is not a universal resource quota. [Native concurrency semantics](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit).
- **Response destinations:** Live publications have attributable sources and `live_emit` sends only to Live. There is not yet a universal runtime rule across all WhatsApp and voice tools enforcing each turn's response destination. Sharing a WhatsApp source also needs separate controls for context sharing versus voice notifications.
- **Immediate voice status:** task snapshots are available independently of a model turn, but a natural-language status question still goes to the leader. A trusted voice status path that does not wait for it remains to be implemented.
- **Runtime verification:** command hooks can fail open if they cannot start or time out; conflicting managed/project environment settings also need validation in the target host. This policy is an execution workflow, not an OS sandbox or an absolute latency guarantee. [Hook behavior](https://code.claude.com/docs/en/hooks).
- **Pilot and remaining integrations:** human interruptions, the real WhatsApp-to-voice continuation, ClawCode usage snapshots, native remote approval relaying and Claude Desktop compatibility remain unverified or unimplemented as documented in [live-bridge.md](live-bridge.md).

To disable the conversational policy, set `leaderPolicy.enabled:false` and restart the test host through its normal launcher. Disable `liveBridge.enabled` to remove the Live integration. Preserve the native session and `.clawcode-live` data for explicit recovery; disabling a feature is not permission to discard work or create another writer for the same session.
