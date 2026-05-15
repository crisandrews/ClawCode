/**
 * Tier 1 tests for the execution gate resolver (Phase 7 Step 1).
 *
 * Covers 29 cases organized into groups A–H. The resolver itself is
 * pure-function; the hook script (Step 2) is the only place that
 * touches stdin/exit-codes. All FS-touching is real (tmpdir fixtures);
 * the resolver's `fsImpl` injection is exercised in a handful of cases
 * to verify the seam is testable without disk.
 *
 * Run: `npx tsx tests/scope-exec-gate.test.ts`
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_ALLOWLIST_TOOLS,
  DEFAULT_DENYLIST_TOOLS,
  EXEC_GATE_DEFAULT_LOOKBACK_MS,
  EXEC_GATE_HOOK_VERSION,
  coerceExecGateConfig,
  execGateConfigForChannel,
  resolve,
  type ArmedChannel,
  type ResolverInput,
} from "../lib/scope/exec-gate.ts";
import {
  EnvelopeReader,
  ENVELOPE_DIR_NAME,
  ENVELOPE_TTL_MS,
  ENVELOPE_TOKEN_LENGTH,
  ENVELOPE_VERSION,
  type RequestEnvelopePayload,
} from "../lib/scope/envelope.ts";
import {
  SHADOW_LOG_MAX_BYTES,
  appendShadowEvent,
  type ShadowEvent,
} from "../lib/scope/exec-gate-shadow-log.ts";
import {
  classifyProtectedPath,
  extractToolPath,
} from "../lib/scope/protected-paths.ts";
import { classifyAgentConfigKey } from "../lib/scope/agent-config-guard.ts";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];
const pendingChecks: Array<Promise<void>> = [];

/**
 * Codex round-2 LOW 3 fix: harness now awaits async test bodies. Previously
 * `check(name, async () => {...})` would record pass synchronously while
 * the await inside the body was still running, masking failures. We push
 * the promise into `pendingChecks` and wait at the bottom of the file.
 */
function check(name: string, fn: () => void | Promise<void>): void {
  let result: void | Promise<void>;
  try {
    result = fn();
  } catch (err) {
    results.push({ name, pass: false, msg: (err as Error).message });
    return;
  }
  if (result && typeof (result as Promise<void>).then === "function") {
    pendingChecks.push(
      (result as Promise<void>).then(
        () => {
          results.push({ name, pass: true });
        },
        (err: unknown) => {
          results.push({ name, pass: false, msg: (err as Error)?.message ?? String(err) });
        }
      )
    );
  } else {
    results.push({ name, pass: true });
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function freshTok(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function mkChannelDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-"));
}

function writeEnvelope(
  channelDir: string,
  token: string,
  payload: Partial<RequestEnvelopePayload>,
  opts: { mode?: number; mtimeOffsetMs?: number } = {}
): void {
  const envelopeDir = path.join(channelDir, ENVELOPE_DIR_NAME);
  fs.mkdirSync(envelopeDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(envelopeDir, `${token}.json`);
  const now = Date.now();
  const full: RequestEnvelopePayload = {
    version: ENVELOPE_VERSION,
    token,
    chatId: "1234567890@s.whatsapp.net",
    senderId: "1234567890@s.whatsapp.net",
    ts: now,
    expiresAt: now + ENVELOPE_TTL_MS,
    ...payload,
  };
  fs.writeFileSync(filePath, JSON.stringify(full), { mode: opts.mode ?? 0o600 });
  try {
    fs.chmodSync(filePath, opts.mode ?? 0o600);
  } catch {
    // Mode set is best-effort; ignore.
  }
  if (typeof opts.mtimeOffsetMs === "number") {
    const targetMs = now + opts.mtimeOffsetMs;
    fs.utimesSync(filePath, targetMs / 1000, targetMs / 1000);
  }
}

function fakeWorkspace(): {
  pluginRoot: string;
  workspaceRoot: string;
  memoryDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-ws-"));
  const pluginRoot = path.join(root, "plugin");
  const workspaceRoot = path.join(root, "workspace");
  const memoryDir = path.join(workspaceRoot, "memory");
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  return { pluginRoot, workspaceRoot, memoryDir };
}

function withTrustDir<T>(fn: () => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-trust-"));
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  process.env.CLAW_SCOPE_TRUST_DIR = tmp;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
  }
}

const OWNER_JID = "1234567890@s.whatsapp.net";
const NON_OWNER_JID = "9876543210@s.whatsapp.net";

function armedWA(
  channelDir: string,
  overrides: Partial<ArmedChannel["execGate"]> = {},
  ownerJids: string[] = [OWNER_JID]
): ArmedChannel {
  return {
    channel: "whatsapp",
    channelDir,
    ownerJids,
    execGate: {
      mode: "enforce",
      policy: "denylist",
      tools: [...DEFAULT_DENYLIST_TOOLS],
      lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
      ...overrides,
    },
  };
}

function baseInput(
  toolName: string,
  toolInput: unknown,
  armed: ArmedChannel[]
): ResolverInput {
  const ws = fakeWorkspace();
  return {
    toolName,
    toolInput,
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    memoryDir: ws.memoryDir,
    armed,
    now: Date.now(),
    reader: new EnvelopeReader(),
  };
}

// ---------------------------------------------------------------------------
// Group A — Mode short-circuit + basics (3 cases)
// ---------------------------------------------------------------------------

check("A1 mode=off across all channels → allow (zero envelope reads)", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  // Even with a non-owner envelope sitting in the dir, mode=off short-circuits.
  let fsHits = 0;
  const result = resolve({
    ...baseInput("Bash", { command: "echo hi" }, [armedWA(cd, { mode: "off" })]),
    fsImpl: {
      readdirSync: (p) => {
        fsHits++;
        return fs.readdirSync(p);
      },
      statSync: (p) => {
        fsHits++;
        return fs.statSync(p);
      },
    },
  });
  assert(result.decision === "allow", `expected allow, got ${result.decision}`);
  assert(fsHits === 0, `expected zero fs hits in mode=off, got ${fsHits}`);
});

check("A2 no envelopes in window → owner-direct → allow", () => {
  const cd = mkChannelDir();
  // Empty envelope dir.
  fs.mkdirSync(path.join(cd, ENVELOPE_DIR_NAME), { recursive: true, mode: 0o700 });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow, got ${result.decision}`);
  });
});

check("A3 only-owner envelope in window → allow", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: OWNER_JID });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow, got ${result.decision}`);
  });
});

// ---------------------------------------------------------------------------
// Group B — Aggregation semantics (most-restrictive) (7 cases)
// ---------------------------------------------------------------------------

check("B1 non-owner envelope + denylist + tool IN list → block", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "block", `expected block, got ${result.decision}`);
    assert(
      result.decision === "block" && result.reason.includes("Bash"),
      "reason should mention Bash"
    );
  });
});

check("B2 non-owner envelope + denylist + tool NOT IN list → allow", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    // Custom tools list that does NOT include "Read".
    const armed = armedWA(cd, { tools: ["Write"] });
    const result = resolve(baseInput("Read", { file_path: "/tmp/x" }, [armed]));
    assert(result.decision === "allow", `expected allow, got ${result.decision}`);
  });
});

check("B3 non-owner envelope + allowlist + tool IN list → allow", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const armed = armedWA(cd, {
      policy: "allowlist",
      tools: [...DEFAULT_ALLOWLIST_TOOLS],
    });
    const result = resolve(baseInput("Read", { file_path: "/tmp/x" }, [armed]));
    assert(result.decision === "allow", `expected allow, got ${result.decision}`);
  });
});

check("B4 non-owner envelope + allowlist + tool NOT IN list → block", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const armed = armedWA(cd, {
      policy: "allowlist",
      tools: [...DEFAULT_ALLOWLIST_TOOLS],
    });
    // Bash is NOT in the default allowlist, so it gets blocked.
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armed]));
    assert(result.decision === "block", `expected block, got ${result.decision}`);
  });
});

check("B5 mixed window (owner + non-owner concurrent) → most-restrictive (block)", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: OWNER_JID });
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "block", `expected block (most-restrictive), got ${result.decision}`);
  });
});

check("B6 multiple non-owner envelopes → block (same behavior as single)", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  writeEnvelope(cd, freshTok(), { senderId: "1111111111@s.whatsapp.net" });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "block", `expected block, got ${result.decision}`);
  });
});

check("B7 non-owner + shadow mode → allow + shadow event", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const armed = armedWA(cd, { mode: "shadow" });
    const input = baseInput("Bash", { command: "echo hi" }, [armed]);
    const result = resolve(input);
    assert(result.decision === "shadow", `expected shadow, got ${result.decision}`);
    // Shadow log should now contain at least one event.
    const logPath = path.join(input.memoryDir, ".execgate-shadow.jsonl");
    const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
    assert(lines.length === 1, `expected 1 shadow event, got ${lines.length}`);
    const ev: ShadowEvent = JSON.parse(lines[0]);
    assert(ev.channel === "whatsapp", "shadow event channel");
    assert(ev.toolName === "Bash", "shadow event toolName");
    assert(ev.decision === "would-block", "shadow event decision");
    assert(ev.effectiveMode === "shadow", "shadow event effectiveMode");
    assert(ev.policy === "denylist", "shadow event policy");
    assert(Array.isArray(ev.expandedTools), "shadow event expandedTools");
    assert(ev.hookVersion === EXEC_GATE_HOOK_VERSION, "shadow event hookVersion");
    assert(typeof ev.configHash === "string" && ev.configHash.length > 0, "configHash");
    assert(ev.lookbackMs === EXEC_GATE_DEFAULT_LOOKBACK_MS, "lookbackMs");
    assert(ev.windowEnvelopeCount === 1, "windowEnvelopeCount");
  });
});

// ---------------------------------------------------------------------------
// Group C — Trust file (4 cases)
// ---------------------------------------------------------------------------

check("C1 non-owner envelope + trust file <channel>-exec → allow", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    // Create the exec trust file.
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    fs.writeFileSync(path.join(trustDir, "whatsapp-exec"), "", { mode: 0o600 });
    fs.chmodSync(path.join(trustDir, "whatsapp-exec"), 0o600);
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow, got ${result.decision}`);
  });
});

check("C2 symlink trust file → rejected (lstat) → gate fires normally", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    // Real symlink: target is a regular file, but the trust-file path
    // itself is a symlink to it. lstat must catch the symlink.
    const target = path.join(trustDir, "real-target");
    fs.writeFileSync(target, "", { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const linkPath = path.join(trustDir, "whatsapp-exec");
    fs.symlinkSync(target, linkPath);
    // Sanity: confirm the symlink + target exist as expected.
    const ls = fs.lstatSync(linkPath);
    assert(ls.isSymbolicLink(), "fixture: linkPath should be a symbolic link");
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "block", `expected block, got ${result.decision}`);
  });
});

check("C3 trust separation: <channel>-owner exists but <channel>-exec does NOT → gate fires", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    fs.writeFileSync(path.join(trustDir, "whatsapp-owner"), "", { mode: 0o600 });
    fs.chmodSync(path.join(trustDir, "whatsapp-owner"), 0o600);
    // No `whatsapp-exec` file.
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "block", `expected block, got ${result.decision}`);
  });
});

check("C4 isOwnerTrusted suffix=exec is per-channel (telegram trust doesn't unlock WA gate)", () => {
  const cdWa = mkChannelDir();
  const cdTg = mkChannelDir();
  // Both channels have a non-owner envelope in window.
  writeEnvelope(cdWa, freshTok(), { senderId: NON_OWNER_JID });
  writeEnvelope(cdTg, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    // Only telegram is exec-trusted — NOT whatsapp.
    fs.writeFileSync(path.join(trustDir, "telegram-exec"), "", { mode: 0o600 });
    fs.chmodSync(path.join(trustDir, "telegram-exec"), 0o600);

    const armed: ArmedChannel[] = [
      armedWA(cdWa),
      {
        channel: "telegram",
        channelDir: cdTg,
        ownerJids: [OWNER_JID],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
        },
      },
    ];
    const result = resolve(baseInput("Bash", { command: "echo hi" }, armed));
    // WA is the un-trusted channel that should still block.
    assert(result.decision === "block", `expected block from WA, got ${result.decision}`);
    assert(result.decision === "block" && result.channel === "whatsapp", "should be attributed to WA, not telegram");
  });
});

// ---------------------------------------------------------------------------
// Group D — Envelope reader hardening (6 cases)
// ---------------------------------------------------------------------------

check("D1 stale envelope (mtime fresh, payload expired) → reader rejects → treated as absent", () => {
  const cd = mkChannelDir();
  const tok = freshTok();
  const past = Date.now() - ENVELOPE_TTL_MS - 5000;
  // Write payload with expired ts but bring mtime forward.
  writeEnvelope(cd, tok, {
    senderId: NON_OWNER_JID,
    ts: past,
    expiresAt: past + ENVELOPE_TTL_MS,
  });
  // Touch mtime to "now" — the reader uses payload-TTL, not mtime, for
  // validity, so it should reject.
  const filePath = path.join(cd, ENVELOPE_DIR_NAME, `${tok}.json`);
  const now = Date.now();
  fs.utimesSync(filePath, now / 1000, now / 1000);

  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow (envelope rejected as expired), got ${result.decision}`);
  });
});

check("D2 symlinked envelope file → reader rejects → treated as absent", () => {
  const cd = mkChannelDir();
  const tok = freshTok();
  const envelopeDir = path.join(cd, ENVELOPE_DIR_NAME);
  fs.mkdirSync(envelopeDir, { recursive: true, mode: 0o700 });
  // Write real file outside, then symlink in.
  const real = path.join(cd, "real-envelope.json");
  const now = Date.now();
  fs.writeFileSync(real, JSON.stringify({
    version: ENVELOPE_VERSION, token: tok, chatId: "x", senderId: NON_OWNER_JID,
    ts: now, expiresAt: now + ENVELOPE_TTL_MS,
  }), { mode: 0o600 });
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, path.join(envelopeDir, `${tok}.json`));
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow (symlinked envelope rejected), got ${result.decision}`);
  });
});

check("D3 world-readable envelope (mode 0o644) → reader rejects → treated as absent", () => {
  const cd = mkChannelDir();
  const tok = freshTok();
  writeEnvelope(cd, tok, { senderId: NON_OWNER_JID }, { mode: 0o644 });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow (world-readable rejected), got ${result.decision}`);
  });
});

check("D4 corrupt JSON envelope → reader rejects → treated as absent", () => {
  const cd = mkChannelDir();
  const envelopeDir = path.join(cd, ENVELOPE_DIR_NAME);
  fs.mkdirSync(envelopeDir, { recursive: true, mode: 0o700 });
  const tok = freshTok();
  fs.writeFileSync(path.join(envelopeDir, `${tok}.json`), "not valid json{{{", { mode: 0o600 });
  fs.chmodSync(path.join(envelopeDir, `${tok}.json`), 0o600);
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow (corrupt JSON rejected), got ${result.decision}`);
  });
});

check("D5 envelope outside lookbackMs window → skipped → treated as absent", () => {
  const cd = mkChannelDir();
  const tok = freshTok();
  // Bring mtime to before the window (current default is 60s).
  writeEnvelope(cd, tok, { senderId: NON_OWNER_JID }, { mtimeOffsetMs: -120_000 });
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow (envelope outside window), got ${result.decision}`);
  });
});

check("D6 oversized envelope (>1024 bytes) → reader rejects → treated as absent", () => {
  const cd = mkChannelDir();
  const tok = freshTok();
  const envelopeDir = path.join(cd, ENVELOPE_DIR_NAME);
  fs.mkdirSync(envelopeDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  // Real schema + a giant padding field — pushes file over 1 KB.
  const payload = {
    version: ENVELOPE_VERSION,
    token: tok,
    chatId: "x",
    senderId: NON_OWNER_JID,
    ts: now,
    expiresAt: now + ENVELOPE_TTL_MS,
    padding: "x".repeat(2000),
  };
  fs.writeFileSync(path.join(envelopeDir, `${tok}.json`), JSON.stringify(payload), { mode: 0o600 });
  fs.chmodSync(path.join(envelopeDir, `${tok}.json`), 0o600);
  withTrustDir(() => {
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "allow", `expected allow (oversized rejected), got ${result.decision}`);
  });
});

// ---------------------------------------------------------------------------
// Group E — Protected paths (always-on, mode-independent) (3 cases)
// ---------------------------------------------------------------------------

check("E1 Write to <plugin-root>/hooks/hooks.json → hard-block even with mode=off", () => {
  const ws = fakeWorkspace();
  const result = resolve({
    toolName: "Write",
    toolInput: { file_path: path.join(ws.pluginRoot, "hooks", "hooks.json"), content: "x" },
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    memoryDir: ws.memoryDir,
    armed: [], // No armed channels — mode=off path
  });
  assert(result.decision === "block", `expected block, got ${result.decision}`);
  assert(result.decision === "block" && result.reason.includes("plugin-hooks"), "reason should mention plugin-hooks");
});

check("E2 Write to ~/.ssh/authorized_keys → hard-block (credential-dir / ssh)", () => {
  const ws = fakeWorkspace();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-home-"));
  const target = path.join(tmpHome, ".ssh", "authorized_keys");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // protected-paths classifier uses os.homedir() unless overridden — use the
  // pure-function form directly to confirm it would catch this path.
  const hit = classifyProtectedPath(target, {
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    homeDir: tmpHome,
  });
  assert(hit !== null && hit.reason === "ssh-dir", `expected ssh-dir hit, got ${hit?.reason}`);
});

check("E3 expanded protected list: .mcp.json, .claude-plugin/plugin.json, ~/.bashrc, ~/.aws/, ~/.gnupg/", () => {
  const ws = fakeWorkspace();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-home-"));
  const cases: Array<[string, string]> = [
    [path.join(ws.workspaceRoot, ".mcp.json"), "workspace-mcp-config"],
    [path.join(ws.pluginRoot, ".claude-plugin", "plugin.json"), "plugin-manifest"],
    [path.join(tmpHome, ".bashrc"), "shell-init"],
    [path.join(tmpHome, ".aws", "credentials"), "credential-dir"],
    [path.join(tmpHome, ".gnupg", "secring.gpg"), "credential-dir"],
    [path.join(tmpHome, ".claude", "settings.json"), "claude-home"],
  ];
  for (const [p, expectedReason] of cases) {
    const hit = classifyProtectedPath(p, {
      pluginRoot: ws.pluginRoot,
      workspaceRoot: ws.workspaceRoot,
      homeDir: tmpHome,
    });
    assert(hit !== null, `expected protected-path hit for ${p}`);
    assert(hit.reason === expectedReason, `expected ${expectedReason} for ${p}, got ${hit.reason}`);
  }
});

// ---------------------------------------------------------------------------
// Group F — Bash hard-deny (1 case)
// ---------------------------------------------------------------------------

check("F0 Task hard-deny under armed + non-owner (subagent bypass closure)", () => {
  // Codex Step 2 pre-impl C: Task is hard-denied unconditionally
  // because Claude Code hook propagation to subagents isn't guaranteed.
  // Without this, a non-owner inbound could induce `Task` spawn → subagent
  // runs Bash inside without the gate firing.
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    // Allowlist policy that EXPLICITLY includes Task — hard-deny still fires.
    const armed = armedWA(cd, { policy: "allowlist", tools: ["Task", "Read"] });
    const result = resolve(baseInput("Task", { description: "do x" }, [armed]));
    assert(result.decision === "block", `Task should be hard-denied, got ${result.decision}`);
  });
});

check("F1 Bash hard-deny under armed + non-owner regardless of command content", () => {
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  withTrustDir(() => {
    // Allowlist policy that EXPLICITLY allows Bash — hard-deny should still fire.
    const armed = armedWA(cd, { policy: "allowlist", tools: ["Bash", "Read"] });
    const cases = [
      "echo hi",
      "tee /tmp/x",
      "dd of=/tmp/y bs=1 count=1",
      "cat <<EOF > /tmp/z\nhello\nEOF",
      "bash -c 'echo nested'",
    ];
    for (const cmd of cases) {
      const result = resolve(baseInput("Bash", { command: cmd }, [armed]));
      assert(result.decision === "block", `expected block for "${cmd}", got ${result.decision}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Group G — Config coercion (fail-closed) (4 cases)
// ---------------------------------------------------------------------------

check("G1 mode=invalid string → coerced to enforce+denylist+defaults", () => {
  const c = coerceExecGateConfig({ mode: "porpipoorpi" });
  assert(c.mode === "enforce", `expected enforce, got ${c.mode}`);
  assert(c.policy === "denylist", `expected denylist, got ${c.policy}`);
  assert(c.tools.length === DEFAULT_DENYLIST_TOOLS.length, "tools count");
});

check("G2 tools=string-not-array → coerced", () => {
  const c = coerceExecGateConfig({ mode: "enforce", policy: "denylist", tools: "not-an-array" });
  assert(c.mode === "enforce", `expected enforce, got ${c.mode}`);
  assert(Array.isArray(c.tools), "tools should be an array");
});

check("G3 policy=invalid → coerced", () => {
  const c = coerceExecGateConfig({ mode: "enforce", policy: "neither" });
  assert(c.policy === "denylist", `expected denylist, got ${c.policy}`);
});

check("G4 lookbackMs invalid (negative/Infinity/NaN/string) → coerced to default", () => {
  for (const bad of [-1, Infinity, NaN, "30000"]) {
    const c = coerceExecGateConfig({ mode: "shadow", lookbackMs: bad as number });
    assert(c.lookbackMs === EXEC_GATE_DEFAULT_LOOKBACK_MS, `expected default for ${bad}, got ${c.lookbackMs}`);
    // Invalid field also triggers fail-closed escalation to enforce.
    assert(c.mode === "enforce", `expected mode enforce after invalid lookbackMs ${bad}, got ${c.mode}`);
  }
});

// ---------------------------------------------------------------------------
// Group H — Multi-channel + shadow log rotation + agent-config-guard regression
// (3 cases)
// ---------------------------------------------------------------------------

check("H1 Multi-channel: WA non-owner blocks regardless of Telegram window state", () => {
  const cdWa = mkChannelDir();
  const cdTg = mkChannelDir();
  writeEnvelope(cdWa, freshTok(), { senderId: NON_OWNER_JID });
  // Telegram window empty.
  fs.mkdirSync(path.join(cdTg, ENVELOPE_DIR_NAME), { recursive: true, mode: 0o700 });

  withTrustDir(() => {
    const armed: ArmedChannel[] = [
      armedWA(cdWa),
      {
        channel: "telegram",
        channelDir: cdTg,
        ownerJids: [OWNER_JID],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
        },
      },
    ];
    const result = resolve(baseInput("Bash", { command: "echo hi" }, armed));
    assert(result.decision === "block", `expected block from WA, got ${result.decision}`);
    assert(result.decision === "block" && result.channel === "whatsapp", "channel attribution");
  });
});

check("H2 Shadow log rotation: file > 1 MB triggers atomic rename to .1, canonical resets", () => {
  const ws = fakeWorkspace();
  const logPath = path.join(ws.memoryDir, ".execgate-shadow.jsonl");
  // Seed BIG: well over the cap so we know rotation will fire on the
  // very next event. Use a distinctive marker so we can verify the .1
  // contains the OLD content and the new canonical is the rotated one.
  const seedMarker = "SEED_MARKER_OLD_FILE";
  const seedLine = JSON.stringify({ marker: seedMarker, fill: "x".repeat(2000) }) + "\n";
  let written = 0;
  const target = SHADOW_LOG_MAX_BYTES + 200_000; // 1.2 MB
  while (written < target) {
    fs.appendFileSync(logPath, seedLine, { mode: 0o600 });
    fs.chmodSync(logPath, 0o600);
    written += seedLine.length;
  }
  const seededSize = fs.statSync(logPath).size;
  assert(seededSize > SHADOW_LOG_MAX_BYTES, `fixture: seeded size ${seededSize} should exceed cap`);

  // Trigger rotation with a small event.
  const newEvent: ShadowEvent = {
    ts: new Date().toISOString(),
    channel: "whatsapp",
    senderHash: "abcdef01",
    toolName: "Bash",
    decision: "would-block",
    effectiveMode: "shadow",
    policy: "denylist",
    expandedTools: ["Bash"],
    hookVersion: EXEC_GATE_HOOK_VERSION,
    configHash: "deadbeefcafebabe",
    lookbackMs: 60000,
    windowEnvelopeCount: 1,
  };
  const result = appendShadowEvent(newEvent, { logDir: ws.memoryDir });
  assert(result.ok, `appendShadowEvent should succeed: reason=${result.reason}`);
  // .1 should exist with the OLD content.
  assert(fs.existsSync(`${logPath}.1`), ".1 backup should exist after rotation");
  const backupContent = fs.readFileSync(`${logPath}.1`, "utf-8");
  assert(backupContent.includes(seedMarker), ".1 backup should contain the OLD seeded marker");
  // New canonical should be small and contain ONLY the new event.
  const newContent = fs.readFileSync(logPath, "utf-8");
  assert(!newContent.includes(seedMarker), "new canonical should NOT contain old seed marker");
  assert(newContent.includes("deadbeefcafebabe"), "new canonical should contain the freshly-written event");
  const newSize = fs.statSync(logPath).size;
  assert(newSize < SHADOW_LOG_MAX_BYTES / 2, `new canonical should be small after rotation, was ${newSize}`);
});

check("H4 most-restrictive aggregation: WA shadow + Telegram enforce, both non-owner → enforce wins (block)", () => {
  // BLOCKER 1 regression: first-channel-wins would have surfaced a
  // shadow decision here; v6 fix must surface enforce.
  const cdWa = mkChannelDir();
  const cdTg = mkChannelDir();
  writeEnvelope(cdWa, freshTok(), { senderId: NON_OWNER_JID });
  writeEnvelope(cdTg, freshTok(), { senderId: NON_OWNER_JID });

  withTrustDir(() => {
    const armed: ArmedChannel[] = [
      // Iteration order: WA first (shadow), Telegram second (enforce).
      armedWA(cdWa, { mode: "shadow" }),
      {
        channel: "telegram",
        channelDir: cdTg,
        ownerJids: [OWNER_JID],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
        },
      },
    ];
    const result = resolve(baseInput("Bash", { command: "echo hi" }, armed));
    assert(result.decision === "block", `most-restrictive: expected block, got ${result.decision}`);
    assert(result.decision === "block" && result.channel === "telegram", `should be attributed to telegram (enforce), got ${(result as { channel?: string }).channel}`);
  });
});

check("H5 realpath canonicalization: symlinked-alias path resolves to protected target → block", () => {
  // BLOCKER 3 regression: protected-paths classifier MUST canonicalize
  // via realpath of the deepest existing ancestor before comparing.
  const ws = fakeWorkspace();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-home-"));
  // Create real ~/.ssh.
  fs.mkdirSync(path.join(tmpHome, ".ssh"), { recursive: true });
  // Create an alias directory in tmp that symlinks to ~/.ssh.
  const aliasParent = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-alias-"));
  const aliasSshLink = path.join(aliasParent, "ssh-alias");
  fs.symlinkSync(path.join(tmpHome, ".ssh"), aliasSshLink);

  // A write through the alias path SHOULD still match `ssh-dir`.
  const target = path.join(aliasSshLink, "authorized_keys");
  const hit = classifyProtectedPath(target, {
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    homeDir: tmpHome,
  });
  assert(hit !== null, "expected protected-path hit through symlink alias");
  assert(hit.reason === "ssh-dir", `expected ssh-dir, got ${hit.reason}`);
});

check("H6 coerceExecGateConfig: null block → enforce fallback (fail-closed)", () => {
  // WARN 4 fix verification: null is malformed at the BLOCK level.
  const c = coerceExecGateConfig(null);
  assert(c.mode === "enforce", `null → enforce, got ${c.mode}`);
});

check("H7 coerceExecGateConfig: non-object (string, number, array) → enforce fallback", () => {
  for (const bad of ["string-value", 42, ["array"], true]) {
    const c = coerceExecGateConfig(bad);
    assert(c.mode === "enforce", `${JSON.stringify(bad)} → enforce, got ${c.mode}`);
  }
});

check("H8 coerceExecGateConfig: undefined block → off (legitimate not-configured path)", () => {
  const c = coerceExecGateConfig(undefined);
  assert(c.mode === "off", `undefined → off, got ${c.mode}`);
});

check("H9 coerceExecGateConfig: tools=[] (empty array) → default tools, NOT empty override", () => {
  const c = coerceExecGateConfig({ mode: "enforce", policy: "denylist", tools: [] });
  assert(c.tools.length > 0, `empty tools[] should fall back to defaults, got ${c.tools.length}`);
  assert(c.tools.includes("Bash"), "default denylist should include Bash");
});

check("H10 trust-file with mode 0o644 (world-readable) → isOwnerTrusted returns false", () => {
  // WARN 7 fix: trust file must be 0o600 (or stricter).
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    fs.writeFileSync(path.join(trustDir, "whatsapp-exec"), "");
    fs.chmodSync(path.join(trustDir, "whatsapp-exec"), 0o644);
    const cd = mkChannelDir();
    writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
    const result = resolve(baseInput("Bash", { command: "echo hi" }, [armedWA(cd)]));
    assert(result.decision === "block", `world-readable trust should NOT unlock, got ${result.decision}`);
  });
});

check("H11 effects injection: custom isOwnerTrusted + recordShadow are honored", () => {
  // BLOCKER 2 verification: resolver consults injected effects instead
  // of real FS for trust + shadow log.
  const cd = mkChannelDir();
  writeEnvelope(cd, freshTok(), { senderId: NON_OWNER_JID });
  let trustCalls = 0;
  let recordCalls = 0;
  const ws = fakeWorkspace();
  const result = resolve({
    toolName: "Bash",
    toolInput: { command: "echo hi" },
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    memoryDir: ws.memoryDir,
    armed: [armedWA(cd, { mode: "shadow" })],
    effects: {
      isOwnerTrusted: () => {
        trustCalls++;
        return false;
      },
      recordShadow: () => {
        recordCalls++;
      },
    },
  });
  assert(result.decision === "shadow", `expected shadow, got ${result.decision}`);
  assert(trustCalls === 1, `expected 1 trust call, got ${trustCalls}`);
  assert(recordCalls === 1, `expected 1 shadow record call, got ${recordCalls}`);
});

check("H3 agent-config-guard regression: scope.<x>.execGate.<y> writes refused", () => {
  // Sanity-check that the existing classifier already covers execGate paths.
  // No code change needed in agent-config-guard.ts; this is a regression guard.
  //
  // Codex round-2 LOW 4: include unknown subkeys (forward-compat) so a
  // future field added under `execGate` is automatically refused by the
  // same blocklist. The classifier is path-prefix; any descendant of a
  // privileged key is also privileged.
  const cases = [
    "scope.whatsapp.execGate.mode",
    "scope.telegram.execGate.policy",
    "scope.whatsapp.execGate.tools",
    "scope.whatsapp.execGate.lookbackMs",
    "scope.whatsapp.execGate", // ancestor object write
    // Wildcard / forward-compat subkeys — must be refused too.
    "scope.whatsapp.execGate.allowedSenders",
    "scope.discord.execGate.someFutureField",
    "scope.imessage.execGate.tools.0", // deeply-nested
  ];
  for (const key of cases) {
    const cls = classifyAgentConfigKey(key);
    assert(cls === "scope", `expected "scope" classification for ${key}, got ${cls}`);
  }
});

// ---------------------------------------------------------------------------
// Bonus: extractToolPath + execGateConfigForChannel surface verification
// ---------------------------------------------------------------------------

check("X1 extractToolPath returns file_path for Write/Edit/MultiEdit and notebook_path for NotebookEdit", () => {
  assert(extractToolPath("Write", { file_path: "/x" }) === "/x", "Write file_path");
  assert(extractToolPath("Edit", { file_path: "/y" }) === "/y", "Edit file_path");
  assert(extractToolPath("MultiEdit", { file_path: "/z" }) === "/z", "MultiEdit file_path");
  assert(extractToolPath("NotebookEdit", { notebook_path: "/n.ipynb" }) === "/n.ipynb", "NotebookEdit");
  assert(extractToolPath("Bash", { command: "ls" }) === null, "Bash should not return a path");
  assert(extractToolPath("Read", { file_path: "/x" }) === null, "Read is not in PROTECTED_PATH_TOOLS");
});

check("X2 execGateConfigForChannel returns coerced mode=off when absent", () => {
  const c = execGateConfigForChannel(undefined, "whatsapp");
  assert(c.mode === "off", `expected off when scope tree absent, got ${c.mode}`);
});

// ---------------------------------------------------------------------------
// Group J — Codex Step 2 post-impl round-1 FAIL fixes (4 cases)
// ---------------------------------------------------------------------------

check("J1 (FAIL A) unresolved enforce channel + denylist Bash → block, NOT silent allow", () => {
  // Governance unresolvable (channelDir empty, ownerJids []) for an
  // enforce-configured channel must synthesize a non-owner hit and
  // block. Previously the entry script dropped the channel and the
  // resolver short-circuited to allow.
  withTrustDir(() => {
    const ws = fakeWorkspace();
    const armed: ArmedChannel[] = [
      {
        channel: "whatsapp",
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
        },
        unresolved: true,
      },
    ];
    const result = resolve({
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      pluginRoot: ws.pluginRoot,
      workspaceRoot: ws.workspaceRoot,
      memoryDir: ws.memoryDir,
      armed,
    });
    assert(result.decision === "block", `unresolved+enforce should block, got ${result.decision}`);
    assert(
      result.decision === "block" && result.channel === "whatsapp",
      "should attribute to whatsapp"
    );
    // SenderHash should be derived from the sentinel (not a real JID).
    assert(
      result.decision === "block" && /^[0-9a-f]{8}$/.test(result.senderHash ?? ""),
      "senderHash should be 8-hex-char"
    );
  });
});

check("J2 (FAIL A) unresolved channel + <channel>-exec trust → allow (escape hatch works)", () => {
  // The unresolved sentinel still respects the user's out-of-band trust
  // file. User who knows the install is fine (e.g. mid-uninstall, manual
  // setup) can create the trust file to unlock.
  withTrustDir(() => {
    const trustDir = process.env.CLAW_SCOPE_TRUST_DIR!;
    fs.writeFileSync(path.join(trustDir, "whatsapp-exec"), "", { mode: 0o600 });
    fs.chmodSync(path.join(trustDir, "whatsapp-exec"), 0o600);
    const ws = fakeWorkspace();
    const armed: ArmedChannel[] = [
      {
        channel: "whatsapp",
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "enforce",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
        },
        unresolved: true,
      },
    ];
    const result = resolve({
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      pluginRoot: ws.pluginRoot,
      workspaceRoot: ws.workspaceRoot,
      memoryDir: ws.memoryDir,
      armed,
    });
    assert(result.decision === "allow", `trust file should unlock unresolved, got ${result.decision}`);
  });
});

check("J3 (FAIL A) unresolved shadow channel + denylist tool → shadow event recorded", () => {
  // Shadow mode under unresolved should LOG (not block). Ensures the
  // shadow log path doesn't get skipped when sentinel-driven.
  let shadowed = 0;
  withTrustDir(() => {
    const ws = fakeWorkspace();
    const armed: ArmedChannel[] = [
      {
        channel: "whatsapp",
        channelDir: "",
        ownerJids: [],
        execGate: {
          mode: "shadow",
          policy: "denylist",
          tools: [...DEFAULT_DENYLIST_TOOLS],
          lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
        },
        unresolved: true,
      },
    ];
    const result = resolve({
      toolName: "Bash",
      toolInput: { command: "echo hi" },
      pluginRoot: ws.pluginRoot,
      workspaceRoot: ws.workspaceRoot,
      memoryDir: ws.memoryDir,
      armed,
      effects: {
        isOwnerTrusted: () => false,
        recordShadow: () => {
          shadowed++;
        },
      },
    });
    assert(result.decision === "shadow", `expected shadow, got ${result.decision}`);
    assert(shadowed === 1, `expected 1 shadow record, got ${shadowed}`);
  });
});

check("J4 (FAIL G) bundle source-SHA header matches recomputed hash of source files", async () => {
  // Drift detection: hand-edited or stale dist/exec-gate-resolver.cjs
  // fails this assertion before it can ship. Mirror the same computation
  // the build script does so the only way to keep this test green is to
  // re-run `npm run build:hook`.
  const buildScript = await import("../scripts/build-exec-gate-hook.mjs");
  const expectedSha = buildScript.computeSourceSha();

  const bundlePath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "dist",
    "exec-gate-resolver.cjs"
  );
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      "dist/exec-gate-resolver.cjs missing — run `npm run build:hook`"
    );
  }
  const firstLine = fs.readFileSync(bundlePath, "utf8").split("\n", 1)[0];
  const match = firstLine.match(/^\/\* scope-exec-gate-bundle@([0-9a-f]{64}) \*\/$/);
  assert(match !== null, `bundle missing source-sha header: "${firstLine}"`);
  assert(
    match[1] === expectedSha,
    `bundle source-sha mismatch — rebuild with \`npm run build:hook\`. expected=${expectedSha.slice(0, 16)}… got=${match[1].slice(0, 16)}…`
  );
});

// ---------------------------------------------------------------------------
// Group K — Codex round-2 fixes (HIGH/MEDIUM/LOW)
// ---------------------------------------------------------------------------

check("K1 (round-2 MEDIUM) <channel-dir>/access.json is in protected-paths", () => {
  const ws = fakeWorkspace();
  const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-cd-"));
  const accessJson = path.join(channelDir, "access.json");
  fs.writeFileSync(accessJson, "{}", { mode: 0o600 });
  // With channelDirs passed in, the write must be refused.
  const hit = classifyProtectedPath(accessJson, {
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    channelDirs: [channelDir],
  });
  assert(hit !== null, "expected protected-path hit for access.json");
  assert(hit.reason === "channel-access-json", `expected channel-access-json reason, got ${hit.reason}`);
});

check("K2 (round-2 MEDIUM) resolver passes armed channelDirs through to classifier", () => {
  // Resolver-level integration: when armed channel has channelDir set,
  // a Write to that channel's access.json is refused.
  withTrustDir(() => {
    const ws = fakeWorkspace();
    const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-cd-int-"));
    const accessJson = path.join(channelDir, "access.json");
    fs.writeFileSync(accessJson, "{}", { mode: 0o600 });
    fs.mkdirSync(path.join(channelDir, ENVELOPE_DIR_NAME), { recursive: true, mode: 0o700 });
    const result = resolve({
      toolName: "Write",
      toolInput: { file_path: accessJson, content: "bogus" },
      pluginRoot: ws.pluginRoot,
      workspaceRoot: ws.workspaceRoot,
      memoryDir: ws.memoryDir,
      armed: [
        {
          channel: "whatsapp",
          channelDir,
          ownerJids: [OWNER_JID],
          execGate: {
            mode: "off",
            policy: "denylist",
            tools: [],
            lookbackMs: EXEC_GATE_DEFAULT_LOOKBACK_MS,
          },
        },
      ],
    });
    assert(
      result.decision === "block",
      `expected block on access.json write, got ${result.decision}`
    );
    assert(
      result.decision === "block" &&
        result.protectedPath?.reason === "channel-access-json",
      "expected channel-access-json reason"
    );
  });
});

check("K3 (round-2 LOW 1) coerceExecGateConfig fallback uses DEFAULT_DENYLIST_TOOLS, not []", () => {
  // The fail-closed fallback was previously tools: [] — only hard-deny
  // pair (Bash/Task) would block under that. Verify it's populated.
  const c = coerceExecGateConfig({ mode: "off", policy: "weird" });
  // Round-2 HIGH 1 corollary: invalid subfield escalates to enforce.
  assert(c.mode === "enforce", `mode should escalate to enforce, got ${c.mode}`);
  assert(c.tools.length === DEFAULT_DENYLIST_TOOLS.length, "tools should equal DEFAULT_DENYLIST_TOOLS");
  assert(c.tools.includes("Write"), "default denylist should include Write");
});

check("K4 (round-2 HIGH 1) jq/TS asymmetry: invalid sub-field with mode=off escalates", () => {
  // TS: `{mode: "off", tools: 42}` → invalid escalates → enforce.
  const c = coerceExecGateConfig({ mode: "off", tools: 42 });
  assert(c.mode === "enforce", `mode=off + invalid sub-field should escalate, got ${c.mode}`);
});

check("K6 (round-3 MEDIUM) protectedChannelDirs covers mode=off channels via explicit list", () => {
  // When the entry threads protectedChannelDirs explicitly (round-3
  // fix), the resolver passes those to classifyProtectedPath even
  // though no entries appear in armed[] (mode=off short-circuits
  // armed enumeration).
  const ws = fakeWorkspace();
  const channelDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-execgate-cd-r3-"));
  const accessJson = path.join(channelDir, "access.json");
  fs.writeFileSync(accessJson, "{}", { mode: 0o600 });
  const result = resolve({
    toolName: "Write",
    toolInput: { file_path: accessJson, content: "bogus" },
    pluginRoot: ws.pluginRoot,
    workspaceRoot: ws.workspaceRoot,
    memoryDir: ws.memoryDir,
    armed: [], // No armed channels at all (off-everywhere)
    protectedChannelDirs: [channelDir],
  });
  assert(
    result.decision === "block",
    `expected block on access.json write with explicit protectedChannelDirs, got ${result.decision}`
  );
  assert(
    result.decision === "block" &&
      result.protectedPath?.reason === "channel-access-json",
    "expected channel-access-json reason"
  );
});

check("K7 (round-3 LOW 1) discoverSourceFiles normalizes Windows backslashes", async () => {
  // Synthetic test: invoke esbuild and confirm forward-slash paths.
  // We can't reliably trigger Windows behavior in unit tests, but we
  // can sanity-check that the filter respects the normalization.
  const buildScript = await import("../scripts/build-exec-gate-hook.mjs");
  const files = buildScript.discoverSourceFiles();
  for (const f of files) {
    assert(!f.includes("\\"), `discoverSourceFiles should normalize backslashes, found: ${f}`);
  }
});

check("K8 (round-4 LOW 2) discoverSourceFiles filters Windows-style node_modules and parent paths", async () => {
  // Codex round-4 LOW 2: synthetic Windows-style paths through the
  // filter logic. We inject the inputs directly so the test is
  // platform-independent and actually proves the backslash normalize
  // step kicks in (K7 alone can't because it only sees POSIX paths
  // from the local metafile).
  const buildScript = await import("../scripts/build-exec-gate-hook.mjs");
  const synthetic = [
    "lib\\scope\\exec-gate.ts",          // legitimate workspace path
    "node_modules\\some-pkg\\index.js",  // backslash variant of node_modules
    "..\\other-repo\\foo.ts",            // backslash parent
    ".\\lib\\index.ts",                  // backslash current-dir prefix
    "node_modules/posix-pkg/index.js",   // POSIX variant (control)
    "lib/scope/runtime.ts",              // POSIX workspace file (control)
  ];
  const files = buildScript.discoverSourceFiles({ injectedInputs: synthetic });
  assert(files.includes("lib/scope/exec-gate.ts"), "expected backslash workspace path to be normalized and kept");
  assert(files.includes("lib/scope/runtime.ts"), "expected POSIX workspace path kept");
  assert(files.includes("lib/index.ts"), "expected `.\\lib\\index.ts` normalized and prefix-stripped");
  assert(!files.some((f) => f.includes("node_modules")), "node_modules entries must be filtered (both / and \\)");
  assert(!files.some((f) => f.startsWith("../")), "parent paths must be filtered");
  // Sorted.
  const sortedCopy = [...files].sort();
  assert(JSON.stringify(files) === JSON.stringify(sortedCopy), "result should be sorted");
});

check("K5 (round-2 LOW 2) discoverSourceFiles returns workspace-local set, sorted, no node_modules", async () => {
  const buildScript = await import("../scripts/build-exec-gate-hook.mjs");
  const files = buildScript.discoverSourceFiles();
  assert(Array.isArray(files), "discoverSourceFiles should return an array");
  assert(files.length > 0, "should discover at least one source file");
  // Sorted.
  const sortedCopy = [...files].sort();
  assert(
    JSON.stringify(files) === JSON.stringify(sortedCopy),
    "files should be sorted"
  );
  // No node_modules entries.
  for (const f of files) {
    assert(!f.startsWith("node_modules/"), `node_modules entry leaked: ${f}`);
    assert(!f.startsWith("../"), `escaped-workspace entry leaked: ${f}`);
  }
  // The entry point must be present.
  assert(
    files.includes("lib/scope/exec-gate-hook-entry.ts"),
    `entry not in discovered files`
  );
  // The newly-split channel-hint should be discovered automatically.
  assert(
    files.includes("lib/scope/channel-hint.ts"),
    `channel-hint.ts not auto-discovered — esbuild metafile is wrong`
  );
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function report() {
  // Wait for any async test bodies queued via `check()` to settle.
  await Promise.all(pendingChecks);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  for (const r of results) {
    if (!r.pass) console.error(`  FAIL ${r.name}: ${r.msg}`);
  }
  console.log(`exec-gate tier1: ${passed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}
void report();
