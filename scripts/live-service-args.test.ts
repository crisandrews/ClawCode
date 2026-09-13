import test from "node:test";
import assert from "node:assert/strict";
import { withLiveChannel } from "../lib/service-generator.ts";
import { generateResumeWrapper } from "../lib/service-generator.ts";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

test("Live service plans retain existing channels, session and permission arguments", () => {
  const args = ["--resume", "native-id", "--chrome", "--permission-mode", "default", "--channels", "plugin:telegram@official", "--dangerously-load-development-channels", "plugin:whatsapp@claude-whatsapp"];
  const combined = withLiveChannel(args);
  assert.deepEqual(combined.slice(0, args.length), args);
  assert.deepEqual(combined.slice(args.length), ["--dangerously-load-development-channels", "plugin:agent@clawcode"]);
  assert.ok(!combined.includes("--dangerously-skip-permissions"));
  assert.deepEqual(withLiveChannel(combined), combined);
  assert.deepEqual(withLiveChannel(["--dangerously-load-development-channels", "plugin:whatsapp@claude-whatsapp", "plugin:agent@clawcode"]), ["--dangerously-load-development-channels", "plugin:whatsapp@claude-whatsapp", "plugin:agent@clawcode"]);
  assert.deepEqual(withLiveChannel(["--channels=server:clawcode"], "server:clawcode"), ["--channels=server:clawcode"]);
  assert.throws(() => withLiveChannel(["--dangerously-load-development-channels", "plugin:claude-live@claude-live"]), /already owns/);
  assert.throws(() => withLiveChannel([], "server:clawcode;bad"), /Invalid/);
  assert.throws(() => withLiveChannel([], "plugin:claude-live@claude-live"), /already owns/);
});

test("Live channel options precede the CLI terminator and preserve all positional text", () => {
  const target = "plugin:agent@clawcode";
  const prefix = ["--resume", "native-id", "--chrome"];
  for (const positional of [
    [],
    ["continue this task"],
    ["--channels", target],
    [`--dangerously-load-development-channels=${target}`],
    ["--channels=plugin:claude-live@claude-live", "--dangerously-load-development-channels", "plugin:claude-live@claude-live"],
  ]) {
    const args = [...prefix, "--", ...positional];
    const original = [...args];
    const expected = [...prefix, "--dangerously-load-development-channels", target, "--", ...positional];
    assert.deepEqual(withLiveChannel(args), expected);
    assert.deepEqual(args, original, "the supplied argument vector must remain unchanged");
    assert.deepEqual(withLiveChannel(expected), expected);
  }
  assert.deepEqual(withLiveChannel(["--", "prompt"]), ["--dangerously-load-development-channels", target, "--", "prompt"]);
});

test("Live channel detection stops at the CLI terminator even when a channel is already present", () => {
  const target = "server:clawcode";
  for (const channelArgs of [
    ["--channels", target],
    [`--channels=${target}`],
    ["--dangerously-load-development-channels", "plugin:whatsapp@claude-whatsapp", target],
  ]) {
    const args = [...channelArgs, "--", "--channels", "plugin:claude-live@claude-live"];
    assert.deepEqual(withLiveChannel(args, target), args);
  }
  assert.throws(() => withLiveChannel(["--channels", "plugin:claude-live@claude-live", "--", "prompt"]), /already owns/);
});

test("managed service web settings override global plugin options without exporting credential values", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "live-service-env-")));
  try {
    const fakeClaude = path.join(dir, "claude.mjs"), wrapper = path.join(dir, "start.sh");
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
if (process.argv.includes('--version')) console.log('2.1.270 (Claude Code)');
else console.log(JSON.stringify({port:process.env.CLAUDE_LIVE_PORT,mode:process.env.CLAUDE_LIVE_HOST_BRIDGE,file:process.env.CLAUDE_LIVE_ENV_FILE,token:process.env.CLAUDE_LIVE_BRIDGE_TOKEN,url:process.env.CLAUDE_LIVE_BRIDGE_URL,globalOption:process.env.CLAUDE_PLUGIN_OPTION_WEB_PORT,limit:process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS}));
`, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "agent-config.json"), JSON.stringify({ liveBridge: { enabled: true, port: 18791, webPort: 4322, tokenFile: path.join(dir, ".clawcode-live", "bridge.token"), leaderPolicy: { enabled: true, tools: "host_native", maxConcurrent: 6 } } }));
    const source = generateResumeWrapper({ claudeBin: fakeClaude, workspace: dir, resumeOnRestart: false, logPath: path.join(dir, "log"), forceFreshFlagPath: path.join(dir, "fresh") });
    fs.writeFileSync(wrapper, source);
    const result = spawnSync("bash", [wrapper], { env: { ...process.env, CLAUDE_PLUGIN_OPTION_WEB_PORT: "4321", CLAUDE_LIVE_PORT: "4321", CLAUDE_LIVE_BRIDGE_TOKEN: "stale-fixture-value", CLAUDE_LIVE_BRIDGE_URL: "http://127.0.0.1:19999" }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.port, "4322"); assert.equal(observed.mode, "0");
    assert.equal(observed.file, path.join(dir, ".clawcode-live", "claude-live.env"));
    assert.equal(observed.globalOption, "4321", "shared plugin settings are preserved");
    assert.equal(observed.limit, "6"); assert.equal(observed.token, undefined); assert.equal(observed.url, undefined);
    assert.ok(!source.includes("stale-fixture-value"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
