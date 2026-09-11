import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { evaluateLeaderTool, leaderEnvironment, normalizeLeaderPolicy, supportsLeaderRuntime } from "../hooks/live-leader-policy.mjs";
import { generateResumeWrapper, buildPlan } from "../lib/service-generator.ts";
import { LiveBridge } from "../lib/live-bridge.ts";
import { resolve, DEFAULT_ALLOWLIST_TOOLS } from "../lib/scope/exec-gate.ts";

const policy = { enabled: true, maxConcurrent: 3 };
const env = leaderEnvironment(policy, {});
const payload = (tool_name: string, tool_input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: "fixture-session", tool_name, tool_input, ...extra });
const denied = (value: any) => value.hookSpecificOutput?.permissionDecision === "deny";
const hook = fileURLToPath(new URL("../hooks/live-leader-pretool.mjs", import.meta.url));

test("main operational and unknown MCP tools are delegated; native workers preserve permission flow", () => {
  for (const tool of ["Bash", "Read", "Write", "Edit", "Grep", "WebFetch", "mcp__slow__search", "TeamCreate", "Workflow", "FutureTool"]) {
    assert.equal(denied(evaluateLeaderTool(payload(tool), policy, env)), true, tool);
    assert.deepEqual(evaluateLeaderTool(payload(tool, {}, { agent_id: "native-worker" }), policy, env), {}, tool);
  }
  assert.equal(denied(evaluateLeaderTool(payload("Bash", { agent_id: "forged-in-input" }), policy, env)), true);
  assert.deepEqual(evaluateLeaderTool(payload("Bash"), { enabled: false }, env), {});
  assert.deepEqual(evaluateLeaderTool(payload("Bash", {}, { hook_event_name: "PostToolUse" }), policy, env), {});
});

test("bounded coordination never grants permission and exact additions cannot override blocking restrictions", () => {
  for (const tool of ["AskUserQuestion", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "mcp__clawcode__live_ack", "mcp__plugin_agent_clawcode__live_emit"]) assert.deepEqual(evaluateLeaderTool(payload(tool), policy, env), {});
  assert.deepEqual(evaluateLeaderTool(payload("mcp__custom__bounded"), { ...policy, coordinationTools: ["mcp__custom__bounded"] }, env), {});
  assert.equal(denied(evaluateLeaderTool(payload("mcp__custom__bounded_extra"), { ...policy, coordinationTools: ["mcp__custom__bounded"] }, env)), true);
  assert.deepEqual(evaluateLeaderTool(payload("TaskOutput", { block: false }), policy, env), {});
  for (const block of [undefined, true, "false"]) assert.equal(denied(evaluateLeaderTool(payload("TaskOutput", { block }), { ...policy, coordinationTools: ["TaskOutput"] }, env)), true);
  for (const tool of ["Bash", "Agent", "TaskOutput", "mcp__clawcode__live_status"]) assert.equal(JSON.stringify(evaluateLeaderTool(payload(tool), policy, env)).includes('"allow"'), false);
});

test("guest channel replies retain the existing gate path while guest Agent remains blocked", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leader-guest-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const channel = path.join(root, "whatsapp"), envelopes = path.join(channel, ".request-envelopes");
  fs.mkdirSync(envelopes, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url"), now = Date.now();
  fs.writeFileSync(path.join(envelopes, `${token}.json`), JSON.stringify({ version: 1, token, senderId: "guest@s.whatsapp.net", chatId: "guest@s.whatsapp.net", ts: now, expiresAt: now + 60000 }), { mode: 0o600 });
  const ordinaryGate = (toolName: string) => resolve({ toolName, toolInput: {}, pluginRoot: root, workspaceRoot: root, memoryDir: path.join(root, "memory"), armed: [{ channel: "whatsapp", channelDir: channel, ownerJids: ["owner@s.whatsapp.net"], execGate: { mode: "enforce", policy: "allowlist", tools: [...DEFAULT_ALLOWLIST_TOOLS], lookbackMs: 60000 } }], now, effects: { isOwnerTrusted: () => false, legacyGlobalTrustExists: () => false, recordShadow: () => {} } });
  for (const tool of ["mcp__whatsapp__reply", "mcp__whatsapp__react"]) {
    assert.deepEqual(evaluateLeaderTool(payload(tool), policy, env), {});
    assert.equal(ordinaryGate(tool).decision, "allow");
  }
  assert.deepEqual(evaluateLeaderTool(payload("Agent"), policy, env), {});
  assert.equal(ordinaryGate("Agent").decision, "block", "New policy must not bypass the existing guest execution gate");
  assert.equal(denied(evaluateLeaderTool(payload("mcp__whatsapp__reply_anything"), policy, env)), true);
});

test("native delegation requires fork environment and matching spawn cap; teams and foreground rejected", () => {
  assert.deepEqual(evaluateLeaderTool(payload("Agent", { prompt: "Work" }), policy, env), {});
  assert.deepEqual(evaluateLeaderTool(payload("Task", { run_in_background: true }), policy, env), {});
  for (const input of [{ run_in_background: false }, { team_name: "team" }, { name: "teammate" }, { mode: "foreground" }]) assert.equal(denied(evaluateLeaderTool(payload("Agent", input), policy, env)), true);
  for (const broken of [{}, { ...env, CLAUDE_CODE_FORK_SUBAGENT: "0" }, { ...env, CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4" }, { ...env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "true" }]) assert.equal(denied(evaluateLeaderTool(payload("Agent"), policy, broken)), true);
  assert.deepEqual(evaluateLeaderTool(payload("SendMessage", { to: "native-worker", message: "Continue" }), policy, env), {});
  for (const input of [{ type: "broadcast" }, { broadcast: true }, { team_name: "team" }]) assert.equal(denied(evaluateLeaderTool(payload("SendMessage", input), policy, env)), true);
});

test("policy validates positive native cap, exact tool names and background conflicts; runtime baseline explicit", () => {
  for (const maxConcurrent of [0, -1, 1.5, "3", null, NaN, Infinity]) assert.throws(() => normalizeLeaderPolicy({ enabled: true, maxConcurrent }));
  for (const invalid of [{ enabled: "true" }, { enabled: true, coordinationTools: ["mcp__*"] }, { enabled: true, unexpected: true }]) assert.throws(() => normalizeLeaderPolicy(invalid));
  assert.deepEqual(leaderEnvironment(undefined, { UNRELATED: "preserved" }), { UNRELATED: "preserved" });
  assert.equal(env.CLAUDE_CODE_FORK_SUBAGENT, "1"); assert.equal(env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "3");
  for (const value of ["1", "true", "yes", "on"]) assert.throws(() => leaderEnvironment(policy, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: value }));
  assert.equal(supportsLeaderRuntime("2.1.268 (Claude Code)"), true); assert.equal(supportsLeaderRuntime("2.1.232"), true);
  for (const version of ["2.1.231", "2.0.900", "1.9.999", "not a version", "2.1.268 preview"]) assert.equal(supportsLeaderRuntime(version), false);
});

test("spawned synchronous hook works without HTTP, stays silent off, denies invalid enabled configuration", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leader-hook-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, "agent-config.json");
  const run = (data: unknown, override: Record<string, string> = {}) => spawnSync(process.execPath, [hook], { encoding: "utf8", input: typeof data === "string" ? data : JSON.stringify(data), env: { ...process.env, ...env, CLAUDE_PROJECT_DIR: root, CLAWCODE_LIVE_LEADER_POLICY: "", ...override }, timeout: 3000 });
  assert.equal(run(payload("Bash")).stdout, "");
  fs.writeFileSync(configFile, JSON.stringify({ liveBridge: { enabled: false, leaderPolicy: policy } })); assert.equal(run(payload("Bash")).stdout, "");
  fs.writeFileSync(configFile, JSON.stringify({ liveBridge: { enabled: true, leaderPolicy: policy, port: 1 } }));
  const main = run(payload("Bash")); assert.equal(main.status, 0); assert.equal(denied(JSON.parse(main.stdout)), true); assert.equal(main.stderr, "");
  assert.deepEqual(JSON.parse(run(payload("Bash", {}, { agent_id: "worker" })).stdout), {});
  assert.deepEqual(JSON.parse(run(payload("Agent")).stdout), {});
  fs.writeFileSync(configFile, JSON.stringify({ liveBridge: { enabled: true, leaderPolicy: { enabled: true, maxConcurrent: 0 } } })); assert.equal(denied(JSON.parse(run(payload("Agent")).stdout)), true);
  fs.writeFileSync(configFile, "invalid-json");
  assert.equal(run(payload("Bash")).stdout, "", "An unconfigured legacy installation is unchanged");
  assert.equal(denied(JSON.parse(run(payload("Bash"), { CLAWCODE_LIVE_LEADER_POLICY: "1" }).stdout)), true);
});

test("generated service applies configured native flags, preserves permission args and rejects old runtime", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leader-service-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binary = path.join(root, "fake-claude.mjs");
  fs.writeFileSync(binary, `#!${process.execPath}\nif(process.argv.includes('--version'))console.log(process.env.FIXTURE_CLAUDE_VERSION || '2.1.268 (Claude Code)'); else console.log(JSON.stringify({args:process.argv.slice(2),fork:process.env.CLAUDE_CODE_FORK_SUBAGENT,cap:process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS}));\n`, { mode: 0o755 });
  const wrapper = path.join(root, "wrapper.sh"), configFile = path.join(root, "agent-config.json");
  fs.writeFileSync(wrapper, generateResumeWrapper({ workspace: root, claudeBin: binary, logPath: path.join(root, "log"), forceFreshFlagPath: path.join(root, "fresh"), extraArgs: ["--chrome"] }));
  const run = (extra: Record<string, string> = {}) => spawnSync("bash", [wrapper], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(root, "config"), CLAUDE_CODE_FORK_SUBAGENT: "", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "", CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "", ...extra }, timeout: 5000 });
  fs.writeFileSync(configFile, JSON.stringify({ liveBridge: { enabled: true, leaderPolicy: policy } }));
  const result = run(); assert.equal(result.status, 0, result.stderr); const observed = JSON.parse(result.stdout);
  assert.equal(observed.fork, "1"); assert.equal(observed.cap, "3"); assert.deepEqual(observed.args, ["--dangerously-skip-permissions", "--chrome"]);
  assert.equal(run({ FIXTURE_CLAUDE_VERSION: "2.1.100" }).status, 78);
  assert.equal(run({ FIXTURE_CLAUDE_VERSION: "unknown" }).status, 78);
  assert.equal(run({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" }).status, 78);
  fs.writeFileSync(configFile, JSON.stringify({ liveBridge: { enabled: true, leaderPolicy: { enabled: true, maxConcurrent: "3" } } })); assert.equal(run().status, 78);
  fs.writeFileSync(configFile, JSON.stringify({ liveBridge: { enabled: false, leaderPolicy: policy } }));
  const inactive = run({ FIXTURE_CLAUDE_VERSION: "old version" }); assert.equal(inactive.status, 0); assert.equal(JSON.parse(inactive.stdout).fork, "");
  fs.writeFileSync(configFile, "invalid-json"); assert.equal(run().status, 0, "Unconfigured legacy wrapper preserves its existing malformed-config behavior");
  fs.writeFileSync(wrapper, generateResumeWrapper({ workspace: root, claudeBin: binary, logPath: path.join(root, "log"), forceFreshFlagPath: path.join(root, "fresh"), leaderPolicy: policy }));
  assert.equal(run().status, 78, "Generated policy-aware wrapper must not silently disable malformed configuration");
  const plan = buildPlan("install", { workspace: root, claudeBin: binary, platform: "linux", resumeOnRestart: false, selfHeal: false, leaderPolicy: policy });
  assert.equal(plan.extraFiles?.length, 1, "Policy startup remains present even when automatic resume is disabled");
});

test("policy snapshot reports configuration separately from unobserved native enforcement", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leader-metadata-"));
  const bridge = new LiveBridge({ workspace: root, dataDir: path.join(root, "state"), token: "synthetic-fixture-only-token-".repeat(2), port: 0, agent: { id: "fixture", name: "Fixture" }, deliver: async () => {}, leaderPolicy: policy });
  await bridge.start(); t.after(async () => { await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const expected = { configured: true, maxConcurrent: 3, hookObserved: false, runtimeConfirmed: false, limitSemantics: "native_spawn_limit", resumedAgentsCounted: false, automaticQueue: false };
  assert.deepEqual(bridge.capabilities().leaderPolicy, expected);
  assert.deepEqual(bridge.snapshot().conversation.capabilities.leaderPolicy, expected);
  await bridge.probeChannel();
  assert.equal(bridge.snapshot().conversation.capabilities.leaderPolicy?.runtimeConfirmed, false);
});
