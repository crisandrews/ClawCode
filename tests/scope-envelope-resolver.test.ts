/**
 * Tier 1 + tier 2 tests for the OpenCLAUDE WhatsApp adapter resolver
 * extended with envelope-bound scope (Phase 6).
 *
 * Mirrors every case in `claude-whatsapp/scope.test.ts` byte-exact via
 * the OpenCLAUDE adapter's `allowedChatIds(context)` path with envelope
 * payload on the foreground context.
 *
 * Run: `npx tsx tests/scope-envelope-resolver.test.ts`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWhatsappAdapter,
} from "../lib/scope/whatsapp.ts";
import {
  makeBackgroundContext,
  makeForegroundContext,
} from "../lib/scope/context.ts";
import { writeTrustMarker } from "../lib/scope/trust.ts";

const OWNER = "56912345678@s.whatsapp.net";
const OWNER_LID = "12345678901234@lid";
const USER_B = "56987654321@s.whatsapp.net";
const GROUP_A = "120363000000000001@g.us";
const GROUP_B = "120363000000000002@g.us";

interface AccessShape {
  ownerJids?: string[];
  allowFrom?: string[];
  groups?: Record<string, { historyScope?: unknown }>;
  dms?: Record<string, { historyScope?: unknown }>;
}

function mkChannelDir(access: AccessShape): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-env-resolver-"));
  const full = {
    ownerJids: access.ownerJids ?? [],
    allowFrom: access.allowFrom ?? [],
    groups: access.groups ?? {},
    dms: access.dms ?? {},
  };
  fs.writeFileSync(path.join(dir, "access.json"), JSON.stringify(full));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function withTrustForTest(_scope: string, fn: () => void): void {
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
  process.env.CLAW_SCOPE_TRUST_DIR = tmp;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.CLAW_SCOPE_TRUST_DIR;
    else process.env.CLAW_SCOPE_TRUST_DIR = prior;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function ctxWithEnvelope(chatId: string, senderId: string) {
  return makeForegroundContext("req-test", {
    envelope: { chatId, senderId, ts: Date.now() },
  });
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

// ---------------------------------------------------------------------------
// Mirror of claude-whatsapp/scope.test.ts via envelope path
// ---------------------------------------------------------------------------

check("envelope owner senderId → null (unlimited, regardless of chat)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER, OWNER_LID],
    allowFrom: [OWNER, OWNER_LID, USER_B],
    groups: { [GROUP_A]: {}, [GROUP_B]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      assert(adapter !== null, "adapter created");
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, OWNER));
      assert(out === null, `expected null got ${JSON.stringify(out)}`);
    });
  } finally {
    f.cleanup();
  }
});

check("envelope owner under @lid form recognized → null", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER, OWNER_LID],
    allowFrom: [OWNER, OWNER_LID, USER_B],
    groups: { [GROUP_A]: {}, [GROUP_B]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, OWNER_LID));
      assert(out === null);
    });
  } finally {
    f.cleanup();
  }
});

check("non-owner group default 'own' → [chatId] when chatId is in universe (groups[GROUP_A])", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {}, [GROUP_B]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(Array.isArray(out), `expected array, got ${out}`);
      assert(out!.length === 1 && out![0] === GROUP_A, `expected [${GROUP_A}], got ${JSON.stringify(out)}`);
    });
  } finally {
    f.cleanup();
  }
});

check("group historyScope='all' (non-owner) → null", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: { historyScope: "all" }, [GROUP_B]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(out === null);
    });
  } finally {
    f.cleanup();
  }
});

check("group historyScope=string[] (non-owner) → [chatId, ...] universe-filtered (mirror scope.test.ts:124)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: {
      [GROUP_A]: { historyScope: ["c@g.us"] }, // c@g.us NOT in universe → dropped
      [GROUP_B]: {},
    },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(Array.isArray(out), "expected array");
      // GROUP_A is in universe via groups key; c@g.us is phantom → dropped.
      assert(
        out!.length === 1 && out![0] === GROUP_A,
        `expected only [GROUP_A], got ${JSON.stringify(out)}`
      );
    });
  } finally {
    f.cleanup();
  }
});

check("group historyScope=string[] extends own with universe-allowed extras", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: {
      [GROUP_A]: { historyScope: [GROUP_B] },
      [GROUP_B]: {},
    },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(Array.isArray(out), "expected array");
      const set = new Set(out!);
      assert(set.has(GROUP_A) && set.has(GROUP_B), `expected {A, B}, got ${JSON.stringify(out)}`);
      assert(set.size === 2);
    });
  } finally {
    f.cleanup();
  }
});

check("DM default 'own' → [chatId] (chatId === senderId for DM, in allowFrom)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: {},
    dms: {},
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      // ctx chatId = USER_B, senderId = USER_B (DM from USER_B).
      const out = adapter!.allowedChatIds(ctxWithEnvelope(USER_B, USER_B));
      assert(Array.isArray(out));
      assert(out!.length === 1 && out![0] === USER_B);
    });
  } finally {
    f.cleanup();
  }
});

check("DM historyScope='all' → null", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: {},
    dms: { [USER_B]: { historyScope: "all" } },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(USER_B, USER_B));
      assert(out === null);
    });
  } finally {
    f.cleanup();
  }
});

check("unknown historyScope value falls back to 'own' (forward-compat)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: { historyScope: "members" } }, // forward-compat
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(Array.isArray(out));
      assert(out!.length === 1 && out![0] === GROUP_A);
    });
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Precedence: env bypass, bootstrap, missing envelope
// ---------------------------------------------------------------------------

check("env bypass WINS over envelope: WHATSAPP_OWNER_BYPASS=1 + non-owner envelope → null", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {}, [GROUP_B]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const prior = process.env.WHATSAPP_OWNER_BYPASS;
      process.env.WHATSAPP_OWNER_BYPASS = "1";
      try {
        const ctx = makeForegroundContext("req", {
          envelope: { chatId: GROUP_A, senderId: USER_B, ts: Date.now() },
        });
        const out = adapter!.allowedChatIds(ctx);
        assert(out === null);
      } finally {
        if (prior === undefined) delete process.env.WHATSAPP_OWNER_BYPASS;
        else process.env.WHATSAPP_OWNER_BYPASS = prior;
      }
    });
  } finally {
    f.cleanup();
  }
});

check("bootstrap WINS over envelope: ownerJids=[] + auto-discovered → null even with envelope", () => {
  const f = mkChannelDir({
    ownerJids: [], // bootstrap
    allowFrom: [USER_B],
    groups: { [GROUP_A]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(out === null, "bootstrap fail-open preserves Phase 4a-2.5 v8 semantics");
    });
  } finally {
    f.cleanup();
  }
});

check("identity='guest' WINS over envelope (explicit deny)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "guest",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(Array.isArray(out) && out!.length === 0, "guest configured beats envelope");
    });
  } finally {
    f.cleanup();
  }
});

check("identity='owner' + trust WINS over envelope (out-of-band owner)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {} },
  });
  try {
    withTrustForTest("whatsapp", () => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "owner",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(out === null, "configured owner+trust → null");
    });
  } finally {
    f.cleanup();
  }
});

check("envelope ABSENT + non-owner + auto + ownerJids set → [] (Phase 3 ceiling)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const ctx = makeForegroundContext("req-no-envelope");
      const out = adapter!.allowedChatIds(ctx);
      assert(Array.isArray(out) && out!.length === 0, "no-envelope → guest");
    });
  } finally {
    f.cleanup();
  }
});

check("envelope with chat NOT in universe → [] (universe filter)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      // GROUP_B is not in groups (universe = allowFrom + Object.keys(groups))
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_B, USER_B));
      // Default 'own' returns [chatId] filtered through universe → [] since GROUP_B is phantom.
      assert(Array.isArray(out) && out!.length === 0, `expected [], got ${JSON.stringify(out)}`);
    });
  } finally {
    f.cleanup();
  }
});

check("group historyScope=[GROUP_B, GROUP_B, GROUP_A] deduplicates via Set (Codex round-1 LOW / round-2 strengthened)", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: {
      [GROUP_A]: { historyScope: [GROUP_B, GROUP_B, GROUP_A] }, // duplicates + self
      [GROUP_B]: {},
    },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const out = adapter!.allowedChatIds(ctxWithEnvelope(GROUP_A, USER_B));
      assert(Array.isArray(out), "expected array");
      // Codex round-2 LOW: assert exact length so an impl that returned
      // duplicates would FAIL (previously asserted Set size — tautological).
      assert(
        out!.length === 2,
        `expected length 2 (deduped), got ${out!.length} (${JSON.stringify(out)})`
      );
      // Insertion order: envelope.chatId first (GROUP_A), then first non-
      // duplicate extra (GROUP_B). Mirrors upstream Set(ctx.chatId,
      // ...scope) order which is deterministic in JS Sets.
      assert(out![0] === GROUP_A, `expected GROUP_A first, got ${out![0]}`);
      assert(out![1] === GROUP_B, `expected GROUP_B second, got ${out![1]}`);
    });
  } finally {
    f.cleanup();
  }
});

check("background context (not foreground) ignores envelope, uses identity rule", () => {
  const f = mkChannelDir({
    ownerJids: [OWNER],
    allowFrom: [OWNER, USER_B],
    groups: { [GROUP_A]: {} },
  });
  try {
    withoutTrustForTest(() => {
      const adapter = createWhatsappAdapter({
        accessPath: path.join(f.dir, "access.json"),
        channelDir: f.dir,
        configuredIdentity: "auto",
        isAutoDiscovered: true,
      });
      const ctx = makeBackgroundContext("dream-pass-1", "deny");
      const out = adapter!.allowedChatIds(ctx);
      assert(Array.isArray(out) && out!.length === 0, "background deny → []");
    });
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-envelope-resolver tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
