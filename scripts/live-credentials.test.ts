import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readLiveToken } from "../lib/live-credentials.mjs";

const token = "managed-token-fixture-".repeat(3);
const staleToken = "stale-environment-fixture-".repeat(3);
function fixture(t: TestContext) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-live-credential-")));
  const directory = path.join(workspace, ".clawcode-live");
  fs.mkdirSync(directory, { mode: 0o700 }); fs.chmodSync(directory, 0o700);
  const tokenFile = path.join(directory, "bridge.token");
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 }); fs.chmodSync(tokenFile, 0o600);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return { workspace, directory, tokenFile, config: { tokenFile } };
}

test("managed file takes precedence over a stale environment and supports canonical workspace aliases", t => {
  const f = fixture(t);
  assert.equal(readLiveToken(f.workspace, f.config, { CLAWCODE_LIVE_TOKEN: staleToken }), token);
  const alias = path.join(f.workspace, "workspace-alias"); fs.symlinkSync(f.workspace, alias);
  assert.equal(readLiveToken(alias, { tokenFile: path.join(alias, ".clawcode-live/bridge.token") }), token);
});

test("explicit unsafe or missing token files never fall back to the environment or expose values", t => {
  const f = fixture(t);
  const check = (config = f.config) => assert.throws(() => readLiveToken(f.workspace, config, { CLAWCODE_LIVE_TOKEN: staleToken }), error => {
    assert.equal((error as Error).message, "Live credential is unavailable or unsafe; verify its managed file or token environment.");
    return true;
  });
  fs.chmodSync(f.tokenFile, 0o644); check(); fs.chmodSync(f.tokenFile, 0o600);
  fs.chmodSync(f.directory, 0o755); check(); fs.chmodSync(f.directory, 0o700);
  const hardlink = path.join(f.directory, "second-link"); fs.linkSync(f.tokenFile, hardlink); check(); fs.unlinkSync(hardlink);
  for (const value of ["short", token + " PRIVATE_SUFFIX", token + "\n\n", "x".repeat(4097), token + "\u0000"]) {
    fs.writeFileSync(f.tokenFile, value); check();
  }
  check({ tokenFile: path.join(f.workspace, "different.token") });
  check({ tokenFile: "relative/bridge.token" });
  fs.unlinkSync(f.tokenFile); check();
});

test("symlinked token or managed directory cannot redirect credential reads", t => {
  const f = fixture(t);
  const originalFile = path.join(f.directory, "original.token"); fs.renameSync(f.tokenFile, originalFile); fs.symlinkSync(originalFile, f.tokenFile);
  assert.throws(() => readLiveToken(f.workspace, f.config), /unavailable or unsafe/);
  fs.unlinkSync(f.tokenFile); fs.renameSync(originalFile, f.tokenFile);
  const originalDirectory = path.join(f.workspace, "original-directory"); fs.renameSync(f.directory, originalDirectory); fs.symlinkSync(originalDirectory, f.directory);
  assert.throws(() => readLiveToken(f.workspace, f.config), /unavailable or unsafe/);
});

test("legacy token environments remain usable without a file and invalid explicit configuration fails closed", () => {
  assert.equal(readLiveToken("unused-workspace", {}, { CLAWCODE_LIVE_TOKEN: token }), token);
  assert.equal(readLiveToken("unused-workspace", { tokenEnv: "CUSTOM_LIVE_TOKEN" }, { CUSTOM_LIVE_TOKEN: token }), token);
  assert.equal(readLiveToken("unused-workspace", {}, {}), undefined);
  for (const config of [{ tokenEnv: "NAME WITH SPACES" }, { tokenFile: undefined }, { tokenFile: "" }]) {
    assert.throws(() => readLiveToken("unused-workspace", config, { CLAWCODE_LIVE_TOKEN: token }), /unavailable or unsafe/);
  }
  for (const invalid of ["short", token + "\n", "x".repeat(4097)]) assert.throws(() => readLiveToken("unused-workspace", {}, { CLAWCODE_LIVE_TOKEN: invalid }), /unavailable or unsafe/);
});

async function runHook(workspace: string, env: Record<string, string>) {
  const script = fileURLToPath(new URL("../hooks/live-observe.mjs", import.meta.url));
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: workspace, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject); child.once("close", code => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "native-session", tool_name: "mcp__plugin_agent_clawcode__live_ack", tool_use_id: "probe-tool", tool_input: { probe: "fixture-probe", secret: "PRIVATE_TOOL_SECRET" } }));
  return result;
}

test("real plain-Node hook authenticates with the managed file and silently refuses unsafe files despite a stale environment", async t => {
  const f = fixture(t); const received: Array<{ authorization?: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => { received.push({ authorization: req.headers.authorization, body }); res.end("{}"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  fs.writeFileSync(path.join(f.workspace, "agent-config.json"), JSON.stringify({ liveBridge: { enabled: true, observeHooks: true, port: address.port, tokenFile: f.tokenFile } }));
  const environment = { CLAWCODE_LIVE_TOKEN: staleToken };
  assert.deepEqual(await runHook(f.workspace, environment), { code: 0, stdout: "", stderr: "" });
  assert.equal(received.length, 1); assert.equal(received[0].authorization, `Bearer ${token}`);
  const payload = JSON.parse(received[0].body); assert.equal(payload.probe, "fixture-probe");
  assert.equal(payload.toolUseId, "probe-tool"); assert.doesNotMatch(received[0].body, /PRIVATE_TOOL_SECRET/);
  fs.chmodSync(f.tokenFile, 0o644);
  assert.deepEqual(await runHook(f.workspace, environment), { code: 0, stdout: "", stderr: "" });
  assert.equal(received.length, 1, "invalid managed file cannot authenticate with the legacy environment instead");
  fs.chmodSync(f.tokenFile, 0o600);
  const actual = path.join(f.directory, "other.token"); fs.renameSync(f.tokenFile, actual); fs.symlinkSync(actual, f.tokenFile);
  assert.deepEqual(await runHook(f.workspace, environment), { code: 0, stdout: "", stderr: "" });
  assert.equal(received.length, 1);
  fs.writeFileSync(path.join(f.workspace, "agent-config.json"), JSON.stringify({ liveBridge: { enabled: true, observeHooks: true, port: address.port, tokenFile: actual } }));
  assert.deepEqual(await runHook(f.workspace, environment), { code: 0, stdout: "", stderr: "" });
  assert.equal(received.length, 1, "a private file outside the one managed token path is not an alternate credential source");
});
