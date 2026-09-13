# Live integration verification — ClawCode 1.8.0

Verified locally on September 12, 2026 for the changes in [PR #38](https://github.com/crisandrews/ClawCode/pull/38), paired with **ClaudeLive 0.8.2**. These results cover the release candidate in the review checkout. Local validation, publication, CI and activation of an installed agent are separate steps; this record does not claim that the daily Cloudy service was updated or restarted.

## Confirmed results

| Check | Result | Evidence covered |
| --- | --- | --- |
| `npm run test:live` | **77/77 passed** | All Live suites listed below, using isolated workspaces and temporary state. |
| `npm test` | **182/182 passed** | Existing service, execution-scope and trust regressions. |
| ClaudeLive cross-repository contract | **5/5 passed** | Actual ClawCode bridge and plain-Node collector with ClaudeLive's real external adapter over authenticated loopback HTTP/SSE. |
| Guided setup integration | **Passed** | Actual setup helper → generated protected environment → ClaudeLive environment loader → bridge → web, with synthetic ACK/native-hook evidence. |

The 77 Live tests include these suites; their counts are **not additional tests**:

| Suite | Passed | Scope |
| --- | --- | --- |
| `scripts/live-setup.test.ts` | 19 | Read-only plans/status, stale fingerprints, merge preservation, idempotency, disablement, rollback, port observations, exact launch arguments and runtime/configuration mismatch. |
| `scripts/live-credentials.test.ts` | 5 | Private managed file, environment compatibility, symlink/hardlink and permission rejection, no fallback to a stale token, and the actual hook subprocess. |
| `scripts/live-setup-mcp.test.ts` | 3 | Real MCP server discovery before activation, setup/status tools and configured-host reporting. |
| `scripts/live-native-activity.test.ts` | 9 | Sanitized principal activity, concurrent tools, Stop/SessionEnd/restart cleanup, missed worker starts, stable titles, no terminal resurrection and probe suppression after ACK. |
| `scripts/live-bridge.test.ts` | 18 | Authenticated transport, revisions/receipts, publication semantics, tasks, recovery, source adoption and model observations. |
| `scripts/live-handshake.test.ts` | 6 | Bounded initialization retries and distinct receipt, hook and recovery states. |
| `scripts/live-leader-policy.test.ts` | 12 | Background delegation policy and retention of the host's ordinary permissions. |
| `scripts/live-host-source.test.ts` | 3 | Native host continuity and source-aware integration. |
| `scripts/live-service-args.test.ts` | 2 | Preserved channel/session arguments and the managed per-workspace launch environment. |

The five cross-repository tests cover revisions/ACK/tasks/cancel/publication/detach, explicit owner source adoption, replacement-host recovery with held inputs, real collector principal activity, and recovery of a worker whose start was missed. Cancellation remains a request until the leader reports the native outcome. The collector records bounded identity metadata; it does not copy commands, arguments, transcripts, prompts or credentials into the public conversation.

## Reproduce in isolated checkouts

From the ClawCode review checkout:

```sh
npm run test:live
npm test
```

From the paired ClaudeLive checkout, point the contract test at the actual ClawCode review checkout:

```sh
CLAUDE_LIVE_TEST_CLAWCODE_ROOT=/absolute/path/to/ClawCode-review \
  node --import tsx --test tests/bridge-integration.test.ts
```

Without that environment variable, the cross-repository test uses ClaudeLive's bundled bridge and cannot establish compatibility with the PR implementation. These commands assume each checkout's declared dependencies are installed. They are not activation commands for an existing agent.

## Boundaries of this validation

- Real MCP processes, native collector subprocesses, setup files, HTTP/SSE and web initialization were exercised. The native session IDs, probe acknowledgements and channel events were synthetic. No human Claude Channels session, WhatsApp exchange or microphone/playback pilot was performed in these checks; no daily Cloudy restart was performed.
- Setup is an owner-requested operation through the trusted skill's deterministic helper and ordinary tool permissions. The skill specifies the write mechanism; it does not grant itself authorization. Applying config, installing a plugin, restarting the owner process and verifying its native channel are distinct states.
- Generated launch commands preserve the original argument vector. Workspace-specific environment values and explicit unset operations avoid changing global plugin settings or inheriting another agent's bridge credential. A process listening on a port is not evidence that it owns the selected native session.
- Normal setup failures roll back the files created by that attempt. An abrupt crash between multiple file writes can leave an incomplete setup requiring review; no crash-atomic multi-file transaction is claimed. Existing work and uncertain delivery records are retained.
- Host usage/cost snapshots, remote model changes and remote permission relaying remain unsupported. Observed model information is not a model-selection control. `live_emit` proves bridge publication, never that the user heard audio.
- `host_native` preserves memory, skills, MCP and messaging capabilities under existing rules. A synchronous tool can still occupy the leader. The configurable native spawn limit is not a durable queue or a universal cap on resumed agents.

Before daily activation, complete the [real-host acceptance pilot](live-integration-handoff.md#acceptance-in-the-real-host): one owner task through WhatsApp, voice continuation in that same session, concurrent work, correct response destinations, permission behavior, interruption, reconnect and explicit recovery after restart. See [guided setup](live-setup.md) for the operator flow.
