/**
 * Per-request scope context — Phase 3 of channel-scope compatibility.
 *
 * "Context" here is the *who* of a tool call. claude-whatsapp's MCP
 * tools answer that internally with `currentInboundContext` (a
 * process-local singleton; see Phase 1 findings). OpenCLAUDE runs in
 * a separate MCP server and cannot read that singleton, so Phase 3
 * builds a degraded model on top of what *is* observable from this
 * process: env vars (owner bypass), config (background identity per
 * channel), and request-time hints (the tool argument that carries
 * the chat id, when present).
 *
 * Phase 4a-1 will add chat-id derivation from the upstream marker
 * file `<channel-dir>/.last-inbound.json` (proposed) or a host-
 * mediated context capability. Until then, the context only carries
 * "is the operator the owner?" as a hard signal.
 *
 * IMPORTANT INVARIANT: nothing in this module reads any file or
 * makes any decision unless `runtime.anyArmed === true` OR
 * `runtime.anyEnforceConfigured === true` (Phase 5 v9 ship-readiness
 * — the latter catches the gap where a channel is `mode: enforce`
 * configured but the adapter went missing mid-session). For users
 * who haven't opted into scope, the helpers either short-circuit
 * with empty/permissive defaults or are simply never called from the
 * runtime detection path.
 */

import type { ChannelName } from "../channel-detector.ts";

/**
 * Foreground request context — what the runtime knows about the
 * current MCP tool call. Phase 6 adds `envelope` (the
 * authoritative chat/sender binding from claude-whatsapp's request
 * envelope file). When `envelope` is present and valid, adapters
 * mirror upstream's per-chat `historyScope` semantics; when absent
 * under `mode=enforce`, the resolver falls through to guest `[]`.
 */
export interface ForegroundContext {
  kind: "foreground";
  /** Stable correlation ID for the current MCP tool call. */
  requestId: string;
  /** True when WHATSAPP_OWNER_BYPASS=1 (or analog) is set in the env. */
  ownerBypass: boolean;
  /** Optional chat id hint from a tool argument (e.g. `chat_id`). */
  chatIdHint?: string;
  /**
   * Phase 6: authoritative inbound identity from claude-whatsapp's
   * request envelope file. Populated by the MCP handler when the tool
   * arg `requestEnvelopeToken` is present, valid, and within TTL.
   * Resolver consults this BEFORE chatIdHint (envelope > hint).
   */
  envelope?: {
    chatId: string;
    senderId: string;
    ts: number;
  };
}

/**
 * Background context — used for dream cycles, indexer runs, watchers,
 * and other code paths that aren't reacting to a specific MCP tool
 * call. Each armed channel has its own background context; defaults
 * are channel-specific because "deny" might be right for WhatsApp
 * dreams while "system-owner" is right for, say, a personal
 * Telegram bot a user controls 100%.
 */
export interface BackgroundContext {
  kind: "background";
  /** Channel-specific background identity. */
  identity: BackgroundIdentity;
  /** Stable correlation ID for this background pass. */
  passId: string;
}

export type BackgroundIdentity =
  | "deny" /* refuse to read scoped chunks at all */
  | "system-owner"; /* act as the configured owner (requires explicit opt-in) */

export type ScopeContext = ForegroundContext | BackgroundContext;

/**
 * Read the WHATSAPP_OWNER_BYPASS env var. Mirrors claude-whatsapp's
 * `ownerBypassEnabled()` so the OpenCLAUDE adapter resolves the
 * same way the upstream plugin's MCP tools do.
 */
export function detectOwnerBypassEnv(env: NodeJS.ProcessEnv = process.env): {
  bypass: boolean;
  channel: ChannelName | null;
} {
  const wa = env.WHATSAPP_OWNER_BYPASS;
  if (wa === "1" || wa === "true") {
    return { bypass: true, channel: "whatsapp" };
  }
  return { bypass: false, channel: null };
}

/**
 * Build a fresh foreground context for the current request. The
 * `requestId` is opaque — callers can pass an MCP request id, a
 * generated UUID, or any other stable string. The runtime never
 * inspects it.
 */
export function makeForegroundContext(
  requestId: string,
  options: {
    chatIdHint?: string;
    env?: NodeJS.ProcessEnv;
    envelope?: { chatId: string; senderId: string; ts: number };
  } = {}
): ForegroundContext {
  const { bypass } = detectOwnerBypassEnv(options.env);
  return {
    kind: "foreground",
    requestId,
    ownerBypass: bypass,
    ...(options.chatIdHint !== undefined
      ? { chatIdHint: options.chatIdHint }
      : {}),
    ...(options.envelope !== undefined ? { envelope: options.envelope } : {}),
  };
}

/**
 * Build a background context for a non-request code path (dreams,
 * indexer). The `identity` argument is read from
 * `config.scope.<channel>.background.identity`; default is `"deny"`.
 */
export function makeBackgroundContext(
  passId: string,
  identity: BackgroundIdentity = "deny"
): BackgroundContext {
  return { kind: "background", identity, passId };
}
