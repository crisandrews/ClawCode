/**
 * Tier 1 tests for Phase 4a-1 enforcement (`lib/scope/filter.ts`).
 *
 * Covers:
 *   - filterScopedResults strict no-op when runtime.anyArmed === false
 *   - off mode passes everything through, evaluated=false
 *   - shadow mode counts notVisible but does NOT drop
 *   - enforce mode drops + counts; non-channel chunks always pass
 *   - missing adapter + enforce → fail-closed (drop); shadow → pass
 *   - operatorIsOwner derived from adapter.allowedChatIds(null) → owner-equivalent
 *     and adapter.allowedChatIds([]) → not-owner
 *   - assertCanReadPath returns sanitized scope-denied:<channel>:<8-hex> error
 *     (never leaks the path or chat id)
 *   - assertCanReadPath shadow mode allows even when adapter denies
 *   - assertCanReadPath off mode allows always
 *   - buildSqlPreFilter empty when no channel armed
 *   - buildSqlPreFilter emits `chunks.source_channel != ?` for armed
 *     channels in enforce mode whose adapter denies all
 *   - buildSqlPreFilter shadow mode emits no SQL
 *   - sanitizeDenied is deterministic + 8-char hex
 *
 * Run: `npx tsx tests/scope-filter.test.ts`
 */

import {
  EMPTY_STATS,
  assertCanReadPath,
  buildSqlPreFilter,
  filterScopedResults,
  sanitizeDenied,
} from "../lib/scope/filter.ts";
import {
  _resetRegistryForTests,
  registerScopeAdapter,
  type ScopeAdapter,
} from "../lib/scope/index.ts";
import type { ScopeRuntimeState } from "../lib/scope/runtime.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import type { ChunkProvenance } from "../lib/scope/provenance.ts";
import type { SearchResult } from "../lib/types.ts";

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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function noArmedRuntime(): ScopeRuntimeState {
  return { anyArmed: false, anyEnforceConfigured: false, channels: {} };
}

function shadowArmedRuntime(): ScopeRuntimeState {
  return {
    anyArmed: true,
    anyEnforceConfigured: false,
    channels: {
      whatsapp: {
        mode: "shadow",
        configured: true,
        adapterAvailable: true,
        governanceResolvable: true,
        armed: true,
      },
    },
  };
}

function enforceArmedRuntime(): ScopeRuntimeState {
  return {
    anyArmed: true,
    anyEnforceConfigured: true,
    channels: {
      whatsapp: {
        mode: "enforce",
        configured: true,
        adapterAvailable: true,
        governanceResolvable: true,
        armed: true,
      },
    },
  };
}

function makeChannelResult(
  pathStr: string,
  channel: "whatsapp" = "whatsapp"
): SearchResult {
  return {
    path: pathStr,
    startLine: 1,
    endLine: 5,
    snippet: "test",
    score: 0.5,
    citation: `${pathStr}#L1-5`,
    provenance: {
      class: { kind: "channel", sourceChannel: channel, sourceChatId: null },
      sourceChannel: channel,
      sourceChatId: null,
    },
  };
}

function makeLocalResult(pathStr: string): SearchResult {
  return {
    path: pathStr,
    startLine: 1,
    endLine: 5,
    snippet: "local",
    score: 0.5,
    citation: `${pathStr}#L1-5`,
    provenance: {
      class: { kind: "local" },
      sourceChannel: null,
      sourceChatId: null,
    },
  };
}

function denyAllAdapter(): ScopeAdapter {
  return {
    channel: "whatsapp",
    requiresPerChunkCheck: false,
    canSee: () => false,
    allowedChatIds: () => [],
  };
}

function ownerAllowAllAdapter(): ScopeAdapter {
  return {
    channel: "whatsapp",
    requiresPerChunkCheck: false,
    canSee: () => true,
    allowedChatIds: () => null, // null = owner-equivalent
  };
}

function partialAllowAdapter(allowed: Set<string>): ScopeAdapter {
  return {
    channel: "whatsapp",
    requiresPerChunkCheck: true,
    canSee: (prov: ChunkProvenance) =>
      prov.class.kind === "channel" &&
      prov.sourceChatId !== null &&
      allowed.has(prov.sourceChatId),
    allowedChatIds: () => Array.from(allowed),
  };
}

const ctx = makeForegroundContext("test-req-1");

// ---------------------------------------------------------------------------
// filterScopedResults — no-arm short-circuit (zero-diff invariant)
// ---------------------------------------------------------------------------

check("filterScopedResults: no-armed runtime returns input unchanged + EMPTY_STATS", () => {
  _resetRegistryForTests();
  const input = [
    makeChannelResult("extra:claude-whatsapp/2026-04-26.md"),
    makeLocalResult("memory/MEMORY.md"),
  ];
  const { results: out, stats } = filterScopedResults(
    input,
    ctx,
    noArmedRuntime()
  );
  assert(out === input, "same array reference passes through");
  assert(stats.evaluated === false, "stats not evaluated");
  assert(stats.dropped === 0, "no drops reported");
  // EMPTY_STATS shape preserved.
  assert(stats.total === 0 && stats.kept === 0, "stats default zeros");
});

check("filterScopedResults: EMPTY_STATS is frozen", () => {
  let threw = false;
  try {
    (EMPTY_STATS as unknown as { evaluated: boolean }).evaluated = true;
  } catch {
    threw = true;
  }
  // Object.freeze in strict mode (which TS-strict typically is) would
  // throw; either way the value must not change.
  assert(EMPTY_STATS.evaluated === false, "EMPTY_STATS.evaluated stays false");
  assert(threw || EMPTY_STATS.evaluated === false, "frozen or unchanged");
});

// ---------------------------------------------------------------------------
// filterScopedResults — shadow vs enforce
// ---------------------------------------------------------------------------

check("filterScopedResults: shadow mode counts notVisible but keeps everything", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const input = [
    makeChannelResult("extra:claude-whatsapp/a.md"),
    makeChannelResult("extra:claude-whatsapp/b.md"),
    makeLocalResult("memory/MEMORY.md"),
  ];
  const { results: out, stats } = filterScopedResults(
    input,
    ctx,
    shadowArmedRuntime()
  );
  assert(out.length === 3, `shadow keeps all 3, got ${out.length}`);
  assert(stats.evaluated === true, "evaluated");
  assert(stats.total === 3, "total counts everything");
  assert(stats.notVisible === 2, `2 channel chunks not visible, got ${stats.notVisible}`);
  assert(stats.dropped === 0, `shadow drops 0, got ${stats.dropped}`);
  assert(stats.kept === 3, `kept all 3, got ${stats.kept}`);
  assert(stats.byChannel.whatsapp === 2, "channel breakdown correct");
  assert(stats.modes.whatsapp === "shadow", "mode tracked");
});

check("filterScopedResults: enforce mode drops denied chunks", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const input = [
    makeChannelResult("extra:claude-whatsapp/a.md"),
    makeChannelResult("extra:claude-whatsapp/b.md"),
    makeLocalResult("memory/MEMORY.md"),
  ];
  const { results: out, stats } = filterScopedResults(
    input,
    ctx,
    enforceArmedRuntime()
  );
  assert(out.length === 1, `enforce keeps only local, got ${out.length}`);
  assert(out[0].path === "memory/MEMORY.md", "local survives");
  assert(stats.dropped === 2, `2 drops in enforce, got ${stats.dropped}`);
  assert(stats.notVisible === 2, "all denied still tracked");
  assert(stats.kept === 1, "1 local kept");
});

check("filterScopedResults: enforce + owner-allow-all keeps everything", () => {
  _resetRegistryForTests();
  registerScopeAdapter(ownerAllowAllAdapter());
  const input = [
    makeChannelResult("extra:claude-whatsapp/a.md"),
    makeChannelResult("extra:claude-whatsapp/b.md"),
  ];
  const { results: out, stats } = filterScopedResults(
    input,
    ctx,
    enforceArmedRuntime()
  );
  assert(out.length === 2, "owner sees both");
  assert(stats.dropped === 0, "no drops for owner");
  assert(stats.notVisible === 0, "owner can see everything");
});

// ---------------------------------------------------------------------------
// filterScopedResults — missing adapter (defensive)
// ---------------------------------------------------------------------------

check("filterScopedResults: missing adapter + enforce → fail-closed", () => {
  _resetRegistryForTests(); // no adapter registered
  const input = [makeChannelResult("extra:claude-whatsapp/a.md")];
  const { results: out, stats } = filterScopedResults(
    input,
    ctx,
    enforceArmedRuntime()
  );
  assert(out.length === 0, "fail-closed drops the channel chunk");
  assert(stats.dropped === 1, "drop counted");
  assert(stats.notVisible === 1, "marked not-visible");
  // Codex P1 fix (Phase 4a-1 review): a missing-adapter drop must
  // also flip operatorIsOwner to false so the surface notice doesn't
  // leak a numeric count to a non-owner.
  assert(
    stats.operatorIsOwner === false,
    "missing-adapter drop must mark non-owner"
  );
});

check("filterScopedResults: missing adapter + shadow → pass-through", () => {
  _resetRegistryForTests();
  const input = [makeChannelResult("extra:claude-whatsapp/a.md")];
  const { results: out } = filterScopedResults(input, ctx, shadowArmedRuntime());
  assert(out.length === 1, "shadow with missing adapter keeps");
});

// ---------------------------------------------------------------------------
// operatorIsOwner — derived from adapter.allowedChatIds
// ---------------------------------------------------------------------------

check("filterScopedResults: operatorIsOwner=true when adapter returns null", () => {
  _resetRegistryForTests();
  registerScopeAdapter(ownerAllowAllAdapter());
  const input = [makeChannelResult("extra:claude-whatsapp/a.md")];
  const { stats } = filterScopedResults(input, ctx, enforceArmedRuntime());
  assert(stats.operatorIsOwner === true, "owner detected");
});

check("filterScopedResults: operatorIsOwner=false when adapter returns []", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const input = [makeChannelResult("extra:claude-whatsapp/a.md")];
  const { stats } = filterScopedResults(input, ctx, enforceArmedRuntime());
  assert(stats.operatorIsOwner === false, "non-owner detected");
});

check("filterScopedResults: operatorIsOwner=false on partial allowlist", () => {
  _resetRegistryForTests();
  registerScopeAdapter(partialAllowAdapter(new Set(["chat-A"])));
  const input = [makeChannelResult("extra:claude-whatsapp/a.md")];
  const { stats } = filterScopedResults(input, ctx, enforceArmedRuntime());
  assert(stats.operatorIsOwner === false, "partial allowlist != owner");
});

// ---------------------------------------------------------------------------
// assertCanReadPath
// ---------------------------------------------------------------------------

check("assertCanReadPath: no-armed runtime allows everything", () => {
  _resetRegistryForTests();
  const r = assertCanReadPath(
    "extra:claude-whatsapp/2026-04-26.md",
    ctx,
    noArmedRuntime()
  );
  assert(r.allowed === true, "allowed without arm");
  if (r.allowed) {
    assert(r.relPath === "extra:claude-whatsapp/2026-04-26.md", "path unchanged");
  }
});

check("assertCanReadPath: local path always allowed even when armed", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const r = assertCanReadPath("memory/MEMORY.md", ctx, enforceArmedRuntime());
  assert(r.allowed === true, "local always allowed");
});

check("assertCanReadPath: shadow mode always allows (no enforcement)", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const r = assertCanReadPath(
    "extra:claude-whatsapp/private.md",
    ctx,
    shadowArmedRuntime()
  );
  assert(r.allowed === true, "shadow lets the read through");
});

check("assertCanReadPath: enforce + denied → sanitized error", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const denialPath = "extra:claude-whatsapp/2026-04-26-secret.md";
  const r = assertCanReadPath(denialPath, ctx, enforceArmedRuntime());
  assert(r.allowed === false, "denied");
  if (!r.allowed) {
    assert(
      r.error.startsWith("scope-denied: whatsapp:"),
      `expected sanitized prefix, got "${r.error}"`
    );
    // Critical security invariant: the original path must not appear.
    assert(!r.error.includes("secret"), "path content not leaked");
    assert(!r.error.includes("2026-04-26"), "date not leaked");
    assert(!r.error.includes(denialPath), "full path not leaked");
    // Hash is exactly 8 hex chars.
    const hash = r.error.split(":").pop() ?? "";
    assert(/^[0-9a-f]{8}$/.test(hash), `expected 8-hex hash, got "${hash}"`);
  }
});

check("assertCanReadPath: enforce + missing adapter → fail-closed", () => {
  _resetRegistryForTests();
  const r = assertCanReadPath(
    "extra:claude-whatsapp/x.md",
    ctx,
    enforceArmedRuntime()
  );
  assert(r.allowed === false, "fail-closed when adapter missing in enforce");
});

// ---------------------------------------------------------------------------
// buildSqlPreFilter
// ---------------------------------------------------------------------------

check("buildSqlPreFilter: no-armed → empty fragment", () => {
  _resetRegistryForTests();
  const pf = buildSqlPreFilter(ctx, noArmedRuntime());
  assert(pf.whereSql === "", "empty SQL");
  assert(pf.params.length === 0, "empty params");
});

check("buildSqlPreFilter: shadow mode → empty fragment (filter post-process only)", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const pf = buildSqlPreFilter(ctx, shadowArmedRuntime());
  assert(pf.whereSql === "", "shadow never emits SQL pre-filter");
});

check("buildSqlPreFilter: enforce + deny-all → channel != ? clause", () => {
  _resetRegistryForTests();
  registerScopeAdapter(denyAllAdapter());
  const pf = buildSqlPreFilter(ctx, enforceArmedRuntime());
  assert(
    pf.whereSql === "chunks.source_channel != ?",
    `unexpected clause "${pf.whereSql}"`
  );
  assert(pf.params.length === 1 && pf.params[0] === "whatsapp", "param bound");
});

check("buildSqlPreFilter: enforce + owner-allow-all → empty (allow-all)", () => {
  _resetRegistryForTests();
  registerScopeAdapter(ownerAllowAllAdapter());
  const pf = buildSqlPreFilter(ctx, enforceArmedRuntime());
  assert(pf.whereSql === "", "owner sees no SQL filter");
});

check("buildSqlPreFilter: enforce + missing adapter → channel != ? (fail-closed)", () => {
  _resetRegistryForTests();
  const pf = buildSqlPreFilter(ctx, enforceArmedRuntime());
  assert(
    pf.whereSql === "chunks.source_channel != ?",
    `expected fail-closed clause, got "${pf.whereSql}"`
  );
  assert(pf.params[0] === "whatsapp", "channel name bound");
});

check("buildSqlPreFilter: enforce + partial allowlist → OR-IN clause (Codex post-impl HIGH 3)", () => {
  // Prior to the post-impl fix, this case fell through and emitted no
  // SQL — many denied chunks could exhaust the FTS5 candidate window.
  // Now we emit `(source_channel != 'whatsapp' OR source_chat_id IN
  // (?, ?))` so the database returns mostly-allowed candidates and
  // refill works.
  _resetRegistryForTests();
  registerScopeAdapter(
    partialAllowAdapter(new Set(["alice@s.whatsapp.net", "bob@s.whatsapp.net"]))
  );
  const pf = buildSqlPreFilter(ctx, enforceArmedRuntime());
  assert(
    pf.whereSql ===
      "(chunks.source_channel != ? OR chunks.source_chat_id IN (?,?))",
    `unexpected partial-allowlist SQL: "${pf.whereSql}"`
  );
  assert(pf.params.length === 3, "1 channel + 2 chat ids");
  assert(pf.params[0] === "whatsapp", "channel bound first");
  assert(
    pf.params.includes("alice@s.whatsapp.net") &&
      pf.params.includes("bob@s.whatsapp.net"),
    "both chat_ids bound"
  );
});

// ---------------------------------------------------------------------------
// sanitizeDenied
// ---------------------------------------------------------------------------

check("sanitizeDenied: deterministic 8-char-hex output", () => {
  const a = sanitizeDenied("whatsapp", "extra:claude-whatsapp/x.md");
  const b = sanitizeDenied("whatsapp", "extra:claude-whatsapp/x.md");
  assert(a === b, "deterministic for same input");
  assert(a.startsWith("scope-denied: whatsapp:"), "channel surfaced");
  const hash = a.split(":").pop() ?? "";
  assert(/^[0-9a-f]{8}$/.test(hash), `8-hex hash, got "${hash}"`);
});

check("sanitizeDenied: different paths produce different hashes", () => {
  const a = sanitizeDenied("whatsapp", "extra:claude-whatsapp/a.md");
  const b = sanitizeDenied("whatsapp", "extra:claude-whatsapp/b.md");
  assert(a !== b, "different paths → different hash");
});

check("sanitizeDenied: never includes raw path or chat id", () => {
  const path = "extra:claude-whatsapp/SECRET-CHAT-1234.md";
  const out = sanitizeDenied("whatsapp", path);
  assert(!out.includes("SECRET"), "path content not leaked");
  assert(!out.includes("1234"), "chat id not leaked");
  assert(!out.includes(path), "full path not leaked");
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-filter tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
