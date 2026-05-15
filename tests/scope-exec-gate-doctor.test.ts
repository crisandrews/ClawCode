/**
 * Tier 1 tests for the exec-gate doctor checks (`checkScopeExecGateStatus`
 * and `checkScopeExecGateShadowEvents`).
 *
 * Fixture-based: each test writes a temp workspace with an
 * `agent-config.json` and (optionally) a `memory/.execgate-shadow.jsonl`,
 * then invokes the check function directly. Doesn't spawn `runDoctor()`
 * because that would also pull in unrelated checks.
 *
 * Run: `npx tsx tests/scope-exec-gate-doctor.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  checkScopeExecGateStatus,
  checkScopeExecGateShadowEvents,
} from "../lib/doctor.ts";

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

interface Fixture {
  workspace: string;
}

function mkFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-doc-"));
  fs.mkdirSync(path.join(root, "memory"), { recursive: true });
  return { workspace: root };
}

function writeConfig(workspace: string, scope: object): void {
  fs.writeFileSync(
    path.join(workspace, "agent-config.json"),
    JSON.stringify({ scope }, null, 2)
  );
}

function withTrustDir<T>(fn: () => T): T {
  // Codex Step 3 round-3 LOW F4: rmSync the tmpdir in finally so symlinks
  // + trust file fixtures + workspace dirs don't accumulate across
  // suite runs. recursive+force tolerates partial setup failures.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-doc-trust-"));
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  process.env.CLAW_SCOPE_TRUST_DIR = tmp;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ---------------------------------------------------------------------------
// checkScopeExecGateStatus
// ---------------------------------------------------------------------------

check("status: scope absent → off + 'not configured'", () => {
  const fx = mkFixture();
  fs.writeFileSync(path.join(fx.workspace, "agent-config.json"), "{}");
  const r = checkScopeExecGateStatus(fx.workspace);
  assert(r.status === "off", `expected off, got ${r.status}`);
  assert(/not configured/i.test(r.message), `expected 'not configured', got ${r.message}`);
});

check("status: scope present but no execGate block → off + 'no channels'", () => {
  const fx = mkFixture();
  writeConfig(fx.workspace, { whatsapp: { mode: "off" } });
  const r = checkScopeExecGateStatus(fx.workspace);
  assert(r.status === "off", `expected off, got ${r.status}`);
});

check("status: whatsapp execGate=off → row shows 'off'", () => {
  const fx = mkFixture();
  writeConfig(fx.workspace, {
    whatsapp: { mode: "off", execGate: { mode: "off" } },
  });
  const r = checkScopeExecGateStatus(fx.workspace);
  assert(r.status === "info", `expected info, got ${r.status}`);
  assert(/whatsapp: off/.test(r.message), `expected 'whatsapp: off', got ${r.message}`);
});

check("status: whatsapp execGate=shadow + denylist + defaults → info row", () => {
  withTrustDir(() => {
    const fx = mkFixture();
    writeConfig(fx.workspace, {
      whatsapp: {
        mode: "enforce",
        execGate: { mode: "shadow", policy: "denylist" },
      },
    });
    const r = checkScopeExecGateStatus(fx.workspace);
    assert(r.status === "info", `expected info, got ${r.status}`);
    assert(
      /whatsapp: shadow\/denylist\/defaults\/trust=no/.test(r.message),
      `expected canonical row format, got ${r.message}`
    );
    assert(
      r.hint !== undefined && /destructive tools blocked/.test(r.hint),
      "expected armed hint"
    );
  });
});

check("status: whatsapp execGate=enforce + allowlist + defaults → 'enforce/allowlist/defaults'", () => {
  withTrustDir(() => {
    const fx = mkFixture();
    writeConfig(fx.workspace, {
      whatsapp: {
        mode: "enforce",
        execGate: { mode: "enforce", policy: "allowlist" },
      },
    });
    const r = checkScopeExecGateStatus(fx.workspace);
    assert(r.status === "info", `expected info, got ${r.status}`);
    assert(
      /whatsapp: enforce\/allowlist\/defaults/.test(r.message),
      `expected enforce/allowlist row, got ${r.message}`
    );
  });
});

check("status: custom tools[] → row shows 'custom(N)'", () => {
  withTrustDir(() => {
    const fx = mkFixture();
    writeConfig(fx.workspace, {
      whatsapp: {
        mode: "enforce",
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: ["Bash", "Write", "Task"], // 3-tool custom denylist
        },
      },
    });
    const r = checkScopeExecGateStatus(fx.workspace);
    assert(r.status === "info", `expected info, got ${r.status}`);
    assert(
      /custom\(3\)/.test(r.message),
      `expected 'custom(3)', got ${r.message}`
    );
  });
});

check("status: trust file <channel>-exec present + valid mode → 'trust=yes'", () => {
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    fs.writeFileSync(path.join(trustDir, "whatsapp-exec"), "", { mode: 0o600 });
    fs.chmodSync(path.join(trustDir, "whatsapp-exec"), 0o600);
    const fx = mkFixture();
    writeConfig(fx.workspace, {
      whatsapp: {
        mode: "enforce",
        execGate: { mode: "shadow", policy: "denylist" },
      },
    });
    const r = checkScopeExecGateStatus(fx.workspace);
    assert(
      /trust=yes/.test(r.message),
      `expected trust=yes when trust file exists with valid mode, got ${r.message}`
    );
  });
});

check("status: trust file is a symlink → 'trust=invalid' (Codex round-2 LOW C3)", () => {
  // Codex Step 3 round-2 LOW C3: trust.ts:isOwnerTrusted uses lstatSync
  // + isFile() to reject symlinks. Doctor must surface that as 'invalid'.
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    // Create a real target file the symlink points to, with 0o600 mode.
    const targetPath = path.join(trustDir, "real-trust-target");
    fs.writeFileSync(targetPath, "", { mode: 0o600 });
    fs.chmodSync(targetPath, 0o600);
    // Create the symlink at the expected trust file path.
    fs.symlinkSync(targetPath, path.join(trustDir, "whatsapp-exec"));
    const fx = mkFixture();
    writeConfig(fx.workspace, {
      whatsapp: {
        mode: "enforce",
        execGate: { mode: "shadow", policy: "denylist" },
      },
    });
    const r = checkScopeExecGateStatus(fx.workspace);
    assert(
      /trust=invalid/.test(r.message),
      `expected trust=invalid for symlink, got ${r.message}`
    );
  });
});

check("status: trust file present but world-readable (mode 0o644) → 'trust=invalid'", () => {
  // Codex Step 3 round-1 MEDIUM fix: doctor must match resolver semantics.
  // A trust file with bad mode wouldn't actually unlock the gate — surface
  // that distinct state so the user doesn't think they're trusted when
  // they aren't.
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    fs.writeFileSync(path.join(trustDir, "whatsapp-exec"), "");
    fs.chmodSync(path.join(trustDir, "whatsapp-exec"), 0o644);
    const fx = mkFixture();
    writeConfig(fx.workspace, {
      whatsapp: {
        mode: "enforce",
        execGate: { mode: "shadow", policy: "denylist" },
      },
    });
    const r = checkScopeExecGateStatus(fx.workspace);
    assert(
      /trust=invalid/.test(r.message),
      `expected trust=invalid for world-readable trust file, got ${r.message}`
    );
  });
});

// ---------------------------------------------------------------------------
// checkScopeExecGateShadowEvents
// ---------------------------------------------------------------------------

check("shadow events: log absent → off + 'no shadow log'", () => {
  const fx = mkFixture();
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(r.status === "off", `expected off, got ${r.status}`);
  assert(/no shadow log/i.test(r.message), `expected 'no shadow log', got ${r.message}`);
});

check("shadow events: empty log → ok + 'present but empty'", () => {
  const fx = mkFixture();
  fs.writeFileSync(path.join(fx.workspace, "memory", ".execgate-shadow.jsonl"), "");
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(r.status === "ok", `expected ok, got ${r.status}`);
  assert(/empty/i.test(r.message), `expected 'empty', got ${r.message}`);
});

check("shadow events: recent event → warn + summary with channel/tool/ts", () => {
  const fx = mkFixture();
  const logPath = path.join(fx.workspace, "memory", ".execgate-shadow.jsonl");
  const nowIso = new Date().toISOString();
  const event = {
    ts: nowIso,
    channel: "whatsapp",
    senderHash: "abcdef01",
    toolName: "Bash",
    decision: "would-block",
    effectiveMode: "shadow",
    policy: "denylist",
    expandedTools: ["Bash"],
    hookVersion: 1,
    configHash: "deadbeef",
    lookbackMs: 60000,
    windowEnvelopeCount: 1,
  };
  fs.writeFileSync(logPath, JSON.stringify(event) + "\n");
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(r.status === "warn", `recent event should be warn, got ${r.status}`);
  assert(/1 event/.test(r.message), `should report '1 event', got ${r.message}`);
  assert(/whatsapp/.test(r.message), `should mention channel, got ${r.message}`);
  assert(/Bash/.test(r.message), `should mention tool, got ${r.message}`);
  assert(
    r.hint !== undefined && /Review/.test(r.hint),
    "expected review hint for recent events"
  );
});

check("shadow events: ancient event (>7d) → info (not warn)", () => {
  const fx = mkFixture();
  const logPath = path.join(fx.workspace, "memory", ".execgate-shadow.jsonl");
  const oldIso = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const event = {
    ts: oldIso,
    channel: "whatsapp",
    senderHash: "abcdef02",
    toolName: "Write",
    decision: "would-block",
    effectiveMode: "shadow",
    policy: "denylist",
    expandedTools: ["Write"],
    hookVersion: 1,
    configHash: "cafebabe",
    lookbackMs: 60000,
    windowEnvelopeCount: 1,
  };
  fs.writeFileSync(logPath, JSON.stringify(event) + "\n");
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(r.status === "info", `ancient event should be info, got ${r.status}`);
});

check("shadow events: mixed parseable + malformed lines → counts only parseable", () => {
  const fx = mkFixture();
  const logPath = path.join(fx.workspace, "memory", ".execgate-shadow.jsonl");
  const ev1 = {
    ts: new Date().toISOString(),
    channel: "whatsapp",
    senderHash: "11111111",
    toolName: "Bash",
    decision: "would-block",
    effectiveMode: "shadow",
    policy: "denylist",
    expandedTools: [],
    hookVersion: 1,
    configHash: "x",
    lookbackMs: 60000,
    windowEnvelopeCount: 1,
  };
  fs.writeFileSync(
    logPath,
    JSON.stringify(ev1) + "\n" +
      "{this-is-not-json\n" +
      JSON.stringify({ ...ev1, senderHash: "22222222" }) + "\n"
  );
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(/2 event/.test(r.message), `should parse 2 valid events, got ${r.message}`);
});

check("shadow events: all-malformed → warn + 'none parseable'", () => {
  const fx = mkFixture();
  const logPath = path.join(fx.workspace, "memory", ".execgate-shadow.jsonl");
  fs.writeFileSync(logPath, "garbage line 1\nmore garbage\n");
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(r.status === "warn", `corrupt log should be warn, got ${r.status}`);
  assert(/none parseable/i.test(r.message), `should report none parseable, got ${r.message}`);
});

check("shadow events: log path is a directory → off + 'not a regular file'", () => {
  const fx = mkFixture();
  fs.mkdirSync(path.join(fx.workspace, "memory", ".execgate-shadow.jsonl"));
  const r = checkScopeExecGateShadowEvents(fx.workspace);
  assert(r.status === "off", `directory at log path should be off, got ${r.status}`);
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;
for (const r of results) {
  if (!r.pass) console.error(`  FAIL ${r.name}: ${r.msg}`);
}
console.log(`exec-gate doctor tier1: ${passed}/${results.length} passed`);
if (failed > 0) process.exit(1);
