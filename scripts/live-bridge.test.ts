import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { LiveBridge, LIVE_TOOLS, LIVE_INSTRUCTIONS } from "../lib/live-bridge.ts";
import { LiveStore } from "../lib/live-store.ts";
import { sanitizeHook } from "../hooks/live-observe.mjs";
import { classifyAgentConfigKey } from "../lib/scope/agent-config-guard.ts";
import { loadConfig } from "../lib/config.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const token = "fixture-only-not-a-real-secret-" + "x".repeat(32);
const turn = () => new Promise(resolve => setTimeout(resolve, 5));
async function fixture(t: any, extra: Record<string, unknown> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-live-test-"));
  const deliveries: Array<{ content: string; meta: Record<string, string> }> = [];
  const options = { workspace: directory, dataDir: path.join(directory, "live"), token, port: 0, agent: { id: "fixture", name: "Fixture leader" }, deliver: async (message: any) => { deliveries.push(message); }, ...extra };
  let bridge = new LiveBridge(options);
  await bridge.start();
  t.after(async () => { await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = async (route: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/v1/live${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const attach = async () => (await request("/attachments", "POST", {})).body;
  const ready = async () => {
    await bridge.probeChannel();
    const probe = deliveries.findLast(d => d.meta.source === "live_probe")!.meta.probe;
    bridge.callTool("live_ack", { probe }); return probe;
  };
  return {
    get bridge() { return bridge; }, directory, deliveries, options, request, attach, ready,
    restart: async () => { await bridge.close(); bridge = new LiveBridge(options); await bridge.start(); },
  };
}

async function firstEvent(bridge: LiveBridge, attachment: string, cursor: number, headers: Record<string, string> = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/live/attachments/${attachment}/events?cursor=${cursor}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(); let text = "";
    while (!text.includes("\n\n")) { const part = await reader.read(); if (part.done) break; text += new TextDecoder().decode(part.value); }
    const block = text.split("\n\n")[0]; await reader.cancel();
    return { id: Number(/^id: (.+)$/m.exec(block)![1]), event: JSON.parse(/^data: (.+)$/m.exec(block)![1]) };
  } finally { clearTimeout(timeout); controller.abort(); }
}

test("mandatory bearer, local Host, no browser origins, validation, unsupported commands", async t => {
  assert.throws(() => new LiveBridge({ workspace: "/tmp", dataDir: "/tmp/live", token: "", agent: { id: "x", name: "x" }, deliver: async () => {} }), /token/);
  const f = await fixture(t);
  assert.equal((await f.request("/capabilities", "GET", undefined, { Authorization: "" })).status, 401);
  assert.equal((await f.request("/capabilities", "GET", undefined, { Authorization: "Bearer wrong" })).status, 401);
  const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: f.bridge.port, path: "/v1/live/capabilities", headers: { Host: "attacker.test", Authorization: `Bearer ${token}` } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await f.request("/capabilities", "GET", undefined, { Origin: "http://127.0.0.1" })).status, 403);
  const capabilities = (await f.request("/capabilities")).body;
  assert.equal(capabilities.protocolVersion, 1); assert.equal(capabilities.capabilities.approvals, false); assert.equal(capabilities.capabilities.modelChange, false);
  assert.equal(JSON.stringify(capabilities).includes(token), false);
  const a = await f.attach();
  assert.equal((await f.request(`/attachments/${a.attachmentId}/commands`, "POST", { id: "a", kind: "approve" })).status, 422);
  assert.equal((await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", { id: "__proto__", text: "x", revision: 1, origin: "web" })).status, 400);
  assert.equal((await f.request("/attachments", "POST", { conversationId: "other" })).status, 404);
  assert.equal((await f.request("/hooks", "POST", {})).status, 404);
  assert.throws(() => f.bridge.callTool("live_status", { secret: "should not be persisted" }), /Unexpected/);
});

test("readiness requires real Channels probe ACK; transport never acknowledges inputs", async t => {
  const f = await fixture(t); const a = await f.attach();
  const input = { id: "i1", text: "Run two independent checks", revision: 1, origin: "voice", delegationId: "voice-delegation-1" };
  assert.equal((await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", input)).body.status, "queued");
  await f.bridge.probeChannel();
  assert.equal(f.deliveries.length, 1); assert.equal(f.bridge.capabilities().capabilities.channelReady, false);
  assert.equal(JSON.stringify(f.bridge.callTool("live_status", {})).includes(f.deliveries[0].meta.probe), false);
  assert.throws(() => f.bridge.callTool("live_ack", { inputId: "i1", revision: 1 }), /not delivered/);
  assert.throws(() => f.bridge.callTool("live_ack", { probe: "guessed" }), /probe/);
  f.bridge.callTool("live_ack", { probe: f.deliveries[0].meta.probe }); await turn();
  assert.equal(f.bridge.capabilities().capabilities.channelReady, true);
  assert.equal(f.deliveries.filter(d => d.meta.source === "live").length, 1);
  assert.equal(JSON.parse(f.deliveries[1].content).delegationId, "voice-delegation-1");
  assert.equal(f.bridge.snapshot().conversation.queuedInputs, 1);
  assert.throws(() => f.bridge.callTool("live_emit", { id: "e1", inputId: "i1", revision: 1, type: "leader.reply", text: "Result" }), /attribution/);
  f.bridge.callTool("live_ack", { inputId: "i1", revision: 1 });
  assert.equal(f.bridge.snapshot().conversation.queuedInputs, 0);
  f.bridge.callTool("live_emit", { id: "e1", inputId: "i1", revision: 1, type: "leader.progress", text: "Both checks are running" });
  assert.equal(f.bridge.snapshot().conversation.messages.at(-1)?.kind, "progress");
});

test("durable duplicate/revision protection, attribution, reconnect and detached delivery", async t => {
  const f = await fixture(t); const a = await f.attach(); await f.ready();
  const input = { id: "i1", text: "First", revision: 1, origin: "web" };
  await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", input); await turn();
  const duplicate = await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", input);
  assert.equal(duplicate.status, 202); assert.equal(f.deliveries.filter(d => d.meta.source === "live").length, 1);
  assert.equal((await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", { ...input, text: "Different" })).status, 409);
  assert.equal((await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", { ...input, revision: 0 })).status, 400);
  f.bridge.callTool("live_ack", { inputId: "i1", revision: 1 });
  const publication = { id: "pub1", inputId: "i1", revision: 1, type: "leader.reply", text: "Public result" };
  f.bridge.callTool("live_emit", publication); f.bridge.callTool("live_emit", publication);
  assert.equal(f.bridge.snapshot().conversation.messages.filter(m => m.id === "pub1").length, 1);
  assert.throws(() => f.bridge.callTool("live_emit", { ...publication, text: "Another" }), /different content/);
  assert.throws(() => f.bridge.callTool("live_emit", { ...publication, id: "other", inputId: "wrong" }), /attribution/);
  const oldCursor = (await f.request("/attachments", "POST", { conversationId: a.conversationId })).body.cursor;
  await f.request(`/attachments/${a.attachmentId}`, "DELETE");
  assert.equal((await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", input)).status, 404);
  assert.equal((await f.request("/capabilities")).status, 200);
  await f.restart();
  assert.equal(f.bridge.capabilities().capabilities.channelReady, false);
  const b = await f.attach(); assert.equal(b.conversationId, a.conversationId); assert.ok(b.cursor > oldCursor);
  assert.equal((await f.request(`/attachments/${b.attachmentId}/inputs`, "POST", input)).body.status, "acknowledged");
  assert.equal(f.bridge.snapshot().conversation.messages.filter(m => m.id === "pub1").length, 1);
  await f.ready(); await turn(); assert.equal(f.deliveries.filter(d => d.meta.source === "live").length, 1);
  f.bridge.callTool("live_emit", publication);
  assert.equal(f.bridge.snapshot().conversation.messages.filter(m => m.id === "pub1").length, 1);
});

test("uncertain delivery is persisted before write and never automatically retried", async t => {
  const f = await fixture(t); const a = await f.attach();
  await f.ready();
  f.options.deliver = async () => { throw new Error("transport outcome unknown"); };
  // Existing instance holds this same options object, as a normal transport adapter does.
  await f.request(`/attachments/${a.attachmentId}/inputs`, "POST", { id: "uncertain", text: "Only once", revision: 1, origin: "voice" }); await turn();
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, "live/state.json"), "utf8"));
  assert.equal(saved.inputs["uncertain@1"].status, "delivery_uncertain");
  await f.restart();
  const attempts: any[] = [];
  f.options.deliver = async message => { attempts.push(message); };
  await f.bridge.probeChannel();
  f.bridge.callTool("live_ack", { probe: attempts[0].meta.probe }); await turn();
  assert.equal(attempts.length, 1, "Only new probe is sent; uncertain input is not retried");
});

test("coalesced voice revisions can skip numbers and supersede queued or delivered text", async t => {
  const f = await fixture(t); const a = await f.attach();
  const route = `/attachments/${a.attachmentId}/inputs`;
  const input = { id: "voice", text: "Initial fragment", revision: 3, origin: "voice" };
  assert.equal((await f.request(route, "POST", input)).status, 202);
  assert.equal((await f.request(route, "POST", { ...input, revision: 7, text: "Complete instruction" })).status, 202);
  assert.equal(f.bridge.snapshot().conversation.queuedInputs, 1);
  await f.ready(); await turn();
  assert.equal(f.deliveries.filter(d => d.meta.source === "live").length, 1);
  assert.equal(f.deliveries.at(-1)?.meta.revision, "7");
  assert.throws(() => f.bridge.callTool("live_ack", { inputId: "voice", revision: 3 }), /not delivered/);
  f.bridge.callTool("live_ack", { inputId: "voice", revision: 7 });
  assert.equal((await f.request(route, "POST", { ...input, revision: 10, text: "Corrected instruction" })).status, 202); await turn();
  assert.equal((await f.request(route, "POST", { ...input, revision: 9 })).status, 409);
  assert.throws(() => f.bridge.callTool("live_emit", { id: "old-reply", inputId: "voice", revision: 7, type: "leader.reply", text: "Old response" }), /superseded/);
  f.bridge.callTool("live_ack", { inputId: "voice", revision: 10 });
  f.bridge.callTool("live_emit", { id: "new-reply", inputId: "voice", revision: 10, type: "leader.reply", text: "Correction accepted" });
  assert.match(JSON.parse(f.deliveries.at(-1)!.content).revisionSemantics, /do not start duplicate/);
});

test("two tasks publish progress before completion, cancel ACK is not cancellation", async t => {
  const f = await fixture(t); const a = await f.attach(); await f.ready();
  const publish = (id: string, taskId: string, status = "running", progress = "Started") => f.bridge.callTool("live_work", { id, taskId, conversationId: a.conversationId, title: taskId, progress, status });
  publish("p1", "native-a"); publish("p2", "native-b"); publish("p3", "native-a", "running", "Halfway through");
  assert.equal(f.bridge.snapshot().tasks.filter(t => t.status === "running").length, 2);
  const event = await firstEvent(f.bridge, a.attachmentId, a.cursor);
  assert.ok(event.event.snapshot); assert.equal(event.id, event.event.seq);
  const cmd = { id: "cancel-1", kind: "cancel", taskId: "native-a" };
  assert.equal((await f.request(`/attachments/${a.attachmentId}/commands`, "POST", cmd)).body.status, "pending"); await turn();
  f.bridge.callTool("live_ack", { commandId: "cancel-1", revision: 1 });
  assert.equal(f.bridge.snapshot().tasks.find(t => t.id === "native-a")?.status, "running");
  assert.equal((await f.request(`/attachments/${a.attachmentId}/commands`, "POST", cmd)).body.status, "pending");
  publish("p4", "native-a", "cancelled", "Leader confirmed native cancellation");
  f.bridge.callTool("live_emit", { id: "cancel-result", commandId: "cancel-1", type: "command.completed", text: "Cancelled native-a" });
  assert.equal((await f.request(`/attachments/${a.attachmentId}/commands`, "POST", cmd)).body.status, "completed");
  publish("p5", "native-b", "completed", "Checks passed");
  await f.restart();
  assert.deepEqual(f.bridge.snapshot().tasks.map(t => [t.id, t.status]), [["native-a", "cancelled"], ["native-b", "completed"]]);
});

test("snapshot replay handles retained cursor, expired cursor and task staleness after restart", async t => {
  const f = await fixture(t, { eventRetention: 8 }); const a = await f.attach(); await f.ready();
  for (let i = 0; i < 12; i++) f.bridge.callTool("live_work", { id: `p${i}`, taskId: "stable", conversationId: a.conversationId, progress: `Step ${i}` });
  const expired = await firstEvent(f.bridge, a.attachmentId, 0);
  assert.equal(expired.event.type, "work.snapshot"); assert.equal(expired.event.data.resync, true);
  assert.equal(expired.event.snapshot.tasks[0].progress, "Step 11");
  const retained = await firstEvent(f.bridge, a.attachmentId, expired.id - 1);
  assert.equal(retained.id, expired.id); assert.equal(retained.event.type, "work.activity");
  await f.restart();
  assert.equal(f.bridge.snapshot().tasks[0].stale, true); assert.equal(f.bridge.snapshot().tasks[0].controls.cancel, false);
});

test("native hooks require proven session binding, suppress unrelated text, observe work before final", async t => {
  const f = await fixture(t, { observeHooks: true }); const a = await f.attach(); const probe = await f.ready();
  f.bridge.observeHook({ id: "h0", event: "SubagentStart", sessionId: "other", agentId: "a" });
  assert.equal(f.bridge.snapshot().tasks.length, 0);
  f.bridge.observeHook({ id: "binding", event: "PostToolUse", sessionId: "host-session", probe });
  assert.equal(f.bridge.capabilities().agent.sessionId, "host-session");
  f.bridge.observeHook({ id: "h1", event: "SubagentStart", sessionId: "host-session", agentId: "agent-a", last_assistant_message: "PRIVATE" });
  f.bridge.observeHook({ id: "h2", event: "SubagentStart", sessionId: "host-session", agentId: "agent-b" });
  const first = f.bridge.snapshot().tasks[0]; assert.equal(first.nativeId, "agent-a"); assert.equal(first.status, "running");
  f.bridge.observeHook({ id: "h3", event: "PostToolUse", sessionId: "host-session", agentId: "agent-a", tool_input: { secret: "PRIVATE" } });
  f.bridge.observeHook({ id: "h4", event: "SubagentStop", sessionId: "host-session", agentId: "agent-a", last_assistant_message: "PRIVATE" });
  f.bridge.observeHook({ id: "h5", event: "Stop", sessionId: "host-session", last_assistant_message: "PRIVATE" });
  f.bridge.observeHook({ id: "h6", event: "MessageDisplay", sessionId: "host-session", delta: "PRIVATE" });
  assert.equal(f.bridge.snapshot().tasks[0].status, "running", "response end is not completion");
  assert.equal(JSON.stringify(f.bridge.snapshot()).includes("PRIVATE"), false);
  assert.equal(f.bridge.snapshot().tasks[0].history.length, 3);
  f.bridge.callTool("live_work", { id: "done", taskId: first.id, conversationId: a.conversationId, progress: "Finished", status: "completed" });
  f.bridge.observeHook({ id: "late-stop", event: "SubagentStop", sessionId: "host-session", agentId: "agent-a" });
  assert.equal(f.bridge.snapshot().tasks[0].status, "completed");
  assert.throws(() => f.bridge.observeHook({ event: "PostToolUse", sessionId: "other", probe }), /another host/);
  const clean = sanitizeHook({ hook_event_name: "PostToolUse", session_id: "host-session", agent_id: "a", tool_name: "mcp__plugin_claude-live_live__live_ack", tool_input: { probe, secret: "PRIVATE" }, transcript_path: "/private", tool_response: "PRIVATE" });
  assert.equal(clean.probe, probe); assert.equal(JSON.stringify(clean).includes("PRIVATE"), false);
  assert.equal(sanitizeHook({ hook_event_name: "MessageDisplay", session_id: "s", delta: "PRIVATE" }), null);
});

test("exclusive writer and stale process-lock recovery preserve durable state", async t => {
  const f = await fixture(t);
  const other = new LiveBridge({ ...f.options, port: 0 });
  await assert.rejects(() => other.start(), /writer/);
  assert.equal((await f.request("/capabilities")).status, 200);
  const dir = path.join(f.directory, "crashed"); fs.mkdirSync(dir);
  const child = spawn(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { stdio: ["ignore", "pipe", "pipe"] });
  let pid = ""; child.stdout.on("data", chunk => pid += chunk); await once(child, "close");
  fs.writeFileSync(path.join(dir, "owner.lock"), JSON.stringify({ pid: Number(pid), nonce: "fixture-crash" }));
  const store = new LiveStore(dir); store.acquire(); store.close();
  assert.equal(fs.existsSync(path.join(dir, "owner.lock")), false);
});

test("configuration stays opt-in and cannot be self-enabled through agent_config", async t => {
  const f = await fixture(t);
  assert.equal(loadConfig(f.directory).liveBridge, undefined);
  for (const key of ["liveBridge", "liveBridge.enabled", "liveBridge.tokenEnv", "liveBridge.port"]) assert.equal(classifyAgentConfigKey(key), "privileged");
  assert.match(LIVE_INSTRUCTIONS, /YOU remain the leader/);
});

test("Spanish input survives a UTF-8 character split across HTTP chunks", async t => {
  const f = await fixture(t); const a = await f.attach();
  const text = "Revisa la acción 🙂";
  const body = Buffer.from(JSON.stringify({ id: "unicode", text, revision: 1, origin: "voice" }));
  const cut = body.indexOf(Buffer.from("🙂")) + 2;
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: f.bridge.port, method: "POST", path: `/v1/live/attachments/${a.attachmentId}/inputs`, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.write(body.subarray(0, cut)); setImmediate(() => req.end(body.subarray(cut)));
  });
  assert.equal(status, 202); assert.equal(f.bridge.snapshot().conversation.messages[0].text, text);
});

test("real MCP SDK negotiation and notifications use Channels, not logging", async t => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "live-fixture", version: "1" }, { capabilities: { tools: {}, experimental: { "claude/channel": {} } }, instructions: LIVE_INSTRUCTIONS });
  const seen: any[] = [];
  const f = await fixture(t, { deliver: async (message: any) => { seen.push(message); await server.notification({ method: "notifications/claude/channel", params: message }); } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LIVE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: "text", text: JSON.stringify(f.bridge.callTool(req.params.name, req.params.arguments ?? {})) }] }));
  server.oninitialized = () => { void f.bridge.probeChannel(); };
  const client = new Client({ name: "host-fixture", version: "1" }, {});
  await server.connect(serverTransport); await client.connect(clientTransport); await turn();
  t.after(async () => { await client.close(); await server.close(); });
  assert.deepEqual(client.getServerCapabilities()?.experimental, { "claude/channel": {} });
  assert.equal((await client.listTools()).tools.length, 4);
  assert.equal(f.bridge.capabilities().capabilities.channelReady, false);
  await client.callTool({ name: "live_ack", arguments: { probe: seen[0].meta.probe } });
  assert.equal(f.bridge.capabilities().capabilities.channelReady, true);
});
