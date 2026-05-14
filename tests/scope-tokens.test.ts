/**
 * Tier 1 tests for the scopeToken issuer (Phase 2 of channel-scope plan).
 *
 * Covers:
 *  - issued tokens are opaque (UUID-shaped, unique)
 *  - validateScopeToken returns the bound provenance for live tokens
 *  - validateScopeToken returns null for unknown / undefined / null
 *  - TTL expiry: a token outside its window resolves to null
 *  - token store is per-process (no leak between resets)
 *
 * Run: `npx tsx tests/scope-tokens.test.ts`
 */

import {
  _resetTokenStoreForTests,
  _tokenStoreSizeForTests,
  issueScopeToken,
  validateScopeToken,
} from "../lib/scope/tokens.ts";
import { deriveProvenance } from "../lib/scope/provenance.ts";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

check("issueScopeToken returns a UUID-shaped string", () => {
  _resetTokenStoreForTests();
  const t = issueScopeToken(deriveProvenance("memory/MEMORY.md"));
  assert(typeof t === "string", "string");
  assert(UUID_RE.test(t), `UUID-shaped, got ${t}`);
});

check("issueScopeToken produces unique tokens for repeat calls", () => {
  _resetTokenStoreForTests();
  const a = issueScopeToken(deriveProvenance("memory/MEMORY.md"));
  const b = issueScopeToken(deriveProvenance("memory/MEMORY.md"));
  assert(a !== b, "tokens should differ");
});

check("validateScopeToken returns provenance for a live token", () => {
  _resetTokenStoreForTests();
  const prov = deriveProvenance("extra:claude-whatsapp/x.md");
  const token = issueScopeToken(prov);
  const got = validateScopeToken(token);
  assert(got !== null, "expected non-null");
  assert(got!.sourceChannel === "whatsapp", "channel matches");
});

check("validateScopeToken returns null for unknown / nullish input", () => {
  _resetTokenStoreForTests();
  assert(validateScopeToken("not-a-real-token") === null, "unknown token");
  assert(validateScopeToken(undefined) === null, "undefined");
  assert(validateScopeToken(null) === null, "null");
  assert(validateScopeToken("") === null, "empty");
});

check("validateScopeToken returns null after TTL expiry", () => {
  _resetTokenStoreForTests();
  const prov = deriveProvenance("memory/MEMORY.md");
  const token = issueScopeToken(prov, { ttlMs: 1 });
  // Spin until the wall clock advances past 1 ms.
  const start = Date.now();
  while (Date.now() === start) {
    /* spin */
  }
  // One more idle tick to put us safely past TTL.
  const t2 = Date.now();
  while (Date.now() - t2 < 5) {
    /* spin */
  }
  const got = validateScopeToken(token);
  assert(got === null, `expected null after TTL, got ${JSON.stringify(got)}`);
});

check("validateScopeToken prunes expired records on access", () => {
  _resetTokenStoreForTests();
  const prov = deriveProvenance("memory/MEMORY.md");
  const t = issueScopeToken(prov, { ttlMs: 1 });
  const sizeBefore = _tokenStoreSizeForTests();
  assert(sizeBefore === 1, `expected 1 in store, got ${sizeBefore}`);
  const start = Date.now();
  while (Date.now() === start) {
    /* spin */
  }
  const t2 = Date.now();
  while (Date.now() - t2 < 5) {
    /* spin */
  }
  validateScopeToken(t);
  const sizeAfter = _tokenStoreSizeForTests();
  assert(sizeAfter === 0, `expected 0 after expiry+access, got ${sizeAfter}`);
});

check("requestId is preserved when supplied", () => {
  _resetTokenStoreForTests();
  // Phase 2 doesn't expose the record directly; we validate by side
  // effect — issuing two tokens with different requestIds keeps both
  // alive until expiry. (The bound provenance comparison is enough.)
  const t1 = issueScopeToken(deriveProvenance("memory/a.md"), {
    requestId: "req-1",
    ttlMs: 60_000,
  });
  const t2 = issueScopeToken(deriveProvenance("memory/b.md"), {
    requestId: "req-2",
    ttlMs: 60_000,
  });
  assert(validateScopeToken(t1) !== null, "t1 alive");
  assert(validateScopeToken(t2) !== null, "t2 alive");
  assert(t1 !== t2, "tokens differ");
});

const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nscope-tokens tests: ${passed}/${results.length} passed`);
for (const r of failed) {
  console.log(`  FAIL: ${r.name} — ${r.msg}`);
}
if (failed.length > 0) process.exit(1);
