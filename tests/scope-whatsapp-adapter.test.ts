/**
 * Tier 1 + tier 2 tests for the WhatsApp scope adapter (Phase 3).
 *
 * Covers:
 *  - normalizeAccess tolerates missing / null / unknown fields (forward-compat)
 *  - loadAccess caches by mtime+size+ino; rebuilds when sig changes
 *  - loadAccess returns last-known-good on parse failure
 *  - loadAccess returns null when file is missing AND no LKG
 *  - createWhatsappAdapter returns null when access.json unresolvable
 *  - canSee + allowedChatIds mirror upstream resolveScope rules:
 *     - bootstrap (ownerJids = []) → null (no restriction)
 *     - foreground + WHATSAPP_OWNER_BYPASS → null
 *     - background system-owner → null
 *     - background deny → []
 *     - foreground without bypass + ownerJids set → [] (owner-only ceiling)
 *  - canSee passes through non-channel chunks
 *
 * Run: `npx tsx tests/scope-whatsapp-adapter.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWhatsappAdapter,
  loadAccess,
  normalizeAccess,
} from "../lib/scope/whatsapp.ts";
import { deriveProvenance } from "../lib/scope/provenance.ts";
import { makeBackgroundContext, makeForegroundContext } from "../lib/scope/context.ts";

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
  accessPath: string;
  cleanup: () => void;
}

function makeFixture(initialContent?: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-wa-"));
  const accessPath = path.join(root, "access.json");
  if (initialContent !== undefined) fs.writeFileSync(accessPath, initialContent);
  return {
    workspace: root,
    accessPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// normalizeAccess
// ---------------------------------------------------------------------------

check("normalizeAccess returns defaults for null/garbage", () => {
  const a = normalizeAccess(null);
  assert(a.ownerJids.length === 0, "ownerJids = []");
  assert(a.allowFrom.length === 0, "allowFrom = []");
  assert(Object.keys(a.groups).length === 0, "groups = {}");
  assert(Object.keys(a.dms).length === 0, "dms = {}");

  const b = normalizeAccess(42);
  assert(b.ownerJids.length === 0, "scalar -> defaults");
});

check("normalizeAccess tolerates non-array ownerJids/allowFrom", () => {
  const a = normalizeAccess({ ownerJids: null, allowFrom: "oops" });
  assert(a.ownerJids.length === 0, "null -> []");
  assert(a.allowFrom.length === 0, "string -> []");
});

check("normalizeAccess preserves valid groups/dms historyScope", () => {
  const a = normalizeAccess({
    ownerJids: ["123@s.whatsapp.net"],
    allowFrom: ["123@s.whatsapp.net", "456@s.whatsapp.net"],
    groups: {
      "g1@g.us": { historyScope: "own" },
      "g2@g.us": { historyScope: ["g3@g.us"] },
      "g3@g.us": { historyScope: "all" },
    },
    dms: {
      "456@s.whatsapp.net": { historyScope: "own" },
    },
    unknownField: "should be ignored",
  });
  assert(a.ownerJids.length === 1, "owner kept");
  assert(a.groups["g1@g.us"].historyScope === "own", "g1 own");
  assert(
    Array.isArray(a.groups["g2@g.us"].historyScope) &&
      (a.groups["g2@g.us"].historyScope as string[])[0] === "g3@g.us",
    "g2 CSV"
  );
  assert(a.groups["g3@g.us"].historyScope === "all", "g3 all");
});

check("normalizeAccess drops invalid historyScope values", () => {
  const a = normalizeAccess({
    groups: { "g@g.us": { historyScope: "bogus" } },
    dms: { "d@s.whatsapp.net": { historyScope: 42 } },
  });
  assert(
    a.groups["g@g.us"].historyScope === undefined,
    "invalid string dropped"
  );
  assert(
    a.dms["d@s.whatsapp.net"].historyScope === undefined,
    "non-string-array dropped"
  );
});

// ---------------------------------------------------------------------------
// loadAccess (cache + LKG)
// ---------------------------------------------------------------------------

check("loadAccess returns null when file missing and no LKG", () => {
  const f = makeFixture();
  try {
    const cache = new Map();
    const r = loadAccess(f.accessPath, cache);
    assert(r.access === null, "no access");
    assert(r.resolvable === false, "not resolvable");
  } finally {
    f.cleanup();
  }
});

check("loadAccess parses + caches a valid file", () => {
  const f = makeFixture(
    JSON.stringify({ ownerJids: ["o@s.whatsapp.net"], allowFrom: [] })
  );
  try {
    const cache = new Map();
    const r1 = loadAccess(f.accessPath, cache);
    assert(r1.resolvable === true, "resolvable");
    assert(r1.access?.ownerJids[0] === "o@s.whatsapp.net", "owner parsed");
    assert(cache.size === 1, "cache populated");
    // Repeat hit — should not re-read.
    const r2 = loadAccess(f.accessPath, cache);
    assert(r2.access === r1.access, "same object reference (cache hit)");
  } finally {
    f.cleanup();
  }
});

check("loadAccess invalidates when mtime+size changes", () => {
  const f = makeFixture(JSON.stringify({ ownerJids: ["a@s.whatsapp.net"] }));
  try {
    const cache = new Map();
    const r1 = loadAccess(f.accessPath, cache);
    assert(r1.access?.ownerJids[0] === "a@s.whatsapp.net", "first owner");

    // Write a new value with different content (different size).
    fs.writeFileSync(
      f.accessPath,
      JSON.stringify({ ownerJids: ["b@s.whatsapp.net", "c@s.whatsapp.net"] })
    );
    const r2 = loadAccess(f.accessPath, cache);
    assert(r2.access?.ownerJids.length === 2, "reloaded after size change");
    assert(r2.access?.ownerJids[0] === "b@s.whatsapp.net", "new owner");
  } finally {
    f.cleanup();
  }
});

check("loadAccess returns last-known-good on parse failure", () => {
  const f = makeFixture(JSON.stringify({ ownerJids: ["good@s.whatsapp.net"] }));
  try {
    const cache = new Map();
    const r1 = loadAccess(f.accessPath, cache);
    assert(r1.access?.ownerJids[0] === "good@s.whatsapp.net", "initial good");

    // Corrupt the file — same path, parse should fail.
    fs.writeFileSync(f.accessPath, "{ this is not valid json");
    const r2 = loadAccess(f.accessPath, cache);
    assert(r2.access?.ownerJids[0] === "good@s.whatsapp.net", "still good (LKG)");
    assert(r2.lastKnownGood === true, "lastKnownGood flag set");
  } finally {
    f.cleanup();
  }
});

check("Codex P1: LKG bounds when access.json disappears", () => {
  // After a successful load, deleting the file should serve LKG for
  // up to MISSING_GRACE_MS (5 min). Past that, the loader returns
  // unresolvable so the runtime can disarm.
  const f = makeFixture(JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] }));
  try {
    const cache = new Map();
    const r1 = loadAccess(f.accessPath, cache);
    assert(r1.resolvable === true && r1.access !== null, "initial good");

    // Delete the file.
    fs.unlinkSync(f.accessPath);

    // Within the grace window: LKG returned.
    const r2 = loadAccess(f.accessPath, cache);
    assert(
      r2.resolvable === true && r2.lastKnownGood === true,
      "first miss returns LKG"
    );

    // Forge an aged missingSince to simulate "5+ minutes have passed"
    // without sleeping in the test.
    const entry = cache.get(f.accessPath);
    assert(entry !== undefined, "cache populated");
    entry.missingSince = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    cache.set(f.accessPath, entry);

    const r3 = loadAccess(f.accessPath, cache);
    assert(
      r3.resolvable === false,
      `expected unresolvable past grace, got resolvable=${r3.resolvable}`
    );
  } finally {
    f.cleanup();
  }
});

check("Codex P1: missingSince clears when file reappears", () => {
  const f = makeFixture(JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] }));
  try {
    const cache = new Map();
    loadAccess(f.accessPath, cache);
    fs.unlinkSync(f.accessPath);
    loadAccess(f.accessPath, cache); // sets missingSince
    const e1 = cache.get(f.accessPath);
    assert(e1?.missingSince !== undefined, "missingSince set after delete");

    // File reappears with a different content (different size).
    fs.writeFileSync(
      f.accessPath,
      JSON.stringify({ ownerJids: ["new@s.whatsapp.net"] })
    );
    const r = loadAccess(f.accessPath, cache);
    assert(r.access?.ownerJids[0] === "new@s.whatsapp.net", "reloaded new");
    const e2 = cache.get(f.accessPath);
    assert(e2?.missingSince === undefined, "missingSince cleared on reload");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// createWhatsappAdapter — armed-state behavior
// ---------------------------------------------------------------------------

check("createWhatsappAdapter returns null when file missing", () => {
  const f = makeFixture();
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath });
    assert(adapter === null, "no adapter");
  } finally {
    f.cleanup();
  }
});

check("adapter returns no restriction in bootstrap mode (auto-discovered path)", () => {
  // Codex 3rd-pass CRITICAL 2: bootstrap fail-open is gated by
  // `isAutoDiscovered = true`. The auto-discovery path means the
  // runtime walked `~/.claude/channels/whatsapp` or detected the
  // project-local install — i.e. governance came from an upstream
  // layout the user controls, not a path the agent could forge via
  // `accessJsonPath`. With `isAutoDiscovered: true`, bootstrap
  // (`ownerJids === []`) still fails open. The
  // user-configured-path-without-trust case is covered separately in
  // `scope-v4-codex-3rd-pass.test.ts`.
  const f = makeFixture(
    JSON.stringify({ ownerJids: [], allowFrom: [], groups: {}, dms: {} })
  );
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      isAutoDiscovered: true,
    })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const allowed = adapter.allowedChatIds(ctx);
    assert(allowed === null, `bootstrap -> null, got ${JSON.stringify(allowed)}`);
  } finally {
    f.cleanup();
  }
});

check("adapter returns no restriction with WHATSAPP_OWNER_BYPASS=1", () => {
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeForegroundContext("req-1", {
      env: { WHATSAPP_OWNER_BYPASS: "1" },
    });
    assert(adapter.allowedChatIds(ctx) === null, "bypass -> null");
  } finally {
    f.cleanup();
  }
});

check("adapter denies foreground without bypass when owner is set", () => {
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
    })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `expected [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

check("adapter background system-owner WITHOUT trust file → []", () => {
  // Codex 2nd-pass CRITICAL: system-owner unlock requires the
  // out-of-band trust file. Without it, agent_config alone could
  // escalate (prompt-injection surface).
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
    })
  );
  try {
    // No trust file written — default state.
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeBackgroundContext("pass-1", "system-owner");
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `system-owner without trust → [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

check("adapter background deny = []", () => {
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
    })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeBackgroundContext("pass-1", "deny");
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `deny -> [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

check("Codex 2nd-pass HIGH 3: explicit background deny WINS over bootstrap", () => {
  // Codex 2nd-pass HIGH 3 reversed the Phase 3 P1 decision: when a
  // user explicitly sets background.identity = "deny", that posture
  // should win over a fail-open bootstrap. Phase 3 P1 had it the
  // other way (bootstrap-beats-deny so a pre-pairing user wouldn't
  // be locked out). The new ordering is more conservative: explicit
  // deny is explicit. Pre-pairing users who want bootstrap dreams
  // can override by setting `background.identity = "system-owner"`
  // (which itself requires the trust file — defense in depth).
  const f = makeFixture(JSON.stringify({ ownerJids: [], allowFrom: [] }));
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeBackgroundContext("pass-1", "deny");
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `explicit deny beats bootstrap → [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// canSee — non-channel chunks pass through
// ---------------------------------------------------------------------------

check("canSee passes through non-whatsapp provenance", () => {
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
    })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const localProv = deriveProvenance("memory/MEMORY.md");
    assert(adapter.canSee(localProv, ctx) === true, "local always visible");
  } finally {
    f.cleanup();
  }
});

check("canSee denies whatsapp channel chunk under owner-only ceiling", () => {
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
    })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const waProv = deriveProvenance("extra:claude-whatsapp/x.md");
    assert(adapter.canSee(waProv, ctx) === false, "WA chunk denied");
  } finally {
    f.cleanup();
  }
});

check("canSee allows whatsapp channel chunk with owner bypass", () => {
  const f = makeFixture(
    JSON.stringify({
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
    })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeForegroundContext("req-1", {
      env: { WHATSAPP_OWNER_BYPASS: "1" },
    });
    const waProv = deriveProvenance("extra:claude-whatsapp/x.md");
    assert(adapter.canSee(waProv, ctx) === true, "WA chunk allowed under bypass");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// requiresPerChunkCheck
// ---------------------------------------------------------------------------

check("adapter declares requiresPerChunkCheck=false in Phase 3", () => {
  const f = makeFixture(
    JSON.stringify({ ownerJids: ["o@s.whatsapp.net"] })
  );
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    assert(
      adapter.requiresPerChunkCheck === false,
      "false until per-chat scope lands"
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-whatsapp-adapter tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
