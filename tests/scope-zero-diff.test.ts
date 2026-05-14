/**
 * Tier 2 — zero-diff invariant for users without scope opt-in (Phase 4a-1).
 *
 * The whole point of per-canal opt-in is that nobody who hasn't opted in
 * should observe a single behavior change from this work. This test
 * exercises the runtime end-to-end with a workspace that contains BOTH
 * local memory and channel-derived memory under `extraPaths`, then
 * verifies that:
 *
 *   1. With no `scope` block in the config, searches return ALL chunks
 *      including channel-derived ones — same as the baseline.
 *   2. The pre-Phase-4a-1 search shape (`SearchResult[]`) is preserved;
 *      `provenance` is attached as passive metadata but no `scopeToken`
 *      check or filter step is invoked.
 *   3. `MemoryDB.readFile` returns the channel-derived file content
 *      exactly as the baseline does.
 *   4. `filterScopedResults` returns the input unchanged when the
 *      runtime says no channel is armed (belt-and-suspenders).
 *   5. `assertCanReadPath` is a strict no-op without an armed runtime.
 *   6. `buildSqlPreFilter` emits an empty SQL fragment without arm.
 *   7. Same workspace + `scope.whatsapp.mode = "off"` is still no-op.
 *
 * If this test ever fails, channel-scope is leaking into a no-opt-in
 * user's session, which is a regression of the most important guarantee
 * in the entire plan.
 *
 * Run: `npx tsx tests/scope-zero-diff.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryDB } from "../lib/memory-db.ts";
import {
  _resetRuntimeForTests,
  detectScopeRuntime,
} from "../lib/scope/runtime.ts";
import { makeForegroundContext } from "../lib/scope/context.ts";
import {
  assertCanReadPath,
  buildSqlPreFilter,
  filterScopedResults,
} from "../lib/scope/filter.ts";
import { mapAbsoluteToLogical } from "../lib/scope/provenance.ts";
import {
  _resetRegistryForTests,
  registerScopeAdapter,
  type ScopeAdapter,
} from "../lib/scope/index.ts";
import type { ScopeRuntimeState } from "../lib/scope/runtime.ts";

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
// Fixture: workspace with local memory + a fake claude-whatsapp extra path
// ---------------------------------------------------------------------------

interface Fixture {
  workspaceDir: string;
  extraDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-zerodiff-"));
  const workspace = path.join(root, "workspace");
  // The extra-path basename becomes the `extra:<basename>/…` prefix in
  // logical paths. Using `claude-whatsapp` so the path-pattern stage of
  // provenance derivation maps it to the `whatsapp` channel.
  const extra = path.join(root, "claude-whatsapp");
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.mkdirSync(extra, { recursive: true });
  // Local memory file with the keyword we'll search for.
  fs.writeFileSync(
    path.join(workspace, "memory", "MEMORY.md"),
    "# Memory\n\nThe quick brown fox jumps over the lazy dog.\n"
  );
  // Channel-derived file under extraPaths — same keyword to ensure the
  // FTS hit matches both.
  fs.writeFileSync(
    path.join(extra, "2026-04-26.md"),
    "# WhatsApp 2026-04-26\n\nA quick brown horse runs through the field.\n"
  );
  return {
    workspaceDir: workspace,
    extraDir: extra,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

check("zero-diff: detectScopeRuntime() returns no-armed for a no-scope config", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    memory: { backend: "builtin", citations: "auto" },
  });
  assert(r.anyArmed === false, "no-armed without scope block");
});

check("zero-diff: search returns local AND channel chunks (no scope opt-in)", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const db = new MemoryDB(f.workspaceDir, [f.extraDir]);
    db.markDirty();
    db.sync();

    const out = db.search("quick", { maxResults: 10 });
    const paths = out.map((r) => r.path).sort();
    // Local file present (workspace-relative form: `memory/MEMORY.md`).
    assert(
      paths.some((p) => p === "memory/MEMORY.md"),
      `expected memory/MEMORY.md in results, got ${JSON.stringify(paths)}`
    );
    // Channel file present.
    assert(
      paths.some((p) => p.startsWith("extra:claude-whatsapp/")),
      `expected extra:claude-whatsapp/* in results, got ${JSON.stringify(paths)}`
    );
    // Provenance metadata attached but doesn't gate.
    const channelHit = out.find((r) => r.path.startsWith("extra:"));
    assert(channelHit !== undefined, "channel hit found");
    assert(
      channelHit?.provenance?.class.kind === "channel",
      "channel provenance attached as passive metadata"
    );
    db.close();
  } finally {
    f.cleanup();
  }
});

check("zero-diff: filterScopedResults pass-through without arm", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    memory: { backend: "builtin", citations: "auto" },
  });
  const sample = [
    {
      path: "extra:claude-whatsapp/x.md",
      startLine: 1,
      endLine: 5,
      snippet: "test",
      score: 0.5,
      citation: "extra:claude-whatsapp/x.md#L1-5",
    },
  ];
  const ctx = makeForegroundContext("zerodiff-req");
  const { results: out, stats } = filterScopedResults(sample, ctx, r);
  assert(out === sample, "same array reference (no-op)");
  assert(stats.evaluated === false, "stats not evaluated");
});

check("zero-diff: assertCanReadPath allow-all without arm", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    memory: { backend: "builtin", citations: "auto" },
  });
  const ctx = makeForegroundContext("zerodiff-read");
  const out = assertCanReadPath("extra:claude-whatsapp/anything.md", ctx, r);
  assert(out.allowed === true, "always allowed without arm");
});

check("zero-diff: buildSqlPreFilter empty without arm", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    memory: { backend: "builtin", citations: "auto" },
  });
  const ctx = makeForegroundContext("zerodiff-sql");
  const pf = buildSqlPreFilter(ctx, r);
  assert(pf.whereSql === "", "no SQL fragment");
  assert(pf.params.length === 0, "no params");
});

check("zero-diff: scope.whatsapp.mode='off' is identical to absence of scope block", () => {
  _resetRuntimeForTests();
  const r = detectScopeRuntime({
    memory: { backend: "builtin", citations: "auto" },
    scope: { whatsapp: { mode: "off" } },
  });
  assert(r.anyArmed === false, "off behaves like absent");
  // Anyone who got `scope:{whatsapp:{mode:'off'}}` written by the
  // wizard mid-flow and then bailed must see the same behavior as a
  // user who never touched the wizard.
  const ctx = makeForegroundContext("zerodiff-off");
  const pf = buildSqlPreFilter(ctx, r);
  assert(pf.whereSql === "", "off mode emits no SQL");
});

check("zero-diff: MemoryDB.readFile returns extra: content without arm", () => {
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const db = new MemoryDB(f.workspaceDir, [f.extraDir]);
    db.markDirty();
    db.sync();

    // search to discover the relPath
    const out = db.search("horse", { maxResults: 5 });
    const channelHit = out.find((r) => r.path.startsWith("extra:"));
    assert(channelHit !== undefined, "channel hit located");

    // readFile must return the content unchanged — the readFile path
    // gate (server.ts) is no-op without arm. Returns either
    // `{ text, path }` on success or `{ error }` on failure.
    const out2 = db.readFile(channelHit.path);
    assert(!("error" in out2), `expected text, got error: ${JSON.stringify(out2)}`);
    if (!("error" in out2)) {
      assert(out2.text.includes("brown horse"), "content body intact");
    }
    db.close();
  } finally {
    f.cleanup();
  }
});

check("zero-diff: search before AND after touching scope/filter modules is identical", () => {
  // Belt-and-suspenders: importing the filter module (or running the
  // runtime detection) MUST NOT cause a side-effect that changes
  // search results for a no-opt-in user.
  const f = makeFixture();
  try {
    _resetRuntimeForTests();
    const db = new MemoryDB(f.workspaceDir, [f.extraDir]);
    db.markDirty();
    db.sync();
    const before = db.search("quick", { maxResults: 10 });

    // Now poke at every Phase 4a-1 surface:
    const ctx = makeForegroundContext("zerodiff-side-effect");
    const r = detectScopeRuntime({
      memory: { backend: "builtin", citations: "auto" },
    });
    filterScopedResults(before, ctx, r);
    assertCanReadPath("memory/MEMORY.md", ctx, r);
    buildSqlPreFilter(ctx, r);

    const after = db.search("quick", { maxResults: 10 });
    assert(
      after.length === before.length,
      `same length (${before.length} vs ${after.length})`
    );
    const beforePaths = before.map((x) => x.path).sort().join("|");
    const afterPaths = after.map((x) => x.path).sort().join("|");
    assert(
      beforePaths === afterPaths,
      `same paths\n  before: ${beforePaths}\n  after:  ${afterPaths}`
    );
    db.close();
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// voice_transcribe abs-path bypass — Codex Q2 (Phase 4a-2 adv. review)
// ---------------------------------------------------------------------------

check(
  "abs-path zero-diff: no opt-in → original audioPath always allowed",
  () => {
    // Without scope opt-in, the entire mapAbsoluteToLogical+gate block
    // in voice_transcribe is skipped (gated on runtime.anyArmed). Prove
    // that calling assertCanReadPath with an abs path under a fake
    // channel root is allowed because the wrapper doesn't fire.
    _resetRegistryForTests();
    _resetRuntimeForTests();
    const r = detectScopeRuntime({
      memory: { backend: "builtin", citations: "auto" },
    });
    assert(r.anyArmed === false, "no-armed for users without opt-in");
    const ctx = makeForegroundContext("zerodiff-abspath");
    // assertCanReadPath against an abs path classifies as legacy and
    // returns allowed under !anyArmed — same as today's behavior.
    const out = assertCanReadPath(
      "/some/abs/path/under/claude-whatsapp/voice/note.opus",
      ctx,
      r
    );
    assert(out.allowed === true, "abs path allowed without opt-in");
  }
);

check(
  "abs-path armed: realpath fails under channel root → mapping says deny",
  () => {
    // The zero-diff invariant is for users WITHOUT opt-in. When a user
    // DOES opt in, the mapAbsoluteToLogical helper must close the
    // bypass: a non-existent abs path under a known channel root must
    // return `kind: "deny"`, NOT pass through with allowed=true. This
    // is the actual security fix (Codex Q2).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-z2-"));
    try {
      _resetRegistryForTests();
      _resetRuntimeForTests();
      const wa = path.join(root, "claude-whatsapp");
      fs.mkdirSync(wa, { recursive: true });
      const ghost = path.join(wa, "voice", "missing.opus"); // does NOT exist
      const mapping = mapAbsoluteToLogical(ghost, [wa]);
      assert(
        mapping?.kind === "deny",
        `realpath-fail-under-channel must deny, got ${JSON.stringify(mapping)}`
      );
      if (mapping?.kind === "deny") {
        assert(mapping.channel === "whatsapp", "channel mapped");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------
// Refill invariant — Codex P1 #5 (Phase 4a-1 review)
// ---------------------------------------------------------------------------

check("refill: heavily-denied channel still returns maxResults from locals", () => {
  // Build a workspace where local memory has plenty of `quick` hits and
  // an extra path has equally many. With a deny-all WhatsApp adapter +
  // enforce mode, the over-fetched candidate pool from MemoryDB.search
  // must include enough locals so post-filter still yields maxResults.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-refill-"));
  try {
    const workspace = path.join(root, "workspace");
    const extra = path.join(root, "claude-whatsapp");
    fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
    fs.mkdirSync(extra, { recursive: true });
    // 12 local files, 12 channel files. All match `quick`.
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(workspace, "memory", `local-${i}.md`),
        `# Local ${i}\n\nThe quick zebra dances on the rooftop ${i}.\n`
      );
      fs.writeFileSync(
        path.join(extra, `chat-${i}.md`),
        `# WA ${i}\n\nSome quick fox business ${i}.\n`
      );
    }

    _resetRegistryForTests();
    _resetRuntimeForTests();

    // Hand-roll an enforce-armed runtime with a deny-all adapter.
    const denyAll: ScopeAdapter = {
      channel: "whatsapp",
      requiresPerChunkCheck: false,
      canSee: () => false,
      allowedChatIds: () => [],
    };
    registerScopeAdapter(denyAll);
    const armedRuntime: ScopeRuntimeState = {
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

    const db = new MemoryDB(workspace, [extra]);
    db.markDirty();
    db.sync();

    // Ask for 6 results with overfetch=8 (what server.ts:204 sets when
    // armed). MemoryDB.search emits the SQL pre-filter `source_channel
    // != 'whatsapp'` so channel chunks never make it into the candidate
    // pool — but the over-fetch keeps enough locals to satisfy the cap.
    const ctx = makeForegroundContext("refill-test");
    const pre = buildSqlPreFilter(ctx, armedRuntime);
    assert(pre.whereSql.length > 0, "deny-all emits SQL filter");

    const candidates = db.search("quick", {
      maxResults: 6,
      sqlPreFilter: pre,
      candidateOverfetch: 8,
    });

    // Post-filter (already a no-op for the channel rows because they
    // were excluded by the SQL pre-filter, but kept for symmetry with
    // the server.ts pipeline).
    const { results: filtered, stats } = filterScopedResults(
      candidates,
      ctx,
      armedRuntime
    );

    // Server-side trim happens after the filter. Verify the pool that
    // arrives at this point has at least `maxResults` locals so the
    // trim doesn't return short.
    assert(
      filtered.length >= 6,
      `expected refill ≥ 6, got ${filtered.length}`
    );
    // Every survivor is local — no channel chunk leaked through SQL or
    // post-filter.
    for (const r of filtered) {
      assert(
        !r.path.startsWith("extra:"),
        `channel chunk leaked: ${r.path}`
      );
    }
    assert(stats.dropped === 0, "no post-filter drops because SQL pre-filtered");

    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-zero-diff tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
