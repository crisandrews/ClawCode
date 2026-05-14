/**
 * Tier 1 tests for Phase 4a-2 voice + inbox surfaces.
 *
 * Codex A4 (post-adversarial review): `voice.speak` is no longer a
 * scope enforcement boundary. The `scopeTokens` plumbing is removed
 * entirely because (a) text-hash binding falsely rejects benign
 * transformations and falsely accepts paraphrases, (b) the agent
 * already has the snippet text in context once a search returns it,
 * (c) a real solution requires end-to-end taint/egress policy across
 * every output surface — out of scope for Phase 4a-2.
 *
 * What's tested here:
 *   - `voice.speak` accepts arbitrary text without ever surfacing a
 *     scope-related error string. The contract is "voice is not a
 *     trust boundary" — proving NO `scope-denied:` error path exists
 *     means a future contributor can't accidentally rely on it.
 *
 * Run: `npx tsx tests/scope-voice-inbox.test.ts`
 */

import { speak } from "../lib/voice.ts";

const results: Array<{ name: string; pass: boolean; msg?: string }> = [];

function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve(fn())
    .then(() => results.push({ name, pass: true }))
    .catch((err) =>
      results.push({ name, pass: false, msg: (err as Error).message })
    );
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function runAll() {
  await check("speak surfaces no scope-related error path under any input", async () => {
    // Empty text → "text is required" (validation), still not scope.
    const r1 = await speak("");
    assert(
      !r1.error?.startsWith("scope-denied:"),
      `unexpected scope rejection on empty text: "${r1.error}"`
    );
    // Real text → either backend success or backend-selection error;
    // never scope.
    const r2 = await speak("hello world");
    assert(
      !r2.error?.startsWith("scope-denied:"),
      `unexpected scope rejection on real text: "${r2.error}"`
    );
  });

  await check("speak ignores unknown extra opts without scope coupling", async () => {
    // Even if someone passes a scopeTokens-like field by mistake, the
    // signature doesn't accept it — TS would reject at compile time,
    // but runtime accepts via `as any` and the function ignores it.
    const r = await speak("text", {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ scopeTokens: ["bogus"] } as any),
    });
    assert(
      !r.error?.startsWith("scope-denied:"),
      `removed gate must not surface scope-denied even on stray param; got "${r.error}"`
    );
  });

  // ---------------------------------------------------------------------------
  // Run summary
  // ---------------------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log(`\nscope-voice-inbox tests: ${passed}/${results.length} passed`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name} — ${r.msg}`);
  }
  if (failed.length > 0) process.exit(1);
}

runAll();
