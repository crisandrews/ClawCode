import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LiveBridge } from "../lib/live-bridge.ts";
import { sanitizeHook } from "../hooks/live-observe.mjs";

async function fixture(t: TestContext, verified = true) {
  const directory = mkdtempSync(join(tmpdir(), "clawcode-native-activity-"));
  const token = "native-fixture-only-".repeat(3);
  const deliveries: Array<{ content: string; meta: Record<string, string> }> = [];
  const options = { workspace: directory, dataDir: join(directory, "host"), port: 0, token,
    observeHooks: true, agent: { id: "fixture", name: "Existing leader" },
    deliver: async (message: typeof deliveries[number]) => { deliveries.push(message); } };
  let bridge = new LiveBridge(options);
  t.after(async () => { await bridge.close(); rmSync(directory, { recursive: true, force: true }); });
  await bridge.start();
  const observe = (event: string, fields: Record<string, unknown> = {}) => {
    const observation = sanitizeHook({ hook_event_name: event, session_id: "native-session", ...fields });
    assert.ok(observation);
    bridge.observeHook(observation);
    return observation;
  };
  const acknowledgeProbe = () => bridge.callTool("live_ack", { probe: deliveries.at(-1)!.meta.probe });
  const bind = (session = "native-session") => observe("PostToolUse", {
    session_id: session, tool_name: "mcp__plugin_agent_clawcode__live_ack",
    tool_use_id: `probe-${session}`, tool_input: { probe: deliveries.at(-1)!.meta.probe },
  });
  await bridge.probeChannel();
  if (verified) { acknowledgeProbe(); bind(); }
  return {
    get bridge() { return bridge; }, directory, token, deliveries, observe, acknowledgeProbe, bind,
    async restart(savedBeforeClose?: string) {
      await bridge.close();
      if (savedBeforeClose !== undefined) writeFileSync(join(options.dataDir, "state.json"), savedBeforeClose);
      bridge = new LiveBridge(options); await bridge.start(); await bridge.probeChannel();
    },
    async wireSnapshot() {
      const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/live/attachments`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 201);
      return (await response.json() as any).snapshot;
    },
  };
}

test("real sanitizer keeps bounded identity metadata and rejects prompts, paths, commands and secrets", () => {
  const raw = { hook_event_name: "PreToolUse", session_id: "native-session", agent_id: "worker",
    agent_type: "plugin:reviewer", tool_name: "Bash", tool_use_id: "tool_01",
    tool_input: { command: "PRIVATE_COMMAND", token: "PRIVATE_TOKEN" }, tool_response: "PRIVATE_RESULT",
    transcript_path: "/PRIVATE_PATH", prompt: "PRIVATE_PROMPT", description: "PRIVATE_DESCRIPTION",
    last_assistant_message: "PRIVATE_MESSAGE" };
  const observed = sanitizeHook(raw);
  assert.deepEqual(Object.keys(observed).sort(), ["agentId", "agentType", "event", "id", "sessionId", "toolName", "toolUseId"]);
  assert.equal(observed.agentType, "plugin:reviewer");
  assert.equal(observed.toolName, "Bash"); assert.equal(observed.toolUseId, "tool_01");
  assert.doesNotMatch(JSON.stringify(observed), /PRIVATE/);
  for (const invalid of ["has spaces", "../private", "x".repeat(181), "Explore\nPRIVATE"]) {
    const clean = sanitizeHook({ ...raw, agent_type: invalid, tool_name: invalid, tool_use_id: invalid });
    assert.equal(clean.agentType, undefined); assert.equal(clean.toolName, undefined); assert.equal(clean.toolUseId, undefined);
  }
  assert.equal(sanitizeHook({ ...raw, agent_id: undefined }).agentType, undefined, "main --agent is not a worker identity");
  assert.equal(sanitizeHook({ ...raw, hook_event_name: "PostToolUse" }).agentType, undefined);
  assert.equal(sanitizeHook({ ...raw, hook_event_name: "MessageDisplay" }), null);
});

test("principal tools require a verified matching session and appear on the wire without invented tasks or messages", async t => {
  const f = await fixture(t, false);
  const tool = { tool_name: "Bash", tool_use_id: "principal-bash", tool_input: { command: "PRIVATE_COMMAND" }, tool_response: "PRIVATE_RESULT" };
  f.observe("PreToolUse", tool);
  assert.equal(f.bridge.snapshot().conversation.activity, undefined);
  f.acknowledgeProbe(); f.bind();
  f.observe("PreToolUse", { ...tool, session_id: "another-session" });
  f.observe("PreToolUse", { ...tool, tool_use_id: undefined });
  assert.equal(f.bridge.snapshot().conversation.activity, undefined);
  f.observe("PreToolUse", tool);
  const snapshot = await f.wireSnapshot();
  assert.equal(snapshot.conversation.activity.phase, "tool");
  assert.equal(snapshot.conversation.activity.toolName, "Bash");
  assert.equal(snapshot.conversation.status, "working");
  assert.deepEqual(snapshot.tasks, []); assert.deepEqual(snapshot.conversation.messages, []);
  assert.equal(f.deliveries.length, 1, "observing a tool cannot trigger a channel response");
  const disk = readFileSync(join(f.directory, "host/state.json"), "utf8");
  assert.doesNotMatch(disk, /PRIVATE/); assert.equal(disk.includes(f.token), false);
});

test("parallel principal tools survive unmatched completions and duplicate starts until Stop clears the turn", async t => {
  const f = await fixture(t);
  const bash = { tool_name: "Bash", tool_use_id: "bash-1" };
  const observation = f.observe("PreToolUse", bash);
  const firstActivity = f.bridge.snapshot().conversation.activity;
  f.bridge.observeHook(observation);
  assert.deepEqual(f.bridge.snapshot().conversation.activity, firstActivity);
  f.observe("PreToolUse", { tool_name: "Read", tool_use_id: "read-2" });
  f.observe("PostToolUse", { tool_name: "Read", tool_use_id: "unknown" });
  f.observe("PostToolUse", bash);
  assert.equal(f.bridge.snapshot().conversation.activity?.toolName, "Read");
  f.observe("PostToolUseFailure", { tool_name: "Read", tool_use_id: "read-2", tool_response: "PRIVATE_ERROR" });
  assert.equal(f.bridge.snapshot().conversation.activity?.phase, "thinking");
  assert.equal(f.bridge.snapshot().conversation.activity?.toolName, undefined);
  f.observe("Stop", { last_assistant_message: "PRIVATE_ANSWER" });
  f.observe("PostToolUse", bash);
  assert.equal(f.bridge.snapshot().conversation.activity, undefined, "late completion cannot resurrect a stopped turn");
  assert.equal(f.bridge.snapshot().conversation.status, "ready");
  assert.deepEqual(f.bridge.snapshot().conversation.messages, []);
});

test("worker Stop does not clear principal activity and principal Stop never claims worker completion", async t => {
  const f = await fixture(t);
  f.observe("SubagentStart", { agent_id: "worker", agent_type: "Explore" });
  f.observe("PreToolUse", { tool_use_id: "principal-bash", tool_name: "Bash" });
  f.observe("PreToolUse", { agent_id: "worker", tool_use_id: "worker-read", tool_name: "Read" });
  f.observe("Stop", { agent_id: "worker" });
  f.observe("SubagentStop", { agent_id: "worker" });
  assert.equal(f.bridge.snapshot().conversation.activity?.toolName, "Bash");
  f.observe("Stop");
  assert.equal(f.bridge.snapshot().conversation.activity, undefined);
  assert.equal(f.bridge.snapshot().conversation.status, "working");
  assert.equal(f.bridge.snapshot().tasks[0].status, "running");
  f.observe("PreToolUse", { tool_use_id: "principal-again", tool_name: "Bash" });
  f.observe("SessionEnd");
  const ended = f.bridge.snapshot();
  assert.equal(ended.conversation.activity, undefined); assert.equal(ended.conversation.status, "offline");
  assert.equal(ended.tasks[0].stale, true); assert.equal(ended.tasks[0].controls.cancel, false);
  f.observe("PreToolUse", { tool_use_id: "late-main", tool_name: "Read" });
  f.observe("PreToolUse", { agent_id: "late-worker", tool_use_id: "late-worker-read", tool_name: "Read" });
  assert.equal(f.bridge.snapshot().conversation.activity, undefined); assert.equal(f.bridge.snapshot().tasks.length, 1);
});

test("restart discards persisted in-flight principal activity without changing the native conversation identity", async t => {
  const f = await fixture(t);
  f.observe("PreToolUse", { tool_use_id: "running-at-crash", tool_name: "Bash" });
  const original = f.bridge.snapshot().conversation.id;
  // Restore the pre-close snapshot only in this temporary fixture to model abrupt exit.
  const crashSnapshot = readFileSync(join(f.directory, "host/state.json"), "utf8");
  await f.restart(crashSnapshot);
  assert.equal(f.bridge.snapshot().conversation.id, original);
  assert.equal(f.bridge.snapshot().conversation.activity, undefined);
  assert.equal(f.bridge.snapshot().conversation.status, "starting");
  f.acknowledgeProbe(); f.bind();
  assert.equal(f.bridge.snapshot().conversation.status, "ready");
});

test("verified worker PreToolUse recovers a missed start, but unknown completions or other sessions cannot create work", async t => {
  const f = await fixture(t, false);
  const worker = { agent_id: "late-worker", agent_type: "Explore", tool_use_id: "worker-read", tool_name: "Read" };
  f.observe("SubagentStart", worker); f.observe("PreToolUse", worker);
  assert.equal(f.bridge.snapshot().tasks.length, 0);
  f.acknowledgeProbe(); f.bind();
  for (const event of ["Stop", "SubagentStop", "PostToolUse", "PostToolUseFailure"]) f.observe(event, worker);
  f.observe("PreToolUse", { ...worker, session_id: "other-session" });
  f.observe("PreToolUse", { ...worker, tool_use_id: undefined });
  assert.equal(f.bridge.snapshot().tasks.length, 0);
  const observed = f.observe("PreToolUse", worker);
  const first = f.bridge.snapshot().tasks[0];
  assert.equal(first.nativeId, "late-worker"); assert.equal(first.title, "Native agent · Explore");
  assert.equal(first.status, "running"); assert.match(first.progress, /start was not observed/);
  f.bridge.observeHook(observed);
  assert.equal(f.bridge.snapshot().tasks[0].revision, first.revision, "replaying the exact hook is idempotent");
  f.observe("SubagentStart", worker);
  assert.equal(f.bridge.snapshot().tasks.length, 1, "delayed Start reconciles to the same native identity");
  assert.equal(f.bridge.snapshot().tasks[0].id, first.id);
  assert.deepEqual(f.bridge.snapshot().conversation.messages, []); assert.equal(f.deliveries.length, 1);
});

test("declared titles and terminal outcomes remain authoritative over late native metadata", async t => {
  const f = await fixture(t);
  f.observe("PreToolUse", { agent_id: "worker", tool_name: "Read", tool_use_id: "first" });
  assert.equal(f.bridge.snapshot().tasks[0].title, "Native agent");
  f.observe("SubagentStart", { agent_id: "worker", agent_type: "plugin:reviewer" });
  assert.equal(f.bridge.snapshot().tasks[0].title, "Native agent · plugin:reviewer");
  const conversationId = f.bridge.snapshot().conversation.id;
  f.bridge.callTool("live_work", { id: "declared", taskId: "logical-review", nativeId: "worker", conversationId,
    title: "Review the requested change", progress: "Review underway", status: "running" });
  f.observe("PreToolUse", { agent_id: "worker", agent_type: "Explore", tool_name: "Read", tool_use_id: "second" });
  assert.equal(f.bridge.snapshot().tasks.length, 1);
  assert.equal(f.bridge.snapshot().tasks[0].title, "Review the requested change");
  f.bridge.callTool("live_work", { id: "finished", taskId: "logical-review", conversationId, progress: "Review finished", status: "completed" });
  const terminal = f.bridge.snapshot().tasks[0];
  f.observe("PreToolUse", { agent_id: "worker", agent_type: "Explore", tool_name: "Read", tool_use_id: "late" });
  f.observe("SubagentStart", { agent_id: "worker", agent_type: "Explore" });
  f.observe("SubagentStop", { agent_id: "worker" });
  assert.deepEqual(f.bridge.snapshot().tasks[0], terminal, "late hooks cannot revive or rename completed work");
});

test("probe retries stop at ACK while readiness still requires its native hook and no receipt exposes the nonce", async t => {
  let time = Date.now(); t.mock.method(Date, "now", () => time);
  const f = await fixture(t, false);
  assert.deepEqual(f.bridge.channelHandshakeState, { running: true, acknowledged: false, channelReady: false, bindingStatus: "awaiting_session" });
  time += 1500; await f.bridge.probeChannel();
  assert.equal(f.deliveries.length, 2, "unacknowledged probes may be explicitly retried");
  f.acknowledgeProbe();
  time += 1500; await f.bridge.probeChannel();
  assert.equal(f.deliveries.length, 2, "ACK suppresses retries even while a native hook is missing");
  assert.deepEqual(f.bridge.channelHandshakeState, { running: true, acknowledged: true, channelReady: false, bindingStatus: "awaiting_session" });
  const receipt = JSON.stringify(f.bridge.channelHandshakeState);
  assert.equal(receipt.includes(f.deliveries[0].meta.probe), false); assert.equal(receipt.includes(f.token), false);
  f.bind();
  assert.deepEqual(f.bridge.channelHandshakeState, { running: true, acknowledged: true, channelReady: true, bindingStatus: "verified" });
  f.observe("SessionEnd");
  assert.equal(f.bridge.channelHandshakeState.acknowledged, false);
  assert.equal(f.bridge.channelHandshakeState.channelReady, false);
});

test("replacement awaiting owner recovery cannot trigger repeated probes after its ACK", async t => {
  let time = Date.now(); t.mock.method(Date, "now", () => time);
  const f = await fixture(t);
  await f.restart(); f.acknowledgeProbe(); f.bind("replacement-session");
  const before = f.deliveries.length;
  assert.equal(f.bridge.channelHandshakeState.bindingStatus, "recovery_required");
  assert.equal(f.bridge.channelHandshakeState.acknowledged, true);
  assert.equal(f.bridge.channelHandshakeState.channelReady, false);
  time += 1500; await f.bridge.probeChannel();
  assert.equal(f.deliveries.length, before);
});
