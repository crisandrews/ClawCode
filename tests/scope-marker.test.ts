/**
 * Tier 1 + tier 2 tests for the WhatsApp inbound-marker consumer
 * (Phase 4a-2.5).
 *
 * Tier 1 (loadInboundContext):
 *  - missing / corrupt / partial / wrong-version / missing-fields /
 *    non-finite-ts / expired-by-TTL  → all return null
 *  - valid fresh marker → parsed payload
 *  - cache hit on same signature + fresh ts
 *  - mtime/size/ino change forces re-read
 *  - signature stable but ts aged past TTL → null (no cache drop)
 *  - marker disappears mid-session → cache cleared, returns null
 *
 * Tier 2 (createWhatsappAdapter end-to-end with marker):
 *  - owner senderId in marker → null (full access)
 *  - non-owner DM historyScope='all' → null
 *  - non-owner DM historyScope='own' (default) → [chatId]
 *  - DM historyScope CSV → universe-filtered allowed list
 *  - group member, default 'own' → [chatId]
 *  - group historyScope='all' → null
 *  - group CSV intersected with universe drops unauthorized members
 *  - marker missing → ceiling fallback (deny without bypass)
 *  - marker expired → ceiling fallback
 *  - marker corrupt → ceiling fallback
 *  - WHATSAPP_OWNER_BYPASS=1 wins over marker (env first)
 *  - Bootstrap (ownerJids=[]) wins over marker
 *  - Background context ignores marker (foreground-only signal)
 *  - canSee + sourceChatId=null + non-empty allowed → false (Phase 4a-2.5 chat_id gap)
 *  - canSee + sourceChatId IN allowed → true
 *  - canSee + sourceChatId NOT IN allowed → false
 *
 * Run: `npx tsx tests/scope-marker.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  createWhatsappAdapter,
  loadAccess,
  loadInboundContext,
  MARKER_FILENAME,
  MARKER_TTL_MS,
  MARKER_VERSION,
} from "../lib/scope/whatsapp.ts";
import {
  makeBackgroundContext,
  makeForegroundContext,
} from "../lib/scope/context.ts";
import type { ChunkProvenance } from "../lib/scope/provenance.ts";
import { writeTrustMarker } from "../lib/scope/trust.ts";

/**
 * Each test that needs the trust file scopes it under the test's own
 * tmp dir via the `CLAW_SCOPE_TRUST_DIR` env override. The helper
 * sets the env, calls writeTrustMarker, and returns a cleanup that
 * restores prior env state — so tests don't leak trust files across
 * each other or into the user's real ~/.claude directory.
 */
function withTrustForTest(scope: string, fn: () => void): void {
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-"));
  process.env.CLAW_SCOPE_TRUST_DIR = tmp;
  try {
    writeTrustMarker("whatsapp");
    fn();
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function withoutTrustForTest(fn: () => void): void {
  const prior = process.env.CLAW_SCOPE_TRUST_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-trust-"));
  process.env.CLAW_SCOPE_TRUST_DIR = tmp; // empty dir → no trust file
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

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
  channelDir: string;
  accessPath: string;
  markerPath: string;
  cleanup: () => void;
}

function makeFixture(opts?: {
  access?: object;
  marker?: object | string;
  /** When provided, write the marker with these mode bits. Default 0o600. */
  markerMode?: number;
}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-marker-"));
  const accessPath = path.join(root, "access.json");
  const markerPath = path.join(root, MARKER_FILENAME);
  if (opts?.access !== undefined) {
    fs.writeFileSync(accessPath, JSON.stringify(opts.access));
  }
  if (opts?.marker !== undefined) {
    const raw =
      typeof opts.marker === "string" ? opts.marker : JSON.stringify(opts.marker);
    fs.writeFileSync(markerPath, raw, { mode: opts.markerMode ?? 0o600 });
    // Ensure the mode actually landed (umask can mask bits).
    if (process.platform !== "win32") {
      fs.chmodSync(markerPath, opts.markerMode ?? 0o600);
    }
  }
  return {
    channelDir: root,
    accessPath,
    markerPath,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function freshMarker(chatId: string, senderId: string, now = Date.now()) {
  return { version: MARKER_VERSION, chatId, senderId, ts: now };
}

function channelChunk(sourceChatId: string | null = null): ChunkProvenance {
  return {
    class: { kind: "channel", sourceChannel: "whatsapp", sourceChatId },
    sourceChannel: "whatsapp",
    sourceChatId,
  };
}

// ---------------------------------------------------------------------------
// loadInboundContext — tier 1
// ---------------------------------------------------------------------------

check("loadInboundContext: missing marker → null", () => {
  const f = makeFixture();
  try {
    const cache = new Map();
    assert(loadInboundContext(f.channelDir, cache) === null, "missing → null");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: valid fresh marker → parsed payload", () => {
  const now = Date.now();
  const f = makeFixture({
    marker: freshMarker("chatA@s.whatsapp.net", "senderA@s.whatsapp.net", now),
  });
  try {
    const cache = new Map();
    const ctx = loadInboundContext(f.channelDir, cache, now);
    assert(ctx !== null, "ctx not null");
    assert(ctx?.chatId === "chatA@s.whatsapp.net", "chatId");
    assert(ctx?.senderId === "senderA@s.whatsapp.net", "senderId");
    assert(ctx?.ts === now, "ts");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: wrong version → null", () => {
  const now = Date.now();
  const f = makeFixture({
    marker: { version: 999, chatId: "c", senderId: "s", ts: now },
  });
  try {
    const cache = new Map();
    assert(
      loadInboundContext(f.channelDir, cache, now) === null,
      "version mismatch"
    );
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: corrupt JSON → null", () => {
  const f = makeFixture({ marker: "{ not valid json" });
  try {
    const cache = new Map();
    assert(loadInboundContext(f.channelDir, cache) === null, "corrupt → null");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: missing chatId → null", () => {
  const now = Date.now();
  const f = makeFixture({
    marker: { version: 1, senderId: "s", ts: now },
  });
  try {
    const cache = new Map();
    assert(
      loadInboundContext(f.channelDir, cache, now) === null,
      "missing chatId"
    );
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: empty chatId → null", () => {
  const now = Date.now();
  const f = makeFixture({
    marker: { version: 1, chatId: "", senderId: "s", ts: now },
  });
  try {
    const cache = new Map();
    assert(
      loadInboundContext(f.channelDir, cache, now) === null,
      "empty chatId"
    );
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: non-finite ts → null", () => {
  const now = Date.now();
  // JSON.stringify converts Infinity to null — write raw so we can test
  // non-finite handling explicitly.
  const f = makeFixture({
    marker:
      '{"version":1,"chatId":"c","senderId":"s","ts":"not-a-number"}',
  });
  try {
    const cache = new Map();
    assert(
      loadInboundContext(f.channelDir, cache, now) === null,
      "non-finite ts"
    );
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: expired by TTL → null", () => {
  const now = Date.now();
  const f = makeFixture({
    marker: freshMarker("c", "s", now - MARKER_TTL_MS - 1),
  });
  try {
    const cache = new Map();
    assert(loadInboundContext(f.channelDir, cache, now) === null, "expired");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: cache hit on fresh marker", () => {
  const now = Date.now();
  const f = makeFixture({ marker: freshMarker("c", "s", now) });
  try {
    const cache = new Map();
    const a = loadInboundContext(f.channelDir, cache, now);
    const b = loadInboundContext(f.channelDir, cache, now);
    assert(a !== null && b !== null, "both non-null");
    assert(a === b, "second call returns same object reference (cache hit)");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: mtime change forces re-read", () => {
  const now = Date.now();
  const f = makeFixture({ marker: freshMarker("first", "s1", now) });
  try {
    const cache = new Map();
    const a = loadInboundContext(f.channelDir, cache, now);
    assert(a?.chatId === "first", "first read");

    // Rewrite with different chatId — different size to ensure
    // signature change. Re-apply 0o600 because hardening rejects
    // anything wider.
    fs.writeFileSync(
      f.markerPath,
      JSON.stringify(freshMarker("second-chat-id-longer", "s2", now)),
      { mode: 0o600 }
    );
    if (process.platform !== "win32") fs.chmodSync(f.markerPath, 0o600);
    const b = loadInboundContext(f.channelDir, cache, now);
    assert(b?.chatId === "second-chat-id-longer", "re-read on signature change");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: same signature but ts aged → null", () => {
  // Cache hit path: signature matches but the in-payload ts has aged
  // past TTL (e.g. on a slow turn). Must return null without dropping
  // the cache entry — a future marker rewrite still hits the
  // signature-change branch.
  const t0 = Date.now();
  const f = makeFixture({ marker: freshMarker("c", "s", t0) });
  try {
    const cache = new Map();
    const fresh = loadInboundContext(f.channelDir, cache, t0);
    assert(fresh !== null, "fresh ok");

    const stale = loadInboundContext(
      f.channelDir,
      cache,
      t0 + MARKER_TTL_MS + 1
    );
    assert(stale === null, "ts aged past TTL → null");
    // Cache entry is still there with the original signature.
    assert(cache.size === 1, "cache entry preserved");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: marker disappears → cache cleared", () => {
  const now = Date.now();
  const f = makeFixture({ marker: freshMarker("c", "s", now) });
  try {
    const cache = new Map();
    loadInboundContext(f.channelDir, cache, now);
    assert(cache.size === 1, "cache populated");

    fs.unlinkSync(f.markerPath);
    const r = loadInboundContext(f.channelDir, cache, now);
    assert(r === null, "missing → null");
    assert(cache.size === 0, "cache cleared on miss");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Hardening (Codex post-impl HIGH 2)
// ---------------------------------------------------------------------------

check("loadInboundContext: rejects group/world readable mode (0o644)", () => {
  if (process.platform === "win32") {
    // Windows mode bits don't carry POSIX semantics; the loader skips
    // the mode check there.
    return;
  }
  const now = Date.now();
  const f = makeFixture({
    marker: freshMarker("c", "s", now),
    markerMode: 0o644,
  });
  try {
    const cache = new Map();
    assert(
      loadInboundContext(f.channelDir, cache, now) === null,
      "0o644 marker rejected"
    );
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: rejects future-dated ts beyond clock skew", () => {
  const now = Date.now();
  // 30 seconds in the future — well past CLOCK_SKEW_MS=5s.
  const f = makeFixture({ marker: freshMarker("c", "s", now + 30_000) });
  try {
    const cache = new Map();
    assert(
      loadInboundContext(f.channelDir, cache, now) === null,
      "future-dated ts rejected"
    );
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: tolerates small clock skew (within bound)", () => {
  const now = Date.now();
  // 2 seconds in the future — within CLOCK_SKEW_MS=5s.
  const f = makeFixture({ marker: freshMarker("c", "s", now + 2_000) });
  try {
    const cache = new Map();
    const ctx = loadInboundContext(f.channelDir, cache, now);
    assert(ctx !== null, "small clock skew tolerated");
  } finally {
    f.cleanup();
  }
});

check("loadInboundContext: FIFO at marker path → null (Codex 2nd-pass HIGH 2)", () => {
  // Codex 2nd-pass HIGH 2: a FIFO planted at the marker path used to
  // hang `openSync` because O_RDONLY without O_NONBLOCK blocks until
  // a writer opens the FIFO. The fix adds O_NONBLOCK and a pre-open
  // lstat fast-reject. Verify the loader returns null without
  // hanging.
  if (process.platform === "win32") return; // mkfifo not available
  const f = makeFixture();
  try {
    // No regular marker — replace with FIFO.
    const fifoPath = path.join(f.channelDir, MARKER_FILENAME);
    // mkfifo via shell — Node has no stdlib helper.
    execSync(`mkfifo "${fifoPath}"`);
    const cache = new Map();
    // Should return null fast — no hang. If the test hangs here,
    // the O_NONBLOCK + pre-open lstat fix regressed.
    const result = loadInboundContext(f.channelDir, cache);
    assert(result === null, `FIFO must reject, got ${JSON.stringify(result)}`);
  } finally {
    f.cleanup();
  }
});

check("loadAccess: malformed shape (missing ownerJids) marks hasOwnerJidsField=false", () => {
  // Codex 2nd-pass HIGH 3: a JSON file that parses but lacks
  // `ownerJids` was previously normalized to the same `[]` as a
  // legitimate bootstrap-mode access.json. The new
  // `hasOwnerJidsField` surface lets `resolveAllowed` distinguish
  // the two and fail closed on malformed governance.
  const f = makeFixture({ access: { foo: "bar" } });
  try {
    const cache = new Map();
    const r = loadAccess(f.accessPath, cache);
    assert(r.resolvable === true, "shape parsed");
    assert(
      r.hasOwnerJidsField === false,
      `malformed → hasOwnerJidsField=false, got ${r.hasOwnerJidsField}`
    );
  } finally {
    f.cleanup();
  }
});

check("adapter: malformed access (no ownerJids) → [] (Codex 2nd-pass HIGH 3)", () => {
  // End-to-end: malformed access.json that LOOKS like bootstrap
  // (parses, no ownerJids field) must NOT trigger fail-open
  // bootstrap unlock.
  const f = makeFixture({ access: { foo: "bar" } });
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath });
    // adapter MAY still build (loadAccess returns resolvable=true
    // because shape is at least an object). The key is what
    // allowedChatIds returns.
    if (adapter !== null) {
      const ctx = makeForegroundContext("req-1", { env: {} });
      const allowed = adapter.allowedChatIds(ctx);
      assert(
        Array.isArray(allowed) && allowed.length === 0,
        `malformed access → [], got ${JSON.stringify(allowed)}`
      );
    }
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adapter tier 2 — identity-driven scope resolution (Phase 4a-2.5
// post-Codex-review). Marker is no longer consulted for unlock; owner
// proof comes from `config.scope.whatsapp.identity = "owner"` or env
// bypass / bootstrap / background system-owner.
// ---------------------------------------------------------------------------

check("adapter: identity='owner' WITH trust file → null (full unlock)", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    withTrustForTest("identity-owner-trusted", () => {
      const adapter = createWhatsappAdapter({
        accessPath: f.accessPath,
        configuredIdentity: "owner",
      })!;
      const ctx = makeForegroundContext("req-1", { env: {} });
      assert(adapter.allowedChatIds(ctx) === null, "owner+trust → null");
    });
  } finally {
    f.cleanup();
  }
});

check("adapter: identity='owner' WITHOUT trust file → [] (Codex 2nd-pass CRITICAL)", () => {
  // Without the out-of-band trust file, identity='owner' alone must
  // NOT unlock — otherwise an agent_config write from a prompt-
  // injected agent would escalate.
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: f.accessPath,
        configuredIdentity: "owner",
      })!;
      const ctx = makeForegroundContext("req-1", { env: {} });
      const allowed = adapter.allowedChatIds(ctx);
      assert(
        Array.isArray(allowed) && allowed.length === 0,
        `owner-without-trust → [], got ${JSON.stringify(allowed)}`
      );
    });
  } finally {
    f.cleanup();
  }
});

check("adapter: configuredIdentity='guest' → [] (explicit deny)", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "guest",
    })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `guest → [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

check("adapter: configuredIdentity='auto' → ceiling deny", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "auto",
    })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      "auto without bypass → ceiling deny"
    );
  } finally {
    f.cleanup();
  }
});

check("adapter: marker NOT consulted for unlock (Codex HIGH 1 fix)", () => {
  // Owner senderId is in the marker but identity defaults to 'auto'
  // and no bypass. With Codex post-impl fix, marker is passive infra —
  // unlock requires identity='owner' or env bypass.
  const now = Date.now();
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
    marker: freshMarker("c", "owner@s.whatsapp.net", now),
  });
  try {
    const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const allowed = adapter.allowedChatIds(ctx);
    // Pre-Codex: this returned null (owner unlock from marker).
    // Post-Codex: returns [] because marker freshness != request identity.
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `marker is passive — got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

check("adapter: WHATSAPP_OWNER_BYPASS=1 still wins over identity='guest'", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "guest",
    })!;
    const ctx = makeForegroundContext("req-1", {
      env: { WHATSAPP_OWNER_BYPASS: "1" },
    });
    assert(adapter.allowedChatIds(ctx) === null, "env bypass first");
  } finally {
    f.cleanup();
  }
});

check("adapter: identity='guest' WINS over bootstrap (Codex 2nd-pass HIGH 3)", () => {
  // Codex 2nd-pass HIGH 3 reversed the Phase 3 P1 ordering for
  // foreground guest: explicit guest is the user's intent and
  // should win over a fail-open bootstrap state.
  const f = makeFixture({
    access: { ownerJids: [], allowFrom: [], groups: {}, dms: {} },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "guest",
    })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const allowed = adapter.allowedChatIds(ctx);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `guest beats bootstrap → [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

check("adapter: background system-owner WITH trust file → null", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    withTrustForTest("bg-system-owner-trusted", () => {
      const adapter = createWhatsappAdapter({
        accessPath: f.accessPath,
        configuredIdentity: "guest", // foreground guest — irrelevant for bg
      })!;
      const bg = makeBackgroundContext("pass-1", "system-owner");
      assert(adapter.allowedChatIds(bg) === null, "bg system-owner+trust → null");
    });
  } finally {
    f.cleanup();
  }
});

check("adapter: background system-owner WITHOUT trust → [] (Codex 2nd-pass CRITICAL)", () => {
  // Same Codex CRITICAL fix applies to background system-owner:
  // out-of-band trust file required so a prompt-injected agent
  // can't set background.identity = 'system-owner' via
  // agent_config and escalate.
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({ accessPath: f.accessPath })!;
      const bg = makeBackgroundContext("pass-1", "system-owner");
      const allowed = adapter.allowedChatIds(bg);
      assert(
        Array.isArray(allowed) && allowed.length === 0,
        `system-owner without trust → [], got ${JSON.stringify(allowed)}`
      );
    });
  } finally {
    f.cleanup();
  }
});

check("adapter: background deny ignores foreground identity='owner'", () => {
  // Foreground identity='owner' must NOT leak into the background lane.
  // Backgrounds (dreams/indexers) use their own identity gate.
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "owner",
    })!;
    const bg = makeBackgroundContext("pass-1", "deny");
    const allowed = adapter.allowedChatIds(bg);
    assert(
      Array.isArray(allowed) && allowed.length === 0,
      `bg deny → [], got ${JSON.stringify(allowed)}`
    );
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// canSee — chat_id semantics under armed adapter. The "non-empty
// allowed" branch is reachable today via configuredIdentity='guest';
// once Phase 4a-2.5b lands the per-spawn marker binding, the same
// branch will fire for non-owner DM/group senders. The chunk-id
// semantics tested here are forward-compatible with that.
// ---------------------------------------------------------------------------

check("canSee: identity='owner'+trust → true for any whatsapp chunk", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    withTrustForTest("canSee-owner", () => {
      const adapter = createWhatsappAdapter({
        accessPath: f.accessPath,
        configuredIdentity: "owner",
      })!;
      const ctx = makeForegroundContext("req-1", { env: {} });
      // Owner unlock: canSee returns true regardless of sourceChatId,
      // including the Phase 4a-2.5 null-chat_id chunks.
      assert(
        adapter.canSee(channelChunk(null), ctx) === true,
        "null chat_id ok"
      );
      assert(
        adapter.canSee(channelChunk("any@s.whatsapp.net"), ctx) === true,
        "any chat_id ok"
      );
    });
  } finally {
    f.cleanup();
  }
});

check("canSee: configuredIdentity='guest' → false for any whatsapp chunk", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "guest",
    })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    assert(
      adapter.canSee(channelChunk(null), ctx) === false,
      "guest denies null chat_id"
    );
    assert(
      adapter.canSee(channelChunk("a@s.whatsapp.net"), ctx) === false,
      "guest denies any chat_id"
    );
  } finally {
    f.cleanup();
  }
});

check("canSee: passes through non-channel chunks regardless of identity", () => {
  const f = makeFixture({
    access: {
      ownerJids: ["owner@s.whatsapp.net"],
      allowFrom: ["owner@s.whatsapp.net"],
      groups: {},
      dms: {},
    },
  });
  try {
    const adapter = createWhatsappAdapter({
      accessPath: f.accessPath,
      configuredIdentity: "guest",
    })!;
    const ctx = makeForegroundContext("req-1", { env: {} });
    const localProv = {
      class: { kind: "local" } as const,
      sourceChannel: null,
      sourceChatId: null,
    };
    assert(
      adapter.canSee(localProv, ctx) === true,
      "non-channel chunk passes"
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

console.log(`\nscope-marker tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
