/**
 * Path-encoding helpers for the dual-lane dream promote target.
 *
 * Phase 4a-3 routes scoped dream candidates into
 * `memory/.scoped/<channel>/MEMORY.<encoded-chat-id>.md`. The chat-id
 * is part of the basename, so the encoder must be safe on every host
 * filesystem we may run on:
 *
 *   - POSIX: only `/` and NUL are reserved
 *   - APFS:  case-insensitive but not case-folding (treated as POSIX)
 *   - NTFS:  reserves `< > : " / \ | ? *`, ASCII < 0x20, and reserved
 *            basenames (CON, PRN, AUX, NUL, COM1..9, LPT1..9, with or
 *            without extension), and trailing `.` / ` ` on basenames
 *
 * The synthetic-chunk encoder in `messages-db-indexer.ts:encodeChatId`
 * targets a different audience (logical SQL paths, never written to
 * disk as filenames). We DON'T reuse it here because it leaves
 * NTFS-reserved characters intact — `bob:42@s.whatsapp.net` would
 * happily create a file on macOS but fail on Windows. A WhatsApp jid
 * never contains `:` `<` etc. today, but defense in depth on the
 * filesystem boundary is cheaper than a Windows-user bug report.
 *
 * Codex Phase 4a-3 pre-impl HIGH #5.
 */

import path from "node:path";

const HEX = (c: number) => "%" + c.toString(16).padStart(2, "0").toUpperCase();

const NTFS_RESERVED_CHARS = /[<>:"\\|?*]/;
const NTFS_RESERVED_BASENAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Encode a chat-id for safe inclusion in a filename basename across
 * POSIX and NTFS.
 *
 * Algorithm:
 *   1. Escape `%` so the encoding is reversible.
 *   2. Percent-encode every byte that is reserved on POSIX (`/`, `\`,
 *      NUL, control chars), reserved on NTFS (`< > : " | ? *`), or DEL.
 *   3. **Injectivity guard for natural leading underscores**: if the
 *      result starts with `_`, percent-encode every leading `_` to
 *      `%5F`. This prevents `_CON` (natural) and `CON` (reserved →
 *      prefixed `_CON`) from colliding to the same encoded form.
 *      Codex Phase 4a-3 post-impl HIGH #4.
 *   4. NTFS-reserved-basename guard: if the result (uppercased)
 *      matches a reserved name like `CON`, `PRN`, …, prepend `_`.
 *      Because step 3 escaped any naturally leading `_`, this prefix
 *      is unambiguous for the decoder.
 *   5. Reserved sentinel guard: the `_anychat` basename is reserved
 *      for the wildcard chat-id sentinel
 *      (`scopedMemoryPath(channel, "*")`). A natural chat-id of
 *      `_anychat` would collide; step 3 already escapes the leading
 *      `_`, so a real `_anychat` becomes `%5Fanychat` and only the
 *      sentinel produces the bare `_anychat` filename. Codex Phase
 *      4a-3 post-impl HIGH #5.
 *   6. Trailing `.` or ` ` on a Windows basename is silently dropped
 *      by the OS — percent-encode the last char if it lands there.
 */
export function encodeChatIdForFilename(chatId: string): string {
  if (typeof chatId !== "string" || chatId.length === 0) {
    throw new Error("encodeChatIdForFilename: chatId must be a non-empty string");
  }
  let out = "";
  for (let i = 0; i < chatId.length; i++) {
    const c = chatId.charCodeAt(i);
    const ch = chatId[i];
    if (
      c < 0x20 ||
      c === 0x7f ||
      ch === "%" ||
      ch === "/" ||
      ch === "\\" ||
      NTFS_RESERVED_CHARS.test(ch)
    ) {
      out += HEX(c);
    } else {
      out += ch;
    }
  }
  // Step 3: percent-encode every leading `_` so the natural-leading-
  // underscore variant of a reserved name (`_CON`) doesn't collide
  // with the prefix the decoder strips for the literal `CON` case.
  let leading = 0;
  while (leading < out.length && out[leading] === "_") leading++;
  if (leading > 0) {
    out = HEX(0x5f).repeat(leading) + out.slice(leading);
  }
  // Step 6: trailing `.` or space.
  const last = out[out.length - 1];
  if (last === "." || last === " ") {
    out = out.slice(0, -1) + HEX(last.charCodeAt(0));
  }
  // Step 4 + 5: NTFS-reserved basename guard. The set is checked
  // case-insensitively; `_anychat` is included so the wildcard
  // sentinel filename can never collide with a literal chat-id.
  // After step 3, no natural input still has a leading `_`, so the
  // prefix is unambiguous.
  if (NTFS_RESERVED_BASENAMES.has(out.toUpperCase()) || out === "_anychat") {
    out = "_" + out;
  }
  return out;
}

/**
 * Inverse of `encodeChatIdForFilename`.
 */
export function decodeChatIdFromFilename(encoded: string): string | null {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  // Strip the reserved-basename underscore guard. We only strip when
  // the suffix (uppercased) matches a reserved name OR the literal
  // sentinel reserve `_anychat` — those are the only inputs the
  // encoder produces with a leading `_`. Naturally-leading underscores
  // have been escaped to `%5F` by the encoder, so any leading `_` in
  // the wire format is the encoder's prefix.
  let work = encoded;
  if (work.startsWith("_")) {
    const suffix = work.slice(1);
    if (
      NTFS_RESERVED_BASENAMES.has(suffix.toUpperCase()) ||
      suffix === "_anychat"
    ) {
      work = suffix;
    }
  }
  try {
    return decodeURIComponent(work);
  } catch {
    return null;
  }
}

/**
 * Build the relative scoped MEMORY path for a (channel, chatId) pair.
 *
 * Returns paths in the canonical OpenCLAUDE form:
 *   `memory/.scoped/<channel>/MEMORY.<encoded-chat-id>.md`
 *
 * The chat-id "*" is reserved for "no specific chat" — for example,
 * worst-contributor-wins on a candidate whose provenance was mixed
 * across multiple chats inside the same channel.
 *
 * **Visibility for `*` (= `_anychat` filename):** when the dual-lane
 * uses the wildcard sentinel, the resulting chunk has
 * `source_chat_id = NULL` in SQL. The Phase 4a-2.6 partial-allowlist
 * predicate `(source_channel != ? OR source_chat_id IN (?, ?, …))`
 * excludes NULL from the IN list — so `_anychat` content is invisible
 * to non-owner partial-allowlist users. Owner unlock (no SQL
 * prefilter) still sees them. This is intentional fail-closed
 * behavior: "no specific chat" is treated as "owner-only" rather than
 * "everyone with the channel armed". Codex post-impl-round2 MEDIUM
 * #10 documented this.
 */
export function scopedMemoryPath(channel: string, chatId: string): string {
  if (!isChannelNameSafe(channel)) {
    throw new Error(
      `scopedMemoryPath: unsafe channel name: ${JSON.stringify(channel)}`
    );
  }
  const encoded = chatId === "*" ? "_anychat" : encodeChatIdForFilename(chatId);
  return `memory/.scoped/${channel}/MEMORY.${encoded}.md`;
}

const SCOPED_PATH_RE =
  /^memory\/\.scoped\/([a-z0-9_-]+)\/MEMORY\.(.+)\.md$/;

/**
 * Allowlist of channels that can produce a scoped MEMORY mirror.
 * Mirrors `ALL_KNOWN_SCOPE_CHANNELS` in `lib/scope/runtime.ts`. A
 * scoped path under any other channel name is rejected by
 * `parseScopedMemoryPath` and `isScopedMemoryPath` — without this
 * gate, a planted `memory/.scoped/notreal/MEMORY.x.md` would be
 * trusted by `deriveProvenance` and pass through every armed-channel
 * filter unchecked. Codex Phase 4a-3 post-impl MEDIUM #8.
 */
const KNOWN_SCOPE_CHANNELS: ReadonlySet<string> = new Set([
  "whatsapp",
  "telegram",
  "discord",
  "imessage",
  "webchat",
]);

/**
 * Match a logical path against the canonical scoped-MEMORY pattern.
 * Returns `{channel, chatId}` on success, `null` otherwise.
 *
 * `chatId` is decoded back to its original form. The reserved
 * `_anychat` sentinel decodes to `*`.
 */
export function parseScopedMemoryPath(
  relPath: string
): { channel: string; chatId: string } | null {
  if (typeof relPath !== "string") return null;
  // Reject obvious traversal — a `.scoped/<channel>/..` shouldn't
  // confuse downstream consumers.
  if (relPath.includes("..")) return null;
  const m = relPath.match(SCOPED_PATH_RE);
  if (!m) return null;
  const channel = m[1];
  // Codex post-impl MEDIUM #8: refuse paths under any channel name
  // we don't know about. Without this, a planted scoped file under
  // `notreal/` would be trusted as a real channel mirror and pass
  // every armed-channel filter unchecked.
  if (!KNOWN_SCOPE_CHANNELS.has(channel)) return null;
  const encoded = m[2];
  if (encoded === "_anychat") {
    return { channel, chatId: "*" };
  }
  const chatId = decodeChatIdFromFilename(encoded);
  if (chatId === null) return null;
  return { channel, chatId };
}

/**
 * Test whether a channel name is in the known-scope-channel
 * allowlist. Exported so other subsystems (e.g. dream redaction
 * labeling) can mirror the parser's tight validation without
 * re-deriving the set. Codex post-impl-round5 RH-7.
 */
export function isKnownScopeChannel(channel: string): boolean {
  return typeof channel === "string" && KNOWN_SCOPE_CHANNELS.has(channel);
}

/**
 * Cheap structural check: does this look like a scoped-MEMORY path
 * under a known channel? Used by callers that just need a yes/no
 * without the decode round. Unknown channels return false (Codex
 * post-impl MEDIUM #8).
 */
export function isScopedMemoryPath(relPath: string): boolean {
  if (typeof relPath !== "string") return false;
  if (relPath.includes("..")) return false;
  const m = relPath.match(SCOPED_PATH_RE);
  if (!m) return false;
  return KNOWN_SCOPE_CHANNELS.has(m[1]);
}

/**
 * Channel names live in URLs, filenames, and SQL `source_channel`
 * columns. Constrain to the same lowercase + `_-` set the runtime
 * already enforces.
 */
function isChannelNameSafe(channel: string): boolean {
  return typeof channel === "string" && /^[a-z0-9_-]+$/.test(channel);
}

/**
 * Resolve the absolute scoped-memory directory for a channel under a
 * given workspace root. Used at write time to ensure the directory
 * exists (with 0700 permissions, see the dream promoter).
 */
export function resolveScopedDir(workspaceRoot: string, channel: string): string {
  if (!isChannelNameSafe(channel)) {
    throw new Error(
      `resolveScopedDir: unsafe channel name: ${JSON.stringify(channel)}`
    );
  }
  return path.join(workspaceRoot, "memory", ".scoped", channel);
}
