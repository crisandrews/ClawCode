#!/usr/bin/env node
/**
 * Bridge from the wizard's Bash snippet to the TypeScript `workspaceFingerprint`
 * helper. The wizard MUST NOT reimplement the hash inline — Codex round-1 HIGH
 * #3 caught a case-fold mismatch where Bash crypto without `.toLowerCase()`
 * produced a different hex on macOS uppercase paths than the TS helper, leaving
 * trust unlocks silently broken.
 *
 * Invocation (use the PLUGIN-LOCAL tsx binary, not `npx tsx`):
 *
 *   "$CLAUDE_PLUGIN_ROOT/node_modules/.bin/tsx" \
 *     "$CLAUDE_PLUGIN_ROOT/scripts/print-workspace-fingerprint.mjs" "$PWD"
 *
 * Codex Phase 8 round-1 HIGH #2: invoking via `npx tsx` from the user's
 * workspace cwd fails — `npx` looks for `tsx` in the user-cwd's
 * `node_modules/.bin` first, doesn't find it, then attempts a registry
 * fetch which can fail (offline, sandboxed, npm misconfigured). The
 * plugin-local binary is always present after `npm install` ran in the
 * plugin install dir.
 *
 * The script prints exactly one line: the 32-hex fingerprint, no trailing
 * whitespace beyond `console.log`'s newline.
 */

import { workspaceFingerprint } from "../lib/scope/trust.ts";

const ws = process.argv[2];
if (!ws) {
  console.error("usage: print-workspace-fingerprint <workspaceRoot>");
  process.exit(1);
}
console.log(workspaceFingerprint(ws));
