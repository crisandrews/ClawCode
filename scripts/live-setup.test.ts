import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyLiveSetup, createLiveSetupPlan, getLiveSetupStatus, readLiveToken, type LiveSetupOptions, type LiveSetupRuntime } from "../lib/live-setup.ts";

function fixture(t: any, config?: unknown) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-setup-test-")));
  const home = path.join(workspace, "test-home"); fs.mkdirSync(home);
  const runtime: LiveSetupRuntime = { env: {}, detection: { home, env: {} } };
  const configPath = path.join(workspace, "agent-config.json");
  if (config !== undefined) fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { workspace, runtime, configPath,
    plan: (options: LiveSetupOptions = {}) => createLiveSetupPlan(workspace, options, runtime),
    apply: async (options: LiveSetupOptions = {}) => {
      const plan = await createLiveSetupPlan(workspace, options, runtime);
      return applyLiveSetup(workspace, { ...options, expectedFingerprint: plan.fingerprint }, runtime);
    } };
}
const readConfig = (filename: string) => JSON.parse(fs.readFileSync(filename, "utf8"));
const fixtureToken = "fixture-private-not-production-" + "x".repeat(32);

test("plan/status are read-only while disabled, redact credentials and distinguish readiness", async t => {
  const f = fixture(t, { memory: { backend: "builtin" }, http: { token: "unrelated-secret" } });
  const before = fs.readFileSync(f.configPath, "utf8"), inventory = fs.readdirSync(f.workspace);
  const plan = await f.plan();
  assert.deepEqual(fs.readdirSync(f.workspace), inventory);
  assert.equal(fs.readFileSync(f.configPath, "utf8"), before);
  assert.equal(plan.status.enabled, false); assert.equal(plan.status.channelVerified, null);
  assert.equal(plan.status.runtimeActive, null); assert.equal(plan.status.credential, "missing");
  assert.equal(plan.appliesServices, false); assert.equal(plan.launch.argumentsConfirmed, false);
  assert.equal(JSON.stringify(plan).includes("unrelated-secret"), false);
  assert.equal(plan.pluginConfig.connect_session, false);
  assert.match(plan.commands.apply, /node_modules\/\.bin\/tsx/);
  assert.equal(plan.commands.apply.includes("npx"), false);
  assert.match(plan.commands.install, /--scope' 'local/);
  assert.equal(plan.commands.install.includes("--config"), false);
  assert.equal(plan.launch.env.CLAUDE_LIVE_HOST_BRIDGE, "0");
  assert.deepEqual(plan.launch.unsetEnv, ["CLAUDE_LIVE_BRIDGE_URL", "CLAUDE_LIVE_BRIDGE_TOKEN", "CLAUDE_LIVE_DEFAULT_MODE"]);
  assert.match(plan.commands.launch, /'-u' 'CLAUDE_LIVE_BRIDGE_TOKEN'/);
  assert.equal((await getLiveSetupStatus(f.workspace, { ...f.runtime, listenerActive: false, channelVerified: true })).channelVerified, null);
});

test("apply atomically preserves unrelated and unknown config, credentials stay private, no runtime starts", async t => {
  const original = { memory: { backend: "builtin", extraPaths: ["preserve"] }, scope: { whatsapp: { mode: "enforce" } }, extraArgs: ["--chrome", "--resume", "native-session"],
    http: { token: "unrelated-secret" }, liveBridge: { enabled: false, future: { keep: true }, leaderPolicy: { custom: 42, coordinationTools: ["memory_search"] } } };
  const f = fixture(t, original);
  const result = await f.apply({ webPort: 4321, maxConcurrent: 6, extraArgs: original.extraArgs });
  const config = readConfig(f.configPath);
  assert.deepEqual({ ...config, liveBridge: original.liveBridge }, original);
  assert.equal(config.liveBridge.enabled, true); assert.equal(config.liveBridge.leaderPolicy.tools, "host_native");
  assert.equal(config.liveBridge.leaderPolicy.custom, 42); assert.deepEqual(config.liveBridge.future, { keep: true });
  assert.equal(config.liveBridge.leaderPolicy.maxConcurrent, 6); assert.equal(config.liveBridge.channelTarget, "plugin:agent@clawcode");
  assert.equal(result.servicesStarted, false); assert.equal(result.changed, true);
  const token = readLiveToken(f.workspace, config.liveBridge)!;
  assert.ok(token.length >= 32); assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(fs.readFileSync(result.envFile, "utf8"), /^CLAUDE_LIVE_DEFAULT_MODE=external$/m);
  assert.equal(fs.readFileSync(result.envFile, "utf8").includes("CLAUDE_LIVE_DATA_DIR"), false);
  for (const filename of [result.tokenFile, result.envFile, path.join(f.workspace, ".clawcode-live/setup-owner.json")]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(result.tokenFile)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live/state.json")), false);
  assert.deepEqual(result.launch.args.slice(0, original.extraArgs.length), original.extraArgs);
});

test("idempotent repeat preserves token and config timestamps; port update preserves token", async t => {
  const f = fixture(t); const first = await f.apply();
  const token = fs.readFileSync(first.tokenFile, "utf8"), stat = fs.statSync(f.configPath);
  const second = await f.apply();
  assert.equal(second.changed, false); assert.equal(fs.statSync(f.configPath).mtimeMs, stat.mtimeMs);
  assert.equal(fs.readFileSync(second.tokenFile, "utf8"), token);
  await f.apply({ webPort: 4321 });
  assert.equal(fs.readFileSync(first.tokenFile, "utf8"), token);
  assert.equal((await f.plan()).options.webPort, 4321);
});

test("invalid config/schema/ports abort before any setup writes", async t => {
  const f = fixture(t);
  for (const raw of ["{bad", "[]", '{"liveBridge":false}', '{"liveBridge":{"leaderPolicy":[]}}']) {
    fs.writeFileSync(f.configPath, raw);
    await assert.rejects(f.plan()); assert.equal(fs.readFileSync(f.configPath, "utf8"), raw);
    assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live")), false);
  }
  fs.writeFileSync(f.configPath, "{}");
  for (const options of [{ bridgePort: 0 }, { webPort: 65536 }, { bridgePort: 4321, webPort: 4321 }, { maxConcurrent: 101 }, { extraArgs: ["hello\nworld"] }, { liveChannelTarget: "server:x;bad" }]) await assert.rejects(f.plan(options));
});

test("config and option fingerprints reject stale plans without overwriting concurrent changes", async t => {
  const f = fixture(t, { memory: { citations: "auto" } }); const plan = await f.plan();
  fs.writeFileSync(f.configPath, '{"memory":{"citations":"off"}}');
  await assert.rejects(applyLiveSetup(f.workspace, { expectedFingerprint: plan.fingerprint }, f.runtime), /stale/);
  assert.equal(readConfig(f.configPath).memory.citations, "off");
  const fresh = await f.plan({ webPort: 4321 });
  await assert.rejects(applyLiveSetup(f.workspace, { expectedFingerprint: fresh.fingerprint, webPort: 4322 }, f.runtime), /stale/);
  assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live")), false);
});

test("legacy migration reuses exact environment credential, missing credential blocks enabling only", async t => {
  const f = fixture(t, { liveBridge: { enabled: true, tokenEnv: "LEGACY_LIVE_TOKEN", port: 18791 } });
  assert.match((await f.plan()).blockers.join(" "), /credential is missing/);
  await assert.rejects(f.apply(), /credential is missing/);
  f.runtime.env = { LEGACY_LIVE_TOKEN: fixtureToken };
  const plan = await f.plan(); assert.equal(JSON.stringify(plan).includes(fixtureToken), false);
  f.runtime.env.LEGACY_LIVE_TOKEN = fixtureToken + "y";
  await assert.rejects(applyLiveSetup(f.workspace, { expectedFingerprint: plan.fingerprint }, f.runtime), /stale/);
  f.runtime.env.LEGACY_LIVE_TOKEN = fixtureToken;
  await f.apply(); const config = readConfig(f.configPath);
  assert.equal(config.liveBridge.tokenEnv, undefined);
  assert.equal(readLiveToken(f.workspace, config.liveBridge, { LEGACY_LIVE_TOKEN: "different-value" }), fixtureToken);
});

test("disable only changes enabled, keeps history and credential, and reports pending host restart", async t => {
  const f = fixture(t); const first = await f.apply();
  const config = readConfig(f.configPath), token = fs.readFileSync(first.tokenFile, "utf8"), env = fs.readFileSync(first.envFile, "utf8");
  const stateFile = path.join(f.workspace, ".clawcode-live/state.json"); fs.writeFileSync(stateFile, '{"history":"keep"}');
  await f.apply({ enabled: false });
  assert.deepEqual(readConfig(f.configPath), { ...config, liveBridge: { ...config.liveBridge, enabled: false } });
  assert.equal(fs.readFileSync(first.tokenFile, "utf8"), token); assert.equal(fs.readFileSync(first.envFile, "utf8"), env);
  assert.equal(fs.readFileSync(stateFile, "utf8"), '{"history":"keep"}');
  const status = await getLiveSetupStatus(f.workspace, { ...f.runtime, listenerActive: true, channelVerified: true });
  assert.equal(status.enabled, false); assert.equal(status.runtimeActive, true); assert.equal(status.restartPending, true);
  const legacy = fixture(t, { liveBridge: { enabled: true, tokenEnv: "MISSING_SECRET", future: "keep" } });
  await legacy.apply({ enabled: false });
  assert.deepEqual(readConfig(legacy.configPath), { liveBridge: { enabled: false, tokenEnv: "MISSING_SECRET", future: "keep" } });
  assert.equal(fs.existsSync(path.join(legacy.workspace, ".clawcode-live")), false);
});

test("public/symlink/shared token files are rejected and explicit tokenFile never falls back to env", async t => {
  const f = fixture(t); const result = await f.apply(); const config = readConfig(f.configPath);
  fs.chmodSync(result.tokenFile, 0o644);
  assert.throws(() => readLiveToken(f.workspace, config.liveBridge, { CLAWCODE_LIVE_TOKEN: fixtureToken }));
  await assert.rejects(f.plan());
  fs.chmodSync(result.tokenFile, 0o600);
  const backup = path.join(f.workspace, "original-token"); fs.renameSync(result.tokenFile, backup); fs.symlinkSync(backup, result.tokenFile);
  assert.throws(() => readLiveToken(f.workspace, config.liveBridge));
  fs.unlinkSync(result.tokenFile); fs.linkSync(backup, result.tokenFile);
  assert.throws(() => readLiveToken(f.workspace, config.liveBridge));
});

test("unowned files and symlink setup directories are never adopted or replaced", async t => {
  const f = fixture(t); const directory = path.join(f.workspace, ".clawcode-live"); fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "bridge.token"), fixtureToken, { mode: 0o600 });
  await assert.rejects(f.plan(), /Unowned/);
  assert.equal(fs.readFileSync(path.join(directory, "bridge.token"), "utf8"), fixtureToken);
  const g = fixture(t), elsewhere = path.join(g.workspace, "elsewhere"); fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, path.join(g.workspace, ".clawcode-live")); await assert.rejects(g.plan(), /symlink/);
});

test("owned credential substitution and wrong workspace metadata fail closed", async t => {
  const f = fixture(t); const result = await f.apply();
  fs.writeFileSync(result.tokenFile, fixtureToken);
  await assert.rejects(f.plan(), /credential changed/);
  const g = fixture(t); const second = await g.apply();
  const owner = path.join(path.dirname(second.tokenFile), "setup-owner.json"), metadata = readConfig(owner);
  fs.writeFileSync(owner, JSON.stringify({ ...metadata, workspace: f.workspace }));
  await assert.rejects(g.plan(), /ownership/);
});

test("rollback removes only files from failed first setup, preserving existing bridge data", async t => {
  const f = fixture(t, { memory: { backend: "builtin" } });
  const directory = path.join(f.workspace, ".clawcode-live"); fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, "state.json"), "history");
  const before = fs.readFileSync(f.configPath, "utf8"), rename = fs.renameSync;
  fs.renameSync = ((source: any, destination: any) => { if (destination === f.configPath) throw new Error("fixture write failure"); return rename(source, destination); }) as typeof fs.renameSync;
  try { await assert.rejects(f.apply(), /Setup failed/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.configPath, "utf8"), before);
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("failed reconfiguration restores the previous env and leaves config/token intact", async t => {
  const f = fixture(t); const first = await f.apply();
  const before = fs.readFileSync(f.configPath, "utf8"), env = fs.readFileSync(first.envFile, "utf8"), token = fs.readFileSync(first.tokenFile, "utf8");
  const rename = fs.renameSync;
  fs.renameSync = ((source: any, destination: any) => { if (destination === f.configPath) throw new Error("fixture write failure"); return rename(source, destination); }) as typeof fs.renameSync;
  try { await assert.rejects(f.apply({ maxConcurrent: 7, webPort: 4321 }), /Setup failed/); } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.configPath, "utf8"), before); assert.equal(fs.readFileSync(first.envFile, "utf8"), env);
  assert.equal(fs.readFileSync(first.tokenFile, "utf8"), token); assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live/setup.lock")), false);
});

test("occupied ports are observations only, not proof of a verified host", async t => {
  const f = fixture(t), server = net.createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as net.AddressInfo).port;
  const plan = await f.plan({ bridgePort: port, webPort: port === 4321 ? 4322 : 4321 });
  assert.equal(plan.preflight.bridgeListener, "listening"); assert.equal(plan.status.channelVerified, null);
  assert.equal(plan.status.listenerIdentity, "unverified"); assert.match(plan.blockers.join(" "), /unidentified listener/);
});

test("explicit launch argv preserves WhatsApp, permissions, resume and chrome exactly; no detected extra channel", async t => {
  const f = fixture(t);
  const args = ["--dangerously-skip-permissions", "--chrome", "--resume", "session-id", "--dangerously-load-development-channels", "plugin:whatsapp@claude-whatsapp"];
  const plan = await f.plan({ extraArgs: args, liveChannelTarget: "server:clawcode", maxConcurrent: 10 });
  assert.deepEqual(plan.launch.args, [...args, "--dangerously-load-development-channels", "server:clawcode"]);
  assert.equal(plan.launch.argumentsConfirmed, true); assert.equal(plan.launch.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, "10");
  assert.deepEqual((await f.plan({ extraArgs: [...args, "--dangerously-load-development-channels=plugin:agent@clawcode"] })).launch.args, [...args, "--dangerously-load-development-channels=plugin:agent@clawcode"]);
  await assert.rejects(f.plan({ extraArgs: ["--dangerously-load-development-channels", "plugin:claude-live@claude-live"] }), /second/);
  await assert.rejects(f.plan({ liveChannelTarget: "plugin:claude-live@claude-live" }), /second/);
  for (const flag of ["--channels", "--dangerously-load-development-channels"]) {
    const variadic = ["--chrome", flag, "plugin:whatsapp@claude-whatsapp", "plugin:agent@clawcode", "--resume", "session-id"];
    assert.deepEqual((await f.plan({ extraArgs: variadic })).launch.args, variadic);
  }
  assert.equal((await f.plan({ extraArgs: [] })).launch.args.includes("--dangerously-skip-permissions"), false);
});

test("CLI rejects missing workspace, duplicates and apply without fingerprint; quoting remains literal", async t => {
  const f = fixture(t), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/live-setup.ts", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, HOME: path.join(f.workspace, "test-home"), CLAWCODE_LIVE_TOKEN: "" } });
  for (const args of [["plan"], ["apply", "--workspace", f.workspace], ["plan", "--workspace", f.workspace, "--web-port", "4321", "--web-port", "4322"]]) assert.notEqual(run(args).status, 0);
  const unusual = path.join(f.workspace, "space ' dollar$(not-run)"); fs.mkdirSync(unusual);
  const plan = await createLiveSetupPlan(unusual, { extraArgs: ["--resume", "a'b$(not-run)"] }, f.runtime);
  assert.ok(plan.commands.apply.includes("'\"'\"'")); assert.ok(plan.launch.command.includes("'a'\"'\"'b$(not-run)'"));
  assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live")), false);
});

test("runtime config mismatches require restart even when the old channel was verified", async t => {
  const f = fixture(t); await f.apply(); const activeConfig = readConfig(f.configPath).liveBridge;
  const runtime = { ...f.runtime, listenerActive: true, channelVerified: true, bridgePort: activeConfig.port, activeConfig };
  const ready = await getLiveSetupStatus(f.workspace, runtime);
  assert.equal(ready.configurationMatchesRuntime, true); assert.equal(ready.channelVerified, true); assert.equal(ready.restartPending, false);
  await f.apply({ webPort: 4321, maxConcurrent: 9 });
  const changed = await getLiveSetupStatus(f.workspace, runtime);
  assert.equal(changed.configurationMatchesRuntime, false); assert.equal(changed.channelVerified, null); assert.equal(changed.restartPending, true);
  const port = await getLiveSetupStatus(f.workspace, { ...runtime, activeConfig: undefined, bridgePort: 18790 });
  assert.equal(port.configurationMatchesRuntime, false); assert.equal(port.restartPending, true);
  const legacy = fixture(t, { liveBridge: { enabled: true } });
  legacy.runtime.env = { CLAWCODE_LIVE_TOKEN: fixtureToken };
  const legacyRuntime = { ...legacy.runtime, listenerActive: true, channelVerified: true, bridgePort: 18791, activeConfig: { enabled: true } };
  assert.equal((await getLiveSetupStatus(legacy.workspace, legacyRuntime)).configurationMatchesRuntime, true);
  const proposed = await createLiveSetupPlan(legacy.workspace, { bridgePort: 19876 }, legacyRuntime);
  assert.equal(proposed.status.bridgePort, 18791); assert.equal(proposed.status.channelVerified, true);
  assert.equal(proposed.preflight.bridgePort, 19876);
});

test("a stale env file and live setup lock stop apply without replacing another writer", async t => {
  const f = fixture(t); const first = await f.apply(); const plan = await f.plan();
  fs.appendFileSync(first.envFile, "# external edit\n");
  await assert.rejects(applyLiveSetup(f.workspace, { expectedFingerprint: plan.fingerprint }, f.runtime), /stale/);
  const lock = path.join(f.workspace, ".clawcode-live/setup.lock"), lease = '{"pid":123,"nonce":"other-writer"}';
  fs.writeFileSync(lock, lease, { mode: 0o600 });
  await assert.rejects(f.apply()); assert.equal(fs.readFileSync(lock, "utf8"), lease);
});

test("config symlinks and public environment files fail closed", async t => {
  const f = fixture(t), elsewhere = path.join(f.workspace, "other-config"); fs.writeFileSync(elsewhere, "{}", { mode: 0o600 });
  fs.symlinkSync(elsewhere, f.configPath); await assert.rejects(f.plan(), /Config must/);
  const g = fixture(t); const result = await g.apply(); fs.chmodSync(result.envFile, 0o644);
  await assert.rejects(g.plan(), /private/);
});

test("legacy punctuation unrepresentable in env is blocked during planning without rotating it", async t => {
  const f = fixture(t, { liveBridge: { enabled: true, tokenEnv: "LEGACY" } });
  f.runtime.env = { LEGACY: fixtureToken + "#suffix" };
  const plan = await f.plan(); assert.match(plan.blockers.join(" "), /encoded safely/);
  await assert.rejects(f.apply(), /encoded safely/); assert.equal(fs.existsSync(path.join(f.workspace, ".clawcode-live")), false);
});
