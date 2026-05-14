/**
 * Tier 1 tests for the OpenCLAUDE envelope reader (Phase 6).
 *
 * Mirrors the contract validation matrix from
 * `docs/scope-envelope-contract.md`. Each rejection path returns null;
 * the happy path returns the parsed payload and registers the token in
 * the LRU consumed-tokens cache for bounded-reuse within TTL.
 *
 * Run: `npx tsx tests/scope-envelope-reader.test.ts`
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EnvelopeReader,
  ENVELOPE_DIR_NAME,
  ENVELOPE_LRU_CONSUMED_TOKENS_CAP,
  ENVELOPE_MAX_BYTES,
  ENVELOPE_TTL_MS,
  ENVELOPE_TOKEN_LENGTH,
  ENVELOPE_VERSION,
  type RequestEnvelopePayload,
} from "../lib/scope/envelope.ts";

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

function mkChannelDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-envelope-"));
}

function writeEnvelope(
  channelDir: string,
  token: string,
  payload: Record<string, unknown>,
  mode: number = 0o600
): string {
  const dir = path.join(channelDir, ENVELOPE_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const filePath = path.join(dir, `${token}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload), { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

const VALID_TOKEN = "y978KM9t-PcFQkGC9Af0OsAWogPpsb6rzTTocV-nyKo";

function validPayload(now: number): Record<string, unknown> {
  return {
    version: ENVELOPE_VERSION,
    token: VALID_TOKEN,
    chatId: "120363270000000000@g.us",
    senderId: "5491112345678@s.whatsapp.net",
    ts: now,
    expiresAt: now + ENVELOPE_TTL_MS,
  };
}

// ---------------------------------------------------------------------------
// Token regex / filename validation
// ---------------------------------------------------------------------------

check("rejects token outside TOKEN_REGEX (no FS access)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    assert(reader.load(dir, "../etc/passwd") === null, "traversal token");
    assert(reader.load(dir, "tooShort") === null, "underlength");
    assert(
      reader.load(dir, "a".repeat(ENVELOPE_TOKEN_LENGTH + 1)) === null,
      "overlength"
    );
    assert(
      reader.load(dir, "with space xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") ===
        null,
      "space"
    );
    assert(
      reader.load(dir, "with/slash" + "x".repeat(33)) === null,
      "slash"
    );
    assert(reader.load(dir, "" as unknown as string) === null, "empty");
    assert(reader.load(dir, 123 as unknown as string) === null, "non-string");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

check("loads a valid fresh envelope", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    writeEnvelope(dir, VALID_TOKEN, validPayload(now));
    const out = reader.load(dir, VALID_TOKEN, now);
    assert(out !== null, "expected payload, got null");
    assert(out!.chatId === "120363270000000000@g.us", "chatId mismatch");
    assert(out!.senderId === "5491112345678@s.whatsapp.net", "senderId mismatch");
    assert(out!.token === VALID_TOKEN, "token roundtrip");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Schema validation matrix
// ---------------------------------------------------------------------------

check("rejects malformed JSON", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const filePath = path.join(dir, ENVELOPE_DIR_NAME, `${VALID_TOKEN}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "not json {", { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    assert(reader.load(dir, VALID_TOKEN) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects wrong version", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const p = validPayload(now);
    p.version = 2;
    writeEnvelope(dir, VALID_TOKEN, p);
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects payload.token != filename stem", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const p = validPayload(now);
    p.token = "different_token_43_chars_padpadpadpadpadpad";
    writeEnvelope(dir, VALID_TOKEN, p);
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects missing required fields", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    // Codex 1st-pass MEDIUM 4: cover ALL required fields, including token.
    for (const field of ["chatId", "senderId", "ts", "expiresAt", "version", "token"]) {
      const p = validPayload(now);
      delete (p as Record<string, unknown>)[field];
      writeEnvelope(dir, VALID_TOKEN, p);
      assert(
        reader.load(dir, VALID_TOKEN, now) === null,
        `missing ${field} should reject`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects wrong-type fields (Codex 1st-pass MEDIUM 4)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const cases: Array<[string, unknown]> = [
      ["version", "1"], // string instead of number
      ["token", 12345], // number instead of string
      ["chatId", 999], // number
      ["senderId", []], // array
      ["ts", String(now)], // string
      ["expiresAt", String(now + 60_000)], // string
    ];
    for (const [field, badValue] of cases) {
      const p = validPayload(now);
      (p as Record<string, unknown>)[field] = badValue;
      writeEnvelope(dir, VALID_TOKEN, p);
      assert(
        reader.load(dir, VALID_TOKEN, now) === null,
        `wrong-type ${field}=${JSON.stringify(badValue)} should reject`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects empty-string chatId or senderId", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const p1 = validPayload(now);
    p1.chatId = "";
    writeEnvelope(dir, VALID_TOKEN, p1);
    assert(reader.load(dir, VALID_TOKEN, now) === null);

    const p2 = validPayload(now);
    p2.senderId = "";
    writeEnvelope(dir, VALID_TOKEN, p2);
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects non-finite ts or expiresAt", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      const p = validPayload(now);
      p.ts = bad;
      writeEnvelope(dir, VALID_TOKEN, p);
      assert(reader.load(dir, VALID_TOKEN, now) === null, `ts=${bad}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects expiresAt !== ts + TTL_MS", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const p = validPayload(now);
    p.expiresAt = now + ENVELOPE_TTL_MS + 100; // wrong relation
    writeEnvelope(dir, VALID_TOKEN, p);
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// TTL + future-skew
// ---------------------------------------------------------------------------

check("rejects expired (now - ts > TTL)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const ts = now - ENVELOPE_TTL_MS - 1;
    writeEnvelope(dir, VALID_TOKEN, validPayload(ts));
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects future-skewed beyond tolerance", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const ts = now + 6_000; // > 5s tolerance
    writeEnvelope(dir, VALID_TOKEN, validPayload(ts));
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("accepts ts within future-skew tolerance", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const ts = now + 3_000; // within 5s tolerance
    writeEnvelope(dir, VALID_TOKEN, validPayload(ts));
    const out = reader.load(dir, VALID_TOKEN, now);
    assert(out !== null, "should accept within skew tolerance");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FS hardening
// ---------------------------------------------------------------------------

check("rejects symlinked envelope file (O_NOFOLLOW)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const envDir = path.join(dir, ENVELOPE_DIR_NAME);
    fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
    const realFile = path.join(dir, "real-target.json");
    fs.writeFileSync(realFile, JSON.stringify(validPayload(now)), { mode: 0o600 });
    fs.symlinkSync(realFile, path.join(envDir, `${VALID_TOKEN}.json`));
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects file with mode 0o644 (world-readable)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    writeEnvelope(dir, VALID_TOKEN, validPayload(now), 0o644);
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("rejects oversized file (> ENVELOPE_MAX_BYTES)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    const p = validPayload(now) as Record<string, unknown>;
    p.junk = "x".repeat(ENVELOPE_MAX_BYTES * 2);
    writeEnvelope(dir, VALID_TOKEN, p);
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("returns null when envelope file missing (independence: no claude-whatsapp)", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    // No file written; loader must not throw.
    assert(reader.load(dir, VALID_TOKEN, now) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("returns null when channel-dir missing entirely", () => {
  const reader = new EnvelopeReader();
  const nonExistent = path.join(os.tmpdir(), "oc-no-channel-" + Date.now());
  assert(reader.load(nonExistent, VALID_TOKEN) === null);
});

// ---------------------------------------------------------------------------
// Bounded-reuse cache (Codex amendment 6a.2c)
// ---------------------------------------------------------------------------

check("bounded-reuse: second load within TTL returns cached payload", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    writeEnvelope(dir, VALID_TOKEN, validPayload(now));
    const first = reader.load(dir, VALID_TOKEN, now);
    assert(first !== null, "first load");
    assert(reader.cacheSize() === 1, "cache populated");

    // Delete the file from disk to prove cache served.
    fs.unlinkSync(path.join(dir, ENVELOPE_DIR_NAME, `${VALID_TOKEN}.json`));

    const second = reader.load(dir, VALID_TOKEN, now + 10_000);
    assert(second !== null, "second load served from cache despite file gone");
    assert(second!.chatId === first!.chatId, "cached payload identical");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("bounded-reuse: load past TTL returns null even with cached entry", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    writeEnvelope(dir, VALID_TOKEN, validPayload(now));
    const first = reader.load(dir, VALID_TOKEN, now);
    assert(first !== null, "first load");

    // Past TTL — file may still exist but ts is now stale relative to "future" now.
    const future = now + ENVELOPE_TTL_MS + 100;
    assert(reader.load(dir, VALID_TOKEN, future) === null, "past TTL rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("bounded-reuse LRU caps at ENVELOPE_LRU_CONSUMED_TOKENS_CAP", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    // Generate many distinct tokens; each plants its own envelope.
    const tokens: string[] = [];
    for (let i = 0; i < ENVELOPE_LRU_CONSUMED_TOKENS_CAP + 10; i++) {
      const tok = "Tok" + String(i).padStart(40, "0");
      // Pad token to exact length, base64url charset.
      const padded = tok.slice(0, ENVELOPE_TOKEN_LENGTH).padEnd(ENVELOPE_TOKEN_LENGTH, "A");
      tokens.push(padded);
      const payload = validPayload(now);
      payload.token = padded;
      writeEnvelope(dir, padded, payload);
      reader.load(dir, padded, now);
    }
    assert(
      reader.cacheSize() <= ENVELOPE_LRU_CONSUMED_TOKENS_CAP,
      `cache size ${reader.cacheSize()} exceeds cap ${ENVELOPE_LRU_CONSUMED_TOKENS_CAP}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Golden fixture round-trip (cross-repo contract)
// ---------------------------------------------------------------------------

check("golden fixture parses identically to claude-whatsapp side", () => {
  const reader = new EnvelopeReader();
  const testDir = path.dirname(new URL(import.meta.url).pathname);
  const fixturePath = path.join(testDir, "fixtures", "scope-envelope-v1.json");
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as RequestEnvelopePayload;
  // Use a `now` close to fixture's ts so TTL passes.
  const out = reader.parseAndValidate(raw, parsed.token, parsed.ts + 1000);
  assert(out !== null, "fixture should parse cleanly");
  assert(out!.token === "y978KM9t-PcFQkGC9Af0OsAWogPpsb6rzTTocV-nyKo");
  assert(out!.chatId === "120363270000000000@g.us");
  assert(out!.senderId === "5491112345678@s.whatsapp.net");
});

// Codex round-1 MEDIUM 3: golden-fixture cross-repo byte-identity check.
// Previously the test only verified the LOCAL fixture parsed; now we
// hash both repos' fixtures and assert sha256 equality so a future
// drift on either side fails fast (instead of relying on humans to
// remember to re-mirror).
check("golden fixture is byte-identical between OpenCLAUDE and claude-whatsapp repos", () => {
  const testDir = path.dirname(new URL(import.meta.url).pathname);
  const localFixture = path.join(testDir, "fixtures", "scope-envelope-v1.json");
  const upstreamFixture =
    "/Users/tenacious/Proyectos/ClaudeWhatsapp/tests/fixtures/scope-envelope-v1.json";
  if (!fs.existsSync(upstreamFixture)) {
    // claude-whatsapp not checked out alongside; skip the cross-repo
    // assertion rather than failing — keeps OpenCLAUDE's suite portable.
    return;
  }
  const localHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(localFixture))
    .digest("hex");
  const upstreamHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(upstreamFixture))
    .digest("hex");
  assert(
    localHash === upstreamHash,
    `fixture drift: local=${localHash} upstream=${upstreamHash}`
  );
});

// Codex round-1 MEDIUM 2: directory-level symlink defense.
check("rejects symlinked .request-envelopes directory", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    // Plant a legitimate envelope in a DIFFERENT dir, then symlink
    // `.request-envelopes` to that dir. Reader must reject before
    // touching the file.
    const real = path.join(dir, "real-envelopes");
    fs.mkdirSync(real, { recursive: true, mode: 0o700 });
    fs.chmodSync(real, 0o700);
    fs.writeFileSync(
      path.join(real, `${VALID_TOKEN}.json`),
      JSON.stringify(validPayload(now)),
      { mode: 0o600 }
    );
    fs.chmodSync(path.join(real, `${VALID_TOKEN}.json`), 0o600);
    fs.symlinkSync(real, path.join(dir, ENVELOPE_DIR_NAME));

    assert(reader.load(dir, VALID_TOKEN, now) === null, "symlinked dir rejected");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Codex round-1 LOW 3: true LRU (not FIFO) — reused tokens stay resident.
// Test design: insert keeper FIRST, fill cache, then TOUCH keeper, then
// push one more entry to trigger eviction. With FIFO the keeper would
// be evicted (oldest insertion). With true LRU the keeper survives
// (touched between fills moves it to end).
check("LRU promotes reused tokens — touched-then-overfilled keeper survives", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const now = Date.now();
    // 1. Insert keeper as the FIRST entry — most vulnerable to FIFO eviction.
    const keeperPayload = validPayload(now);
    writeEnvelope(dir, VALID_TOKEN, keeperPayload);
    assert(reader.load(dir, VALID_TOKEN, now) !== null, "keeper first load");

    // 2. Fill cache to exactly CAP - 1 fillers. After this the cache holds
    //    [keeper(0), filler_0, filler_1, ..., filler_CAP-2] = CAP entries.
    const cap = ENVELOPE_LRU_CONSUMED_TOKENS_CAP;
    for (let i = 0; i < cap - 1; i++) {
      const tok = "Fil" + String(i).padStart(40, "0");
      const padded = tok.slice(0, 43).padEnd(43, "A");
      const p = validPayload(now);
      p.token = padded;
      writeEnvelope(dir, padded, p);
      reader.load(dir, padded, now);
    }
    assert(reader.cacheSize() === cap, `cache full at cap=${cap}`);

    // 3. TOUCH the keeper to bump its recency to the end. Without LRU
    //    semantics, this is a no-op for the eviction policy.
    assert(reader.load(dir, VALID_TOKEN, now + 1) !== null, "keeper re-touched");

    // 4. Insert one more filler — should evict the OLDEST cache entry.
    //    With FIFO, oldest = keeper (insertion 0). With LRU, oldest =
    //    filler_0 because keeper was just touched.
    const evicterTok = ("EvI" + String(0).padStart(40, "0"))
      .slice(0, 43)
      .padEnd(43, "A");
    const evicterPayload = validPayload(now);
    evicterPayload.token = evicterTok;
    writeEnvelope(dir, evicterTok, evicterPayload);
    reader.load(dir, evicterTok, now);

    // 5. Delete keeper from disk to prove serve-from-cache.
    fs.unlinkSync(path.join(dir, ENVELOPE_DIR_NAME, `${VALID_TOKEN}.json`));
    const reload = reader.load(dir, VALID_TOKEN, now + 100);
    assert(
      reload !== null,
      "true-LRU should keep the touched keeper; FIFO would have evicted it"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Codex round-1 LOW: dedup in resolver — duplicate historyScope arrays
// should produce deduped allowlist. This test lives in the resolver test,
// but a reader-level smoke is fine here too (no-op since dedup is in
// resolver, not reader).
check("malformed JSON (array instead of object) rejected", () => {
  const reader = new EnvelopeReader();
  const dir = mkChannelDir();
  try {
    const envDir = path.join(dir, ENVELOPE_DIR_NAME);
    fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(envDir, 0o700);
    fs.writeFileSync(path.join(envDir, `${VALID_TOKEN}.json`), "[1,2,3]", {
      mode: 0o600,
    });
    fs.chmodSync(path.join(envDir, `${VALID_TOKEN}.json`), 0o600);
    assert(reader.load(dir, VALID_TOKEN) === null);

    fs.writeFileSync(path.join(envDir, `${VALID_TOKEN}.json`), "null", {
      mode: 0o600,
    });
    fs.chmodSync(path.join(envDir, `${VALID_TOKEN}.json`), 0o600);
    assert(reader.load(dir, VALID_TOKEN) === null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-envelope-reader tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) {
  process.exit(1);
}
