/**
 * Tier 1 regression tests for the Codex 6th-pass post-impl finding on
 * Phase 4a-2.5 v6 (1 HIGH; LOW F-6-2 deferred as documented limitation).
 *
 * Coverage:
 *   - HIGH F-6-1: `voice.outputDir` is a path-bearing key whose value
 *     becomes a trusted write root in `assertSafeOutputPath`'s
 *     allowlist. v6 trusted whatever was configured; the agent could
 *     `agent_config(action='set', key='voice.outputDir', value='~/.ssh')`
 *     and then `voice_speak(outputPath='~/.ssh/authorized_keys')`. v7
 *     adds `voice.outputDir` (and `voice.config.outputDir`) to a
 *     "privileged" key list refused by `agent_config`. Ancestor
 *     ancestor-object writes (`voice` / `voice.config`) are also
 *     refused so the same v5 widening that blocks scope ancestors
 *     blocks voice ancestors.
 *
 * Run: `npx tsx tests/scope-v7-codex-6th-pass.test.ts`
 */

import { classifyAgentConfigKey } from "../lib/scope/agent-config-guard.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e) {
    results.push({ name, pass: false, msg: String(e) });
  }
}

// ---------------------------------------------------------------------------
// HIGH F-6-1: voice.outputDir privileged-key block
// ---------------------------------------------------------------------------

check("HIGH F-6-1: blocks `voice.outputDir` (exact)", () => {
  if (classifyAgentConfigKey("voice.outputDir") !== "privileged")
    throw new Error("voice.outputDir must be privileged");
});

check("HIGH F-6-1: blocks `voice.config.outputDir` (alias path)", () => {
  if (classifyAgentConfigKey("voice.config.outputDir") !== "privileged")
    throw new Error("voice.config.outputDir must be privileged");
});

check("HIGH F-6-1: blocks bare `voice` (ancestor-object write)", () => {
  // The agent could set `key="voice", value='{"outputDir":"~/.ssh"}'` —
  // ancestor-object widening must catch it.
  if (classifyAgentConfigKey("voice") !== "privileged")
    throw new Error("bare voice ancestor must be privileged");
});

check("HIGH F-6-1: blocks `voice.config` (ancestor-object of nested key)", () => {
  if (classifyAgentConfigKey("voice.config") !== "privileged")
    throw new Error("voice.config ancestor must be privileged");
});

check("HIGH F-6-1: ALLOWS `voice.defaultBackend` (non-path key)", () => {
  if (classifyAgentConfigKey("voice.defaultBackend") !== false)
    throw new Error("non-path voice keys must pass");
});

check("HIGH F-6-1: ALLOWS `voice.someUnrelatedSetting`", () => {
  if (classifyAgentConfigKey("voice.someUnrelatedSetting") !== false)
    throw new Error("non-path voice keys must pass");
});

check(
  "HIGH F-6-1: ALLOWS `voice.config.defaultBackend` (non-path nested)",
  () => {
    if (classifyAgentConfigKey("voice.config.defaultBackend") !== false)
      throw new Error("non-path nested voice keys must pass");
  }
);

check("HIGH F-6-1: scope still wins over privileged for scope-prefixed keys", () => {
  // `scope.voice.outputDir` doesn't exist in our schema but verify
  // ordering — scope check fires first.
  if (classifyAgentConfigKey("scope.voice.outputDir") !== "scope")
    throw new Error("scope check must fire before privileged");
});

check("HIGH F-6-1: oversize still wins over privileged", () => {
  // Build a privileged key longer than 256 chars somehow — pad with
  // a dotted tail of legitimate-looking segments. The classifier
  // should report oversize as the cheapest rejection.
  const big = "voice.outputDir." + "x".repeat(70);
  // 70 > MAX_SEGMENT_CHARS (64) so this should be oversize via segment
  // length even though the total chars are under 256.
  if (classifyAgentConfigKey(big) !== "oversize")
    throw new Error(
      "oversize segment must beat privileged (cheapest rejection)"
    );
});

check("HIGH F-6-1: proto still wins over privileged", () => {
  if (classifyAgentConfigKey("voice.__proto__.outputDir") !== "proto")
    throw new Error("proto must beat privileged");
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

setTimeout(() => {
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.pass) {
      pass++;
      console.log(`  ✓ ${r.name}`);
    } else {
      fail++;
      console.log(`  ✗ ${r.name}: ${r.msg}`);
    }
  }
  console.log(`\n${pass}/${pass + fail} v7 Codex-6th-pass tests passed`);
  if (fail > 0) process.exit(1);
}, 50);
