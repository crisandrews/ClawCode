/**
 * Agent-config write guard for the `agent_config(action='set')` MCP tool.
 *
 * Phase 4a-2.5 v5 — Codex 4th-pass CRITICAL 1 + HIGH 1 fix lives here so
 * that `server.ts` and the regression tests pin the same implementation
 * (avoids the tautology of reimplementing the predicate inline in tests).
 *
 * Two distinct refusals:
 *
 *   - `"scope"`: the key writes anywhere into the `scope` config tree.
 *     v4 only blocked the four sensitive leaves; v5 found that an
 *     ancestor-object write (`key='scope'`, `value='{...}'`) bypassed the
 *     leaf check entirely. v5 takes the conservative stance: ALL scope
 *     writes go through the wizard's `Bash` flow, which the user must
 *     approve interactively. This includes non-policy keys like
 *     `cwdExactMatchOnly` — the wizard consolidates them.
 *
 *   - `"proto"`: the dotted key contains a forbidden segment
 *     (`__proto__`, `constructor`, `prototype`) anywhere in the path.
 *     The traversal in `server.ts` does `target[parts[i]]` directly, so
 *     these segments would mutate `Object.prototype`. Refuse globally,
 *     not just under `scope`.
 */

const PROTO_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Phase 4a-2.5 v6 — Codex 5th-pass LOW: cap key length and depth
 * before any traversal/JSON.stringify happens downstream. Without
 * these caps a 1 MB dotted key would walk a million-deep object tree
 * and stringify every nested empty `{}` — gigabyte-scale CPU/disk hit
 * from a single MCP call. The defaults are generous enough for any
 * realistic config schema (deepest known key is depth 4) while still
 * bounding the worst case.
 */
const MAX_KEY_CHARS = 256;
const MAX_KEY_SEGMENTS = 16;
const MAX_SEGMENT_CHARS = 64;

/**
 * Phase 4a-2.5 v7+v8 — Codex 6th/7th-pass: keys whose value becomes a
 * trusted write root, a trusted *read* root for provenance gating, or
 * a path passed to `spawnSync` must NOT be settable through
 * `agent_config`. Otherwise a prompt-injected agent can self-elevate.
 *
 * Threats this set closes:
 *   - `voice.outputDir` / `voice.config.outputDir` (Codex 6th-pass HIGH F-6-1):
 *       agent flips outputDir to `~/.ssh`, then `voice_speak` writes
 *       audio bytes to `authorized_keys`.
 *   - `memory.extraPaths` (Codex 7th-pass HIGH V7-7P-F1):
 *       `mapAbsoluteToLogical` consults extraPaths to attribute
 *       absolute audio paths to a channel. Agent removes/replaces an
 *       entry → `voice_transcribe` no longer recognizes the path as
 *       channel-derived → `assertCanReadPath` treats it as legacy and
 *       allows the read. Provenance-deception bypass.
 *   - `memory.qmd.command` (Codex 7th-pass HIGH V7-7P-F2):
 *       `QmdManager` runs this string via `spawnSync` for `--version`
 *       and every QMD call. Agent flip = arbitrary code exec.
 *
 * Treat these like scope keys: refuse via the MCP tool, route them
 * through Bash with a user permission prompt. (NB: `live-config`
 * additionally freezes these keys on disk hot-reload — see
 * `lib/live-config.ts`.)
 *
 * NOTE: `scope.*` is NOT listed here because `classifyAgentConfigKey`
 * already returns `"scope"` for it. This list complements that check
 * for non-scope keys whose value is a path/filesystem-trust signal.
 */
export const PRIVILEGED_PATH_KEYS = new Set([
  "voice.outputDir",
  "voice.config.outputDir",
  "memory.extraPaths",
  "memory.qmd.command",
]);

export type AgentConfigKeyClass = "scope" | "proto" | "oversize" | "privileged" | false;

export function classifyAgentConfigKey(key: string): AgentConfigKeyClass {
  if (key.length > MAX_KEY_CHARS) return "oversize";
  const parts = key.split(".");
  if (parts.length > MAX_KEY_SEGMENTS) return "oversize";
  for (const p of parts) {
    if (p.length > MAX_SEGMENT_CHARS) return "oversize";
    if (PROTO_SEGMENTS.has(p)) return "proto";
  }
  if (key === "scope" || key.startsWith("scope.")) return "scope";

  // Codex 6th-pass HIGH F-6-1: refuse exact matches AND any ancestor
  // path that could carry a privileged leaf via an object value
  // (mirrors the v5 ancestor-object widening for `scope`).
  if (isPrivilegedPathKey(key)) return "privileged";

  return false;
}

function isPrivilegedPathKey(key: string): boolean {
  if (PRIVILEGED_PATH_KEYS.has(key)) return true;
  for (const p of PRIVILEGED_PATH_KEYS) {
    // Ancestor of a privileged leaf: refusing it prevents object
    // ancestor-writes (`{outputDir: "~/.ssh"}`).
    if (p.startsWith(key + ".")) return true;
    // Codex 7th-pass LOW F4: descendant of a privileged leaf. Without
    // this, `voice.outputDir.weirdKey = "x"` flips outputDir from a
    // string to an object and crashes `voice_speak` downstream
    // (availability bug, not bypass). Refuse for hygiene.
    if (key.startsWith(p + ".")) return true;
  }
  return false;
}
