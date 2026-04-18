/**
 * Smoke test for lib/service-generator.ts self-heal additions.
 *
 * Pure-function checks: plan assembly, generator output shape, and most
 * importantly `bash -n` syntax checks on every shell script we emit, so
 * a mistake in template interpolation surfaces before it gets copied onto
 * a user's system.
 *
 * Run: `npx tsx tests/service-generator-smoke.test.ts`
 * Exit code 0 = pass, 1 = fail.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildPlan,
  generateResumeWrapper,
  generateHealScript,
  generateHealSystemdService,
  generateHealSystemdTimer,
  generateHealLaunchdPlist,
  generateSystemdUnit,
  generatePlist,
  versionStampPathExpr,
  forceFreshFlagPath,
  healScriptPath,
  healServiceFilePath,
  healTimerFilePath,
  resumeWrapperPath,
  HEAL_PATTERN,
  HEAL_THRESHOLD,
  HEAL_WINDOW_SECONDS,
  HEAL_LOG_TAIL_LINES,
} from "../lib/service-generator.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, msg: (err as Error).message });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function bashSyntaxCheck(script: string, label: string) {
  const tmp = path.join(os.tmpdir(), `clawcode-smoke-${label}-${Date.now()}.sh`);
  fs.writeFileSync(tmp, script, { mode: 0o755 });
  try {
    const r = spawnSync("bash", ["-n", tmp], { encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`bash -n failed on ${label}: ${r.stderr || r.stdout}`);
    }
  } finally {
    fs.unlinkSync(tmp);
  }
}

// ---------------------------------------------------------------------------
// Fixtures, shared across checks
// ---------------------------------------------------------------------------
const linuxOpts = {
  workspace: "/home/tester/my-agent",
  claudeBin: "/usr/local/bin/claude",
  platform: "linux" as const,
};
const macOpts = {
  workspace: "/Users/tester/my-agent",
  claudeBin: "/usr/local/bin/claude",
  platform: "darwin" as const,
};
const slug = "my-agent";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

check("constants sanity", () => {
  assert(HEAL_PATTERN.includes("No deferred tool marker"), "pattern missing deferred-tool string");
  assert(HEAL_PATTERN.includes("Input must be provided"), "pattern missing input-required string");
  assert(HEAL_THRESHOLD >= 5 && HEAL_THRESHOLD <= 50, "threshold out of reasonable range");
  assert(HEAL_WINDOW_SECONDS >= 60 && HEAL_WINDOW_SECONDS <= 3600, "window out of reasonable range");
  assert(HEAL_LOG_TAIL_LINES >= 50 && HEAL_LOG_TAIL_LINES <= 1000, "tail lines out of reasonable range");
});

check("path helpers return absolute paths under ~/.clawcode", () => {
  const home = os.homedir();
  assert(forceFreshFlagPath(slug).startsWith(home), "flag path not under home");
  assert(healScriptPath(slug).startsWith(home), "script path not under home");
  assert(resumeWrapperPath(slug).startsWith(home), "wrapper path not under home");
  assert(healServiceFilePath("linux", slug).endsWith(`.service`), "linux heal unit not .service");
  assert(healTimerFilePath("linux", slug).endsWith(`.timer`), "linux heal timer not .timer");
  assert(healServiceFilePath("darwin", slug).endsWith(`.plist`), "mac heal unit not .plist");
  assert(healTimerFilePath("darwin", slug) === "", "mac has no timer file");
});

check("resume wrapper: bash syntax OK + includes self-heal checks", () => {
  const script = generateResumeWrapper({
    claudeBin: "/usr/local/bin/claude",
    workspace: "/home/tester/my-agent",
    logPath: "/home/tester/.clawcode/logs/my-agent.log",
    forceFreshFlagPath: "/home/tester/.clawcode/service/my-agent.force-fresh",
  });
  bashSyntaxCheck(script, "resume-wrapper");

  // The four pre-flight branches must all be present.
  assert(script.includes("FORCE_FRESH_FLAG"), "wrapper missing flag check");
  assert(script.includes("force-fresh flag present"), "wrapper missing flag skip_reason");
  assert(script.includes("no prior session jsonl"), "wrapper missing no-jsonl skip_reason");
  assert(script.includes("RESUME_STALE_DAYS=7"), "wrapper missing stale-days");
  assert(script.includes("HEAL_PATTERN"), "wrapper missing heal pattern");
  assert(script.includes("grep -Ec"), "wrapper missing grep -Ec");
  assert(script.includes("skipping --continue"), "wrapper missing breadcrumb log line");

  // The flag must be deleted BEFORE the decision, not after, so a crashed
  // start doesn't cause a perpetual fresh-start loop.
  const flagDeleteIdx = script.indexOf("rm -f \"$FORCE_FRESH_FLAG\"");
  const flagSkipIdx = script.indexOf("force-fresh flag present");
  assert(flagDeleteIdx > 0, "wrapper never deletes the flag");
  assert(flagDeleteIdx < flagSkipIdx, "wrapper sets skip_reason before deleting flag");
});

check("heal script linux: bash syntax OK + correct restart command", () => {
  const script = generateHealScript({
    serviceLabel: "clawcode-my-agent",
    logPath: "/home/tester/.clawcode/logs/my-agent.log",
    forceFreshFlagPath: "/home/tester/.clawcode/service/my-agent.force-fresh",
    platform: "linux",
    slug,
  });
  bashSyntaxCheck(script, "heal-linux");
  assert(script.includes("systemctl --user restart clawcode-my-agent"), "missing linux restart cmd");
  assert(!script.includes("launchctl"), "linux heal script leaked launchctl");
  assert(script.includes("touch \"$FORCE_FRESH_FLAG\""), "heal does not drop flag");
  assert(script.includes("HEAL_COOLDOWN_SECONDS="), "heal has no cooldown");
});

check("heal script mac: bash syntax OK + correct kickstart command", () => {
  const script = generateHealScript({
    serviceLabel: "com.clawcode.my-agent",
    logPath: "/Users/tester/.clawcode/logs/my-agent.log",
    forceFreshFlagPath: "/Users/tester/.clawcode/service/my-agent.force-fresh",
    platform: "darwin",
    slug,
  });
  bashSyntaxCheck(script, "heal-mac");
  assert(script.includes("launchctl kickstart -k"), "missing mac kickstart cmd");
  assert(!script.includes("systemctl"), "mac heal script leaked systemctl");
});

check("heal systemd unit is oneshot + declares success-exit codes", () => {
  const unit = generateHealSystemdService({
    slug,
    healScriptPath: "/home/tester/.clawcode/service/my-agent-heal.sh",
    workspace: "/home/tester/my-agent",
  });
  assert(unit.includes("Type=oneshot"), "heal unit not oneshot");
  assert(unit.includes("SuccessExitStatus=0 1 2"), "heal unit missing success exit codes");
  assert(unit.includes("After=clawcode-my-agent.service"), "heal unit missing After= main service");
});

check("heal systemd timer fires every minute with boot offset", () => {
  const timer = generateHealSystemdTimer({ slug });
  assert(timer.includes("OnBootSec=2min"), "timer missing boot delay");
  assert(timer.includes("OnUnitActiveSec=1min"), "timer missing 1min cadence");
  assert(timer.includes(`Unit=clawcode-heal-${slug}.service`), "timer not linked to heal unit");
  assert(timer.includes("WantedBy=timers.target"), "timer missing install target");
});

check("heal launchd plist has 60s StartInterval", () => {
  const plist = generateHealLaunchdPlist({
    slug,
    healScriptPath: "/Users/tester/.clawcode/service/my-agent-heal.sh",
    workspace: "/Users/tester/my-agent",
    healLogPath: "/Users/tester/.clawcode/logs/my-agent-heal.log",
  });
  assert(plist.includes("<key>StartInterval</key>"), "plist missing StartInterval");
  assert(plist.includes("<integer>60</integer>"), "plist StartInterval not 60s");
  assert(plist.includes(`com.clawcode.heal.${slug}`), "plist wrong label");
  assert(!plist.includes("<key>KeepAlive</key>"), "heal plist should not KeepAlive (it's one-shot)");
});

check("buildPlan install (linux, default) includes wrapper + heal sidecar", () => {
  const plan = buildPlan("install", linuxOpts);
  const files = plan.extraFiles ?? [];
  const filePaths = files.map((f) => f.path);
  assert(filePaths.includes(resumeWrapperPath(slug)), "missing resume wrapper");
  assert(filePaths.includes(healScriptPath(slug)), "missing heal script");
  assert(filePaths.includes(healServiceFilePath("linux", slug)), "missing heal service unit");
  assert(filePaths.includes(healTimerFilePath("linux", slug)), "missing heal timer unit");

  const cmds = plan.commands.map((c) => c.cmd).join("\n");
  assert(cmds.includes("clawcode-my-agent.service"), "install missing main service enable");
  assert(cmds.includes("clawcode-heal-my-agent.timer"), "install missing heal timer enable");
});

check("buildPlan install (darwin, default) includes plist for heal sidecar", () => {
  const plan = buildPlan("install", macOpts);
  const files = plan.extraFiles ?? [];
  const filePaths = files.map((f) => f.path);
  assert(filePaths.includes(healServiceFilePath("darwin", slug)), "missing heal plist");
  assert(!filePaths.includes(healTimerFilePath("darwin", slug)), "mac should not emit a timer");

  const cmds = plan.commands.map((c) => c.cmd).join("\n");
  assert(cmds.includes("com.clawcode.heal.my-agent"), "install missing heal plist load");
});

check("buildPlan install (resumeOnRestart=false) disables sidecar by default", () => {
  const plan = buildPlan("install", { ...linuxOpts, resumeOnRestart: false });
  const filePaths = (plan.extraFiles ?? []).map((f) => f.path);
  assert(!filePaths.includes(healScriptPath(slug)), "sidecar should not install when no resume");
  assert(!filePaths.includes(resumeWrapperPath(slug)), "wrapper should not install when disabled");
});

check("buildPlan install (selfHeal=false explicit) suppresses sidecar", () => {
  const plan = buildPlan("install", { ...linuxOpts, selfHeal: false });
  const filePaths = (plan.extraFiles ?? []).map((f) => f.path);
  assert(filePaths.includes(resumeWrapperPath(slug)), "wrapper still there when selfHeal=false");
  assert(!filePaths.includes(healScriptPath(slug)), "sidecar explicitly disabled but present");
});

check("buildPlan uninstall cleans up the sidecar artifacts", () => {
  const plan = buildPlan("uninstall", linuxOpts);
  const cmds = plan.commands.map((c) => c.cmd).join("\n");
  assert(cmds.includes(`clawcode-heal-${slug}.timer`), "uninstall does not stop heal timer");
  assert(cmds.includes(healScriptPath(slug)), "uninstall does not remove heal script");
  assert(cmds.includes(forceFreshFlagPath(slug)), "uninstall does not remove flag file");

  // Sidecar must stop BEFORE the main service, otherwise the sidecar can
  // race by restarting the service we just stopped.
  const healStopIdx = cmds.indexOf(`clawcode-heal-${slug}.timer`);
  const mainStopIdx = cmds.indexOf(`disable --now clawcode-${slug}.service`);
  assert(healStopIdx < mainStopIdx, "uninstall stops main service before heal sidecar");
});

check("buildPlan uninstall (darwin) stops heal plist before main plist", () => {
  const plan = buildPlan("uninstall", macOpts);
  const cmds = plan.commands.map((c) => c.cmd).join("\n");
  const healIdx = cmds.indexOf(healServiceFilePath("darwin", slug));
  const mainIdx = cmds.indexOf("LaunchAgents/com.clawcode.my-agent.plist");
  assert(healIdx > 0 && mainIdx > 0, "one of the plists missing from uninstall");
  assert(healIdx < mainIdx, "mac uninstall stops heal before main");
});

check("systemd main unit tightened StartLimitBurst=3", () => {
  const plan = buildPlan("install", linuxOpts);
  assert(plan.fileContent.includes("StartLimitBurst=3"), "main unit not tightened to 3");
  assert(!plan.fileContent.includes("StartLimitBurst=5"), "main unit still has old 5");
});

check("versionStampPathExpr: per-platform + per-slug isolation", () => {
  const linuxExpr = versionStampPathExpr("linux", "my-agent");
  assert(linuxExpr.includes("XDG_RUNTIME_DIR"), "linux expr missing XDG_RUNTIME_DIR");
  assert(linuxExpr.includes("/run/user/$(id -u)"), "linux expr missing /run/user fallback");
  assert(linuxExpr.includes("clawcode-my-agent.version"), "linux expr missing slug in filename");

  const macExpr = versionStampPathExpr("darwin", "my-agent");
  assert(macExpr.includes("TMPDIR"), "mac expr missing TMPDIR");
  assert(macExpr.includes("clawcode-my-agent.version"), "mac expr missing slug in filename");
  assert(!macExpr.includes("XDG_RUNTIME_DIR"), "mac expr should not reference XDG_RUNTIME_DIR");

  // Two agents must get distinct stamp paths (no cross-talk between
  // multi-agent installs reading the same file).
  const a = versionStampPathExpr("linux", "alpha");
  const b = versionStampPathExpr("linux", "beta");
  assert(a !== b, "different slugs produced the same stamp path");
});

check("systemd unit: emits version-stamp ExecStartPre; bash-valid", () => {
  const unit = generateSystemdUnit({
    name: "my-agent",
    workspace: "/home/tester/my-agent",
    claudeBin: "/usr/local/bin/claude",
    logPath: "/home/tester/.clawcode/logs/my-agent.log",
  });
  // Must have an ExecStartPre line that writes the git HEAD somewhere
  // named after the slug. Leading `-` on the line makes it best-effort.
  const stampLine = unit
    .split("\n")
    .find((l) => l.startsWith("ExecStartPre=") && l.includes("rev-parse HEAD"));
  assert(stampLine, "unit missing version-stamp ExecStartPre");
  assert(stampLine!.startsWith("ExecStartPre=-"), "stamp ExecStartPre not best-effort (missing `-`)");
  assert(stampLine!.includes("clawcode-my-agent.version"), "stamp path missing per-slug filename");
  assert(
    stampLine!.includes("/home/tester/my-agent"),
    "stamp writer does not target the workspace's git repo"
  );

  // Bash-parse the payload after /bin/bash -c to catch quoting mistakes.
  const m = stampLine!.match(/\/bin\/bash -c '(.+)'$/);
  assert(m, "stamp line not of form `/bin/bash -c '...'`");
  const payload = m![1].replace(/'\\''/g, "'"); // undo the systemd-level escaping
  bashSyntaxCheck(payload, "systemd-stamp-payload");
});

check("systemd unit: stamp runs BEFORE exec (ordering matters)", () => {
  const unit = generateSystemdUnit({
    name: "my-agent",
    workspace: "/home/tester/my-agent",
    claudeBin: "/usr/local/bin/claude",
    logPath: "/home/tester/.clawcode/logs/my-agent.log",
  });
  const stampIdx = unit.indexOf("rev-parse HEAD");
  const execIdx = unit.indexOf("ExecStart=");
  assert(stampIdx > 0 && execIdx > 0, "stamp or exec line missing");
  assert(stampIdx < execIdx, "stamp must be written before ExecStart");
});

check("plist: wraps exec via sh -c with stamp write; sh-valid", () => {
  const plist = generatePlist({
    label: "com.clawcode.my-agent",
    slug: "my-agent",
    workspace: "/Users/tester/my-agent",
    claudeBin: "/usr/local/bin/claude",
    logPath: "/Users/tester/.clawcode/logs/my-agent.log",
  });
  // ProgramArguments must start with /bin/sh -c ... so the stamp runs
  // before the real binary. If a future refactor drops that, the stamp
  // is silently skipped and the drift detector goes blind.
  const programArgsMatch = plist.match(
    /<key>ProgramArguments<\/key>\s*<array>([\s\S]+?)<\/array>/
  );
  assert(programArgsMatch, "plist missing ProgramArguments");
  const argEntries = [...programArgsMatch![1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
    (m) => m[1]
  );
  assert(argEntries[0] === "/bin/sh", "plist arg[0] not /bin/sh");
  assert(argEntries[1] === "-c", "plist arg[1] not -c");
  assert(argEntries[2].includes("rev-parse HEAD"), "plist sh script missing stamp write");
  assert(argEntries[2].includes("/Users/tester/my-agent"), "plist stamp not targeting workspace");
  assert(argEntries[2].includes("clawcode-my-agent.version"), "plist stamp missing per-slug filename");
  // XML-decode first, then assert the script ends with `exec "$@"`.
  const decoded = argEntries[2]
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  assert(decoded.endsWith(`exec "$@"`), "plist sh script must end with exec \"$@\"");
  // The subsequent argv must include the real binary so `exec "$@"` reaches it.
  assert(
    argEntries.some((a) => a === "/usr/local/bin/claude"),
    "plist argv missing claude binary after sh -c wrapper"
  );
  // The embedded script must parse as valid sh.
  bashSyntaxCheck(decoded, "plist-stamp-script");
});

check("plist: stamp failure cannot block the service (|| true)", () => {
  const plist = generatePlist({
    label: "com.clawcode.my-agent",
    slug: "my-agent",
    workspace: "/Users/tester/non-git-workspace",
    claudeBin: "/usr/local/bin/claude",
    logPath: "/Users/tester/.clawcode/logs/my-agent.log",
  });
  // Without `|| true`, a non-git workspace would make the sh script exit
  // non-zero before `exec "$@"` runs, and launchd would crash-loop the
  // service forever. This is the launchd equivalent of the `-` prefix
  // on the systemd ExecStartPre line.
  const scriptMatch = plist.match(
    /<string>(git -C[^<]+rev-parse HEAD[^<]+)<\/string>/
  );
  assert(scriptMatch, "plist stamp script not found");
  assert(
    scriptMatch![1].includes("|| true"),
    "plist stamp script must fall through on failure"
  );
});

// ---------------------------------------------------------------------------
// End-to-end bash-level simulation of the wrapper's log pre-flight
// ---------------------------------------------------------------------------
check("wrapper preflight trips on synthetic log spam", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-smoke-"));
  const logPath = path.join(tmpDir, "svc.log");
  const flagPath = path.join(tmpDir, "flag");
  const wrapperPath = path.join(tmpDir, "wrapper.sh");
  const fakeClaudePath = path.join(tmpDir, "fake-claude.sh");

  // Build a wrapper targeting our synthetic log.
  const wrapper = generateResumeWrapper({
    claudeBin: fakeClaudePath,
    workspace: tmpDir,
    logPath,
    forceFreshFlagPath: flagPath,
  });
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  // Fake claude: echoes whether --continue was passed, then exits 0.
  fs.writeFileSync(
    fakeClaudePath,
    `#!/bin/bash
if [[ " $* " == *" --continue "* ]]; then
  echo CONTINUE_ATTACHED
else
  echo FRESH_START
fi
`,
    { mode: 0o755 }
  );

  // Write a log full of the error pattern.
  const spam = Array.from({ length: 30 }, () => "Error: No deferred tool marker found").join("\n");
  fs.writeFileSync(logPath, spam);

  // Need the sessions dir to exist + contain a recent jsonl, otherwise the
  // earlier "no prior session jsonl" check fires and we can't isolate the
  // log-preflight branch.
  const sessionsDir = path.join(tmpDir, ".claude", "projects", "-" + tmpDir.replace(/^\/+/, "").replace(/\//g, "-"));
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "fake.jsonl"), "{}\n");

  const run = spawnSync("bash", [wrapperPath], { encoding: "utf-8" });
  assert(run.status === 0, `wrapper exited non-zero: ${run.stderr}`);
  assert(run.stdout.includes("FRESH_START"), `expected fresh start under spam; got: ${run.stdout}`);
  assert(
    fs.readFileSync(logPath, "utf-8").includes("stale resume"),
    "wrapper did not write skip breadcrumb"
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

check("heal script drops flag + invokes restart on synthetic log spam", () => {
  // The heal script's cooldown state file lives at ~/.clawcode/service/<slug>.heal-state
  // (shared across runs by design, it's a real restart cooldown). Purge
  // it before exercising the trip path so a prior run's state doesn't
  // put us inside cooldown.
  const stateFile = path.join(os.homedir(), ".clawcode", "service", `${slug}.heal-state`);
  try { fs.unlinkSync(stateFile); } catch {}

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-smoke-heal-"));
  const logPath = path.join(tmpDir, "svc.log");
  const flagPath = path.join(tmpDir, "flag");
  const healPath = path.join(tmpDir, "heal.sh");

  const heal = generateHealScript({
    serviceLabel: "clawcode-my-agent",
    logPath,
    forceFreshFlagPath: flagPath,
    platform: "linux",
    slug,
  });
  // Swap out the real systemctl with a no-op so we can exercise the code
  // path without actually touching the host's services.
  const patched = heal.replace(
    "systemctl --user restart clawcode-my-agent",
    "echo RESTART_CALLED"
  );
  fs.writeFileSync(healPath, patched, { mode: 0o755 });

  const spam = Array.from({ length: 20 }, () => "Error: Input must be provided either").join("\n");
  fs.writeFileSync(logPath, spam);

  const run = spawnSync("bash", [healPath], { encoding: "utf-8" });
  assert(run.status === 1, `heal should exit 1 on trip; got ${run.status}. stderr: ${run.stderr}`);
  assert(fs.existsSync(flagPath), "heal did not drop force-fresh flag");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

check("heal script is quiet when log is clean", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-smoke-heal-clean-"));
  const logPath = path.join(tmpDir, "svc.log");
  const flagPath = path.join(tmpDir, "flag");
  const healPath = path.join(tmpDir, "heal.sh");

  fs.writeFileSync(healPath, generateHealScript({
    serviceLabel: "clawcode-my-agent",
    logPath,
    forceFreshFlagPath: flagPath,
    platform: "linux",
    slug,
  }), { mode: 0o755 });

  fs.writeFileSync(logPath, "all good\nnothing to see here\n");

  const run = spawnSync("bash", [healPath], { encoding: "utf-8" });
  assert(run.status === 0, `healthy log should exit 0; got ${run.status}`);
  assert(!fs.existsSync(flagPath), "heal dropped flag on healthy log");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Watchdog tier 6 (version drift) — end-to-end bash tests against
// recipes/watchdog/watcher.sh. Pairs with versionStampPathExpr on the
// service side: the service writes a stamp at boot, the watchdog reads it.
// ---------------------------------------------------------------------------
const watcherPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "recipes",
  "watchdog",
  "watcher.sh"
);

/**
 * Build a throwaway workspace + stamp file + minimal watcher invocation so
 * we can exercise tier 6 in isolation without hitting the other tiers.
 * The `stampSha` controls what's in the stamp file; pass `null` to skip
 * creating the file (tests the no-stamp path).
 */
function runTier6(opts: {
  stampSha: string | null;
  workspaceHeadOverride?: string; // if set, create a fake workspace whose HEAD differs from stampSha
  noGit?: boolean; // create a workspace without .git
  slug?: string;
}): { status: number; log: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-tier6-"));
  const workspace = path.join(tmpDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });

  if (!opts.noGit) {
    spawnSync("git", ["init", "-q"], { cwd: workspace });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], {
      cwd: workspace,
    });
    if (opts.workspaceHeadOverride) {
      // Force a second commit to change HEAD away from the stamp.
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "drift"], {
        cwd: workspace,
      });
    }
  }

  const slug = opts.slug ?? "test-agent";
  const stampFile = path.join(tmpDir, `clawcode-${slug}.version`);
  if (opts.stampSha !== null) {
    fs.writeFileSync(stampFile, opts.stampSha);
  }

  const logPath = path.join(tmpDir, "watcher.log");
  const args = [
    watcherPath,
    `--service-label=clawcode-${slug}`,
    `--slug=${slug}`,
    `--workspace=${workspace}`,
    `--stamp-file=${stampFile}`,
    "--tier=6",
    "--cooldown=0",
    `--log-path=${logPath}`,
    // No --on-fail, so a drift result logs FAIL but does not try to restart.
  ];
  const r = spawnSync("bash", args, { encoding: "utf-8" });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";

  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { status: r.status ?? -1, log };
}

check("watcher tier 6: matching SHA → pass", () => {
  // Use a workspace that git init'd, read its HEAD, write same to stamp.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-tier6-match-"));
  const workspace = path.join(tmpDir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: workspace });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], {
    cwd: workspace,
  });
  const headOut = spawnSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf-8" });
  const head = headOut.stdout.trim();
  assert(/^[0-9a-f]{40}$/.test(head), `expected SHA, got: ${head}`);

  const stampFile = path.join(tmpDir, "clawcode-test-agent.version");
  fs.writeFileSync(stampFile, head);

  const logPath = path.join(tmpDir, "w.log");
  const r = spawnSync("bash", [
    watcherPath,
    "--service-label=clawcode-test-agent",
    "--slug=test-agent",
    `--workspace=${workspace}`,
    `--stamp-file=${stampFile}`,
    "--tier=6",
    "--cooldown=0",
    `--log-path=${logPath}`,
  ], { encoding: "utf-8" });

  const log = fs.readFileSync(logPath, "utf-8");
  assert(r.status === 0, `expected exit 0 on match; got ${r.status}. log: ${log}`);
  assert(log.includes("tier6:pass"), `expected tier6:pass in log, got: ${log}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

check("watcher tier 6: drift → FAIL(drift:…)", () => {
  const { status, log } = runTier6({
    stampSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    workspaceHeadOverride: "force-different-head",
  });
  assert(status === 1, `expected exit 1 on drift; got ${status}. log: ${log}`);
  assert(
    /tier6:FAIL\(drift:/.test(log),
    `expected tier6:FAIL(drift:...) in log, got: ${log}`
  );
});

check("watcher tier 6: missing stamp → skip (does not fail)", () => {
  const { status, log } = runTier6({ stampSha: null });
  assert(status === 0, `missing stamp must not fail; got exit ${status}. log: ${log}`);
  assert(log.includes("tier6:skip(no-stamp)"), `expected skip(no-stamp) in log, got: ${log}`);
});

check("watcher tier 6: non-git workspace → skip", () => {
  const { status, log } = runTier6({
    stampSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    noGit: true,
  });
  assert(status === 0, `non-git workspace must not fail; got exit ${status}. log: ${log}`);
  assert(
    log.includes("tier6:skip(no-git-workspace)"),
    `expected skip(no-git-workspace) in log, got: ${log}`
  );
});

check("watcher tier 6: no --slug + no --stamp-file → skip (never errors)", () => {
  // Omit slug AND stamp-file. resolve_stamp_path should return empty and the
  // check should skip without touching the filesystem.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-tier6-noslug-"));
  const logPath = path.join(tmpDir, "w.log");
  const r = spawnSync("bash", [
    watcherPath,
    "--service-label=clawcode-x",
    // no --slug, no --stamp-file
    `--workspace=${tmpDir}`,
    "--tier=6",
    "--cooldown=0",
    `--log-path=${logPath}`,
  ], { encoding: "utf-8" });
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
  assert(r.status === 0, `missing slug must not fail; got ${r.status}. log: ${log}`);
  assert(log.includes("tier6:skip(no-slug)"), `expected skip(no-slug), got: ${log}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.msg ? ": " + r.msg : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
