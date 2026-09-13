/** Real MCP subprocesses; all configuration, credentials and hook evidence are synthetic. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { applyLiveSetup, createLiveSetupPlan } from "../lib/live-setup.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail(`Timed out waiting for ${label}`);
}

async function listening(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeListener(server: net.Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function unusedPorts() {
  const servers = [net.createServer(), net.createServer()];
  try { return await Promise.all(servers.map(server => listening(server))); }
  finally { await Promise.all(servers.map(closeListener)); }
}

function treeSnapshot(directory: string): Record<string, { hash: string; mode: number }> {
  const result: Record<string, { hash: string; mode: number }> = {};
  if (!fs.existsSync(directory)) return result;
  const visit = (relative: string) => {
    const filename = path.join(directory, relative), stat = fs.lstatSync(filename);
    if (stat.isDirectory()) {
      result[`${relative}/`] = { hash: "directory", mode: stat.mode & 0o777 };
      for (const child of fs.readdirSync(filename).sort()) visit(path.join(relative, child));
    } else result[relative] = { hash: digest(fs.readFileSync(filename)), mode: stat.mode & 0o777 };
  };
  visit("");
  return result;
}

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-setup-mcp-"));
  const workspace = path.join(directory, "workspace"), homeDirectory = path.join(directory, "home");
  const claudeDirectory = path.join(homeDirectory, ".claude"), tempDirectory = path.join(directory, "tmp");
  for (const item of [workspace, claudeDirectory, tempDirectory]) fs.mkdirSync(item, { recursive: true, mode: 0o700 });
  const configPath = path.join(workspace, "agent-config.json");
  fs.writeFileSync(configPath, JSON.stringify({ memory: { backend: "builtin" }, http: { enabled: false }, voice: { enabled: false }, fixtureSetting: "preserve me" }), { mode: 0o600 });
  const [bridgePort, webPort] = await unusedPorts();
  // StdioClientTransport otherwise inherits HOME/PATH. Override the entire
  // inherited identity explicitly; never inherit provider or messaging secrets.
  const env = {
    HOME: homeDirectory, CLAUDE_CONFIG_DIR: claudeDirectory,
    CLAUDE_PROJECT_DIR: workspace, CLAUDE_PLUGIN_ROOT: repository, OLDPWD: workspace,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tempDirectory,
    XDG_CONFIG_HOME: path.join(homeDirectory, ".config"), XDG_DATA_HOME: path.join(homeDirectory, ".local", "share"),
    USER: "live-setup-fixture", LOGNAME: "live-setup-fixture", SHELL: "/bin/sh", TERM: "dumb",
  };
  const transports = new Set<StdioClientTransport>();
  t.after(async () => {
    for (const transport of transports) await transport.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const client = new Client({ name: "live-setup-isolated-fixture", version: "1.0.0" }, { capabilities: {} });
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), path.join(repository, "server.ts")], cwd: workspace, env, stderr: "pipe" });
    transports.add(transport);
    const notifications: any[] = [];
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-12000); });
    client.fallbackNotificationHandler = async event => { if (event.method === "notifications/claude/channel") notifications.push(event.params); };
    await client.connect(transport, { timeout: 12000 });
    return {
      client, notifications, stderr: () => stderr,
      async call(name: string, args: Record<string, unknown> = {}) {
        const result = await client.callTool({ name, arguments: args });
        const text = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
        return { result, text, json: () => JSON.parse(text) as any };
      },
      async close() { await client.close(); await transport.close(); transports.delete(transport); },
    };
  };
  const managed = async (enabled = true) => {
    const options = { enabled: true, bridgePort, webPort, maxConcurrent: 5, extraArgs: ["--continue", "--chrome", "--channels", "plugin:whatsapp@claude-whatsapp"] };
    // Fixture preparation invokes the same local apply helper as the trusted
    // skill. It writes temporary files only; it installs/starts nothing.
    const plan = await createLiveSetupPlan(workspace, options, { env: {} });
    const applied = await applyLiveSetup(workspace, { ...options, expectedFingerprint: plan.fingerprint }, { env: {} });
    assert.equal(applied.servicesStarted, false);
    if (!enabled) {
      const disabledOptions = { ...options, enabled: false };
      const disabled = await createLiveSetupPlan(workspace, disabledOptions, { env: {} });
      await applyLiveSetup(workspace, { ...disabledOptions, expectedFingerprint: disabled.fingerprint }, { env: {} });
    }
    return { token: fs.readFileSync(plan.paths.tokenFile, "utf8").trim(), plan };
  };
  const hook = async (payload: Record<string, unknown>) => {
    const child = spawn(process.execPath, [path.join(repository, "hooks", "live-observe.mjs")], { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 4000);
    let output = "";
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { output += String(chunk); });
    try {
      const completion = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      child.stdin.end(JSON.stringify(payload));
      assert.equal(await completion, 0);
      assert.equal(output, "", "The metadata collector must not print hook inputs or credentials");
    } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  };
  return { directory, workspace, homeDirectory, configPath, bridgePort, webPort, start, managed, hook };
}

test("real MCP discovers readonly onboarding before Live exists; plans and generic config calls cannot activate it", { timeout: 20000 }, async t => {
  const f = await fixture(t), mcp = await f.start();
  const tools = (await mcp.client.listTools()).tools.map(tool => tool.name);
  assert.ok(tools.includes("live_setup_plan") && tools.includes("live_setup_status"));
  assert.equal(tools.includes("live_ack"), false);
  assert.equal(tools.includes("live_setup_apply"), false, "Applying setup requires the owner-authorized local helper");
  assert.equal(mcp.client.getServerCapabilities()?.experimental?.["claude/channel"], undefined);
  assert.match(mcp.client.getInstructions() ?? "", /\/agent:live/);
  const configBefore = fs.readFileSync(f.configPath), homeBefore = treeSnapshot(f.homeDirectory);
  const launchArgs = ["--continue", "--chrome", "--channels", "plugin:whatsapp@claude-whatsapp"];
  const response = await mcp.call("live_setup_plan", { bridgePort: f.bridgePort, webPort: f.webPort, maxConcurrent: 5, extraArgs: launchArgs });
  assert.equal(response.result.isError, undefined);
  const plan = response.json();
  assert.equal(plan.status.configured, false);
  assert.equal(plan.status.enabled, false);
  assert.equal(plan.status.runtimeActive, false);
  assert.equal(plan.status.channelVerified, null);
  assert.equal(plan.status.credential, "missing");
  assert.equal(plan.options.bridgePort, f.bridgePort);
  assert.equal(plan.options.webPort, f.webPort);
  assert.equal(plan.options.maxConcurrent, 5);
  assert.equal(plan.pluginConfig.connect_session, false);
  assert.equal(plan.appliesServices, false);
  assert.deepEqual(plan.launch.args.slice(0, launchArgs.length), launchArgs);
  assert.deepEqual(plan.launch.args.slice(launchArgs.length), ["--dangerously-load-development-channels", "plugin:agent@clawcode"]);
  assert.equal(fs.existsSync(plan.paths.tokenFile), false);
  assert.equal(fs.existsSync(plan.paths.envFile), false);
  assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live")), false);
  for (const [key, value] of [["liveBridge", { enabled: true }], ["liveBridge.enabled", true]] as const) {
    const refused = await mcp.call("agent_config", { action: "set", key, value });
    assert.equal(refused.result.isError, true);
    assert.match(refused.text, /\/agent:live setup/);
    assert.match(refused.text, /live_setup_plan/);
  }
  assert.deepEqual(fs.readFileSync(f.configPath), configBefore);
  assert.deepEqual(treeSnapshot(f.homeDirectory), homeBefore);
  assert.equal(mcp.notifications.length, 0, "Readonly setup must not publish probes");
  await mcp.close();
});

test("disabled setup status distinguishes a synthetic TCP listener from an active MCP host and preserves protected files", { timeout: 20000 }, async t => {
  const f = await fixture(t), { token } = await f.managed(false), mcp = await f.start();
  const before = treeSnapshot(path.join(f.workspace, ".clawcode-live")), configBefore = digest(fs.readFileSync(f.configPath));
  const first = await mcp.call("live_setup_status"), status = first.json();
  assert.equal(status.configured, true);
  assert.equal(status.enabled, false);
  assert.equal(status.managed, true);
  assert.equal(status.credential, "file");
  assert.equal(status.bridgePort, f.bridgePort);
  assert.equal(status.webPort, f.webPort);
  assert.equal(status.bridgeListener, "not_listening");
  assert.equal(status.webListener, "not_listening");
  assert.equal(status.runtimeActive, false);
  assert.equal(status.channelVerified, null);
  assert.equal(status.restartPending, false);
  assert.equal(status.handshake, undefined);
  const unrelated = net.createServer(socket => socket.end());
  t.after(() => closeListener(unrelated));
  await listening(unrelated, f.bridgePort);
  const second = await mcp.call("live_setup_status"), listeningStatus = second.json();
  assert.equal(listeningStatus.bridgeListener, "listening");
  assert.equal(listeningStatus.runtimeActive, false);
  assert.equal(listeningStatus.channelVerified, null);
  assert.equal(listeningStatus.listenerIdentity, "unverified");
  const plan = await mcp.call("live_setup_plan", { enabled: false, extraArgs: [] });
  for (const output of [first.text, second.text, plan.text, mcp.stderr()]) assert.equal(output.includes(token), false, "Secrets must stay in protected local files");
  assert.deepEqual(treeSnapshot(path.join(f.workspace, ".clawcode-live")), before);
  assert.equal(digest(fs.readFileSync(f.configPath)), configBefore);
  assert.equal((await mcp.client.listTools()).tools.some(tool => tool.name === "live_ack"), false);
  assert.equal(mcp.notifications.length, 0);
  await mcp.close();
  assert.equal(unrelated.listening, true, "Closing MCP does not stop an unrelated listener");
  await closeListener(unrelated);
});

test("real MCP loads a managed tokenFile and recovers a lost probe; only matching synthetic native hook completes verification", { timeout: 22000 }, async t => {
  const f = await fixture(t), { token } = await f.managed(), mcp = await f.start();
  const names = (await mcp.client.listTools()).tools.map(tool => tool.name);
  for (const name of ["live_setup_plan", "live_setup_status", "live_ack", "live_status"]) assert.ok(names.includes(name));
  assert.deepEqual(mcp.client.getServerCapabilities()?.experimental?.["claude/channel"], {});
  const initial = (await mcp.call("live_setup_status")).json();
  assert.equal(initial.enabled, true);
  assert.equal(initial.credential, "file");
  assert.equal(initial.runtimeActive, true);
  assert.equal(initial.bridgeListener, "listening");
  assert.equal(initial.channelVerified, false);
  assert.equal(initial.handshake.status, "awaiting_receipt");
  // Deliberately do not acknowledge the first notification. The real MCP
  // server must retry the same nonce without treating its own send as receipt.
  await until(() => mcp.notifications.filter(event => event.meta?.source === "live_probe").length >= 2, "bounded second channel probe");
  const probes = mcp.notifications.filter(event => event.meta?.source === "live_probe");
  const probe = probes[0].meta.probe;
  assert.equal(typeof probe, "string");
  assert.ok(probe.length > 20);
  assert.equal(probes[1].meta.probe, probe);
  const ack = (await mcp.call("live_ack", { probe })).json();
  assert.equal(ack.channelReady, false, "An MCP tool receipt alone cannot verify a native session");
  const waiting = await mcp.call("live_setup_status");
  assert.equal(waiting.json().channelVerified, false);
  assert.equal(waiting.json().handshake.status, "awaiting_hook");
  assert.equal(waiting.json().handshake.automaticRetriesRemaining, 0);
  const count = mcp.notifications.length;
  for (let i = 0; i < 3; i++) await mcp.call("live_setup_status");
  assert.equal(mcp.notifications.length, count, "Setup status never publishes probes");
  // This is synthetic hook evidence, not a real Claude CLI validation. The
  // actual collector reads tokenFile and sends its sanitized observation.
  await f.hook({ hook_event_name: "PostToolUse", session_id: "setup-mcp-synthetic-session", tool_name: "mcp__agent__live_ack", tool_input: { probe } });
  await until(async () => (await mcp.call("live_setup_status")).json().channelVerified === true, "matching synthetic hook binding");
  const verified = await mcp.call("live_setup_status");
  assert.equal(verified.json().handshake.status, "ready");
  assert.equal(verified.json().handshake.automaticRetriesRemaining, 0);
  assert.equal((await mcp.call("live_ack", { probe })).json().channelReady, true, "Repeated probe acknowledgements are idempotent");
  const caps = await fetch(`http://127.0.0.1:${f.bridgePort}/v1/live/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(caps.status, 200, "The server used the protected credential file without an environment token");
  assert.equal((await caps.json() as any).capabilities.channelReady, true);
  for (const output of [waiting.text, verified.text, JSON.stringify(initial), mcp.stderr()]) {
    assert.equal(output.includes(token), false);
    assert.equal(output.includes(probe), false, "Status and diagnostics must not disclose the channel nonce");
  }
  await mcp.close();
  const replacement = net.createServer();
  t.after(() => closeListener(replacement));
  assert.equal(await listening(replacement, f.bridgePort), f.bridgePort, "The fixture MCP listener closes with its process");
  await closeListener(replacement);
});
