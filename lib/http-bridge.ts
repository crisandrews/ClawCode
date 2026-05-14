/**
 * HTTP Bridge — optional local HTTP server that runs alongside the MCP stdio server.
 *
 * When enabled via agent-config.json (`http.enabled: true`), this starts a
 * localhost HTTP listener that exposes:
 *   - Agent status and skill listing (`/v1/status`, `/v1/skills`)
 *   - Webhook ingestion (`POST /v1/webhook`)
 *   - WebChat: browser-based chat UI with SSE-backed real-time replies
 *     (`GET /` serves chat.html, `POST /v1/chat/send`, `GET /v1/chat/stream`)
 *
 * Architecture: Node's built-in `http` module — zero external dependencies.
 * The server only binds to 127.0.0.1 by default for security.
 *
 * When a WebChat message arrives, the HttpBridge invokes `onChatMessage` if
 * registered. The MCP server wires this to push an MCP `notifications/claude/channel`
 * notification so the agent sees the message inline (channel-style), same as WhatsApp.
 * Messages are also queued for a fallback `chat_inbox_read` MCP tool.
 *
 * Logging: dual-format (JSONL + Markdown) mirroring the WhatsApp plugin's approach.
 * Conversation logs live at `{workspace}/.webchat/logs/conversations/`.
 * System events go to `{workspace}/.webchat/logs/system.log`.
 */

import http from "http";
import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";

/** Format a Date as YYYY-MM-DD. */
function datestamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Format a Date as HH:MM:SS. */
function timeOnly(d: Date = new Date()): string {
  return d.toISOString().slice(11, 19);
}

export interface HttpBridgeConfig {
  enabled: boolean;
  port: number;
  host: string;
  /** Bearer token for authenticated endpoints. If empty, no auth required. */
  token: string;
}

/**
 * Pure helper: does the given remoteAddress look like a loopback peer?
 * Covers IPv4, IPv6, and IPv4-mapped-IPv6 forms. Exported so it can be
 * unit-tested without spinning up an HTTP server.
 */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

export const HTTP_DEFAULTS: HttpBridgeConfig = {
  enabled: false,
  port: 18790,
  host: "127.0.0.1",
  token: "",
};

interface StatusProvider {
  getIdentity: () => string;
  getMemoryStats: () => { files: number; chunks: number; totalSize: number };
  getConfig: () => Record<string, any>;
  /**
   * Optional. When present, `/watchdog/mcp-ping` returns its payload (JSON).
   * Server.ts wires this to its buildWatchdogPing() helper; the HTTP bridge
   * simply serializes. Absent = endpoint returns 503.
   */
  getWatchdogInfo?: () => unknown;
}

interface WebhookEntry {
  id: string;
  ts: string;
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface ChatMessage {
  id: string;
  ts: string;
  role: "user" | "agent";
  content: string;
  /**
   * Per-browser privacy partition. v1 of this field (Phase 4b) — every
   * `ChatMessage` carries one. Public client-facing surfaces require a
   * UUID v4. Two reserved internal sentinels never accepted from the
   * outside:
   *   - `_legacy` — JSONL entries written before this version had no
   *     sessionId; `loadHistoryFromDisk` maps them all to this bucket
   *     so they're recoverable for the agent without leaking into a
   *     real client's view.
   *   - `_watchdog` — `/watchdog/llm-ping` injects probes that need to
   *     traverse the same agent path as a real user, but must NOT be
   *     visible to any browser client.
   */
  sessionId: string;
}

type ChatMessageHandler = (msg: ChatMessage) => void | Promise<void>;

interface SseClient {
  id: string;
  sessionId: string;
  res: http.ServerResponse;
}

/** Internal sentinels — never accepted from public surfaces. */
const RESERVED_SESSION_LEGACY = "_legacy";
const RESERVED_SESSION_WATCHDOG = "_watchdog";
const RESERVED_SESSIONS = new Set([
  RESERVED_SESSION_LEGACY,
  RESERVED_SESSION_WATCHDOG,
]);

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Strict UUID v4 validator. Accepts hex case-insensitively. Rejects
 * reserved sentinels (`_legacy`, `_watchdog`) so a malicious client
 * cannot impersonate the legacy bucket or the watchdog channel.
 */
export function isValidPublicSessionId(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (RESERVED_SESSIONS.has(s)) return false;
  return UUID_V4_RE.test(s);
}

/** Exported for tests — does this string match a reserved internal sentinel? */
export function isReservedSessionId(s: string): boolean {
  return RESERVED_SESSIONS.has(s);
}

/** Per-session cap on retained chat history. */
const HISTORY_CAP_PER_SESSION = 500;
/**
 * Max number of distinct UNPINNED sessions (no live SSE client) we
 * keep in memory. Sessions with at least one live SSE client are
 * pinned and never evicted by the LRU pass — eviction would orphan
 * the open stream and lose state the agent still needs.
 */
const SESSION_LRU_CAP = 100;
/**
 * Hard cap on total sessions (pinned + idle). Codex round 1 MEDIUM:
 * pinned-only growth was unbounded — a token-bearing peer could open
 * arbitrarily many SSE streams and balloon `chatHistory` /
 * `sessionLastSeenMs` / `sseClients`. When `chatHistory.size` would
 * exceed this cap, new SSE subscriptions are rejected with 503 and
 * new send() calls are rejected with 503 — both fail-closed instead
 * of evicting an active client. Idle sessions are still evicted by
 * `evictIdleSessionsIfFull` first; this hard cap is the second wall.
 */
const SESSION_HARD_CAP = 1000;
/** Max simultaneous SSE clients per session (defense in depth). */
const SSE_CLIENTS_PER_SESSION_CAP = 8;
/** Inbox global FIFO cap (pre-existing behavior). */
const INBOX_CAP = 500;

export class HttpBridge {
  private server: http.Server | null = null;
  private config: HttpBridgeConfig;
  private workspace: string;
  private status: StatusProvider;
  private webhookQueue: WebhookEntry[] = [];
  private startedAt: string | null = null;

  // Chat state — per-session privacy partition (Phase 4b).
  // chatHistory is per-session; chatInbox is one global FIFO with
  // sessionId tags so the agent (single process) can fan out replies.
  private chatHistory: Map<string, ChatMessage[]> = new Map();
  private sessionLastSeenMs: Map<string, number> = new Map();
  private chatInbox: ChatMessage[] = [];
  private sseClients: SseClient[] = [];
  private onChatMessage: ChatMessageHandler | null = null;
  private convLogDirCreated = false;

  // Watchdog rate limit: one llm-ping per hour per token.
  // Map of token → array of call timestamps (ms). Pruned on each check.
  private llmPingCallTimes: Map<string, number[]> = new Map();

  constructor(
    config: HttpBridgeConfig,
    workspace: string,
    status: StatusProvider
  ) {
    this.config = config;
    this.workspace = workspace;
    this.status = status;
  }

  /** Start the HTTP server. Returns the actual port. */
  async start(): Promise<number> {
    if (this.server) return this.config.port;

    // Security: require token when binding to non-localhost (accessible from network)
    const isLocalhost = this.config.host === "127.0.0.1" || this.config.host === "localhost";
    if (!isLocalhost && !this.config.token) {
      const err = new Error(
        `[http-bridge] REFUSED to start: host is "${this.config.host}" (network-accessible) but no token is set. ` +
        `Set http.token in agent-config.json to secure the bridge, or use host "127.0.0.1" for localhost-only.`
      );
      console.error(err.message);
      throw err;
    }

    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handleRequest(req, res));

      srv.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            `[http-bridge] Port ${this.config.port} in use — HTTP bridge disabled`
          );
          this.server = null;
          reject(err);
        } else {
          reject(err);
        }
      });

      srv.listen(this.config.port, this.config.host, () => {
        this.server = srv;
        this.startedAt = new Date().toISOString();
        // Resolve the actual bound port (the OS assigns one when config.port=0).
        const addr = srv.address();
        const boundPort =
          addr && typeof addr === "object" ? addr.port : this.config.port;
        this.config.port = boundPort;
        // Restore today's chat history from JSONL on disk
        this.loadHistoryFromDisk();
        this.logSystem(`HTTP bridge started on ${this.config.host}:${boundPort}`);
        console.error(
          `[http-bridge] Listening on http://${this.config.host}:${boundPort}`
        );
        resolve(boundPort);
      });
    });
  }

  /** Stop the HTTP server gracefully. */
  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all SSE clients
    for (const client of this.sseClients) {
      try {
        client.res.end();
      } catch {}
    }
    this.sseClients = [];
    this.logSystem("HTTP bridge stopped");

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.startedAt = null;
        resolve();
      });
    });
  }

  /** Whether the HTTP server is currently running. */
  isRunning(): boolean {
    return this.server !== null;
  }

  // -------------------------------------------------------------------------
  // Webhook API
  // -------------------------------------------------------------------------

  drainWebhooks(limit = 10): WebhookEntry[] {
    return this.webhookQueue.splice(0, limit);
  }

  webhookCount(): number {
    return this.webhookQueue.length;
  }

  // -------------------------------------------------------------------------
  // WebChat API
  // -------------------------------------------------------------------------

  /** Register a handler invoked on every incoming WebChat message. */
  setChatMessageHandler(handler: ChatMessageHandler | null) {
    this.onChatMessage = handler;
  }

  /**
   * Send an agent reply. Phase 4b: requires `sessionId`. Returns
   * `{message, delivered}`:
   *   - `delivered: true` when at least one SSE client for the session
   *     was alive when we wrote.
   *   - `delivered: false` when the session is unknown OR no SSE client
   *     is currently connected. In that case the message is still
   *     appended to the session's history (so a later
   *     `/v1/chat/history?sessionId=X&since=Y` reconnect catches up)
   *     and persisted to JSONL.
   *
   * Reserved sentinels (`_legacy`, `_watchdog`) cannot be replied to
   * — that would let an unauthenticated path inject visible content.
   * Codex pre-impl item 7.
   */
  sendChatReply(
    content: string,
    sessionId: string
  ): { message: ChatMessage; delivered: boolean } {
    // Accept either a real public UUID v4 OR the internal `_watchdog`
    // sentinel (used by the agent in response to watchdog pings; MCP
    // surface is stdio-only so this isn't an external attack vector).
    // `_legacy` is rejected because there's no realistic case where
    // the agent should reply into the legacy bucket.
    const isWatchdog = sessionId === RESERVED_SESSION_WATCHDOG;
    if (!isWatchdog && !isValidPublicSessionId(sessionId)) {
      throw new Error(
        `sendChatReply: sessionId must be a UUID v4 (or _watchdog for the watchdog flow); got ${JSON.stringify(sessionId)}`
      );
    }
    const msg: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      role: "agent",
      content,
      sessionId,
    };
    // Append-then-broadcast ordering: a slow client that misses the
    // SSE event because of subscribe-after-broadcast race can still
    // catch up via `/v1/chat/history?since=<lastSeenId>`. (Codex 1a)
    const accepted = this.appendToSession(sessionId, msg);
    if (!accepted) {
      // Fail-closed: the bridge is at the hard cap with every session
      // pinned. Surface up to the agent so it can back off / report.
      throw new Error(
        "sendChatReply: session capacity exhausted (hard cap reached, no idle session to evict)"
      );
    }
    this.logConversation("out", "agent", msg.content, sessionId);
    const delivered = this.broadcastSse(msg);
    return { message: msg, delivered };
  }

  /** Drain the chat inbox (called by fallback MCP tool). */
  drainChatInbox(limit = 20): ChatMessage[] {
    return this.chatInbox.splice(0, limit);
  }

  /** Peek at chat inbox size. */
  chatInboxCount(): number {
    return this.chatInbox.length;
  }

  /** Get count of connected SSE clients across all sessions. */
  sseClientCount(): number {
    return this.sseClients.length;
  }

  /** Get count of distinct in-memory sessions (for status/testing). */
  sessionCount(): number {
    return this.chatHistory.size;
  }

  // -------------------------------------------------------------------------
  // Session storage (Phase 4b)
  // -------------------------------------------------------------------------

  /**
   * Append `msg` to its session's history bucket. Allocates the bucket
   * on first use. Touches LRU. Caps the bucket. Triggers idle-LRU
   * eviction if total session count exceeds the cap.
   *
   * Returns `false` when the hard cap (`SESSION_HARD_CAP`) is reached
   * AND the new bucket would be a fresh allocation AND no idle session
   * is available to evict. The caller is expected to surface this as
   * 503 to the HTTP client. Existing buckets are never refused.
   */
  private appendToSession(sessionId: string, msg: ChatMessage): boolean {
    let bucket = this.chatHistory.get(sessionId);
    if (!bucket) {
      // New session. Run idle eviction first. Reserved sentinels
      // (`_legacy`, `_watchdog`) bypass the hard cap because they're
      // internal infrastructure; refusing them would silently drop
      // watchdog probes or legacy log replay. For real sessions, if
      // we still can't fit because every real session is pinned,
      // refuse. Codex round 5: count REAL sessions only against the
      // hard cap so a sentinel bucket can't squeeze user budget.
      this.evictIdleSessionsIfFull();
      if (
        !RESERVED_SESSIONS.has(sessionId) &&
        this.realSessionCount() >= SESSION_HARD_CAP
      ) {
        return false;
      }
      bucket = [];
      this.chatHistory.set(sessionId, bucket);
    }
    bucket.push(msg);
    if (bucket.length > HISTORY_CAP_PER_SESSION) {
      bucket.splice(0, bucket.length - HISTORY_CAP_PER_SESSION);
    }
    this.touchSession(sessionId);
    this.evictIdleSessionsIfFull();
    return true;
  }

  /** Mark a session as recently-touched for LRU. */
  private touchSession(sessionId: string): void {
    this.sessionLastSeenMs.set(sessionId, Date.now());
  }

  /**
   * Count of real (non-sentinel) sessions in chatHistory. The
   * invariant of v6: reserved sentinels (`_legacy`, `_watchdog`) live
   * OUTSIDE the SESSION_LRU_CAP and SESSION_HARD_CAP budgets — they
   * are bookkeeping infrastructure, not user-facing sessions. Codex
   * round 5 MEDIUM.
   */
  private realSessionCount(): number {
    let n = 0;
    for (const sid of this.chatHistory.keys()) {
      if (!RESERVED_SESSIONS.has(sid)) n++;
    }
    return n;
  }

  /**
   * LRU eviction. Pinned sessions (those with at least one live SSE
   * client) are NEVER evicted — that would orphan the open stream and
   * destroy state the agent still needs (Codex item 9). We evict
   * oldest unpinned REAL sessions until `realSessionCount <= SESSION_LRU_CAP`.
   * Sentinels (`_legacy`, `_watchdog`) live outside the budget and
   * are never evicted by this pass (Codex round 5 MEDIUM). If every
   * real session is pinned, we exceed the cap rather than evict an
   * active client; intentional fail-open (memory bounded by
   * SSE-connection count).
   */
  private evictIdleSessionsIfFull(): void {
    if (this.realSessionCount() <= SESSION_LRU_CAP) return;
    const pinned = new Set<string>();
    for (const c of this.sseClients) pinned.add(c.sessionId);

    const candidates: Array<[string, number]> = [];
    for (const [sid, ts] of this.sessionLastSeenMs) {
      if (RESERVED_SESSIONS.has(sid)) continue; // _legacy/_watchdog kept
      if (pinned.has(sid)) continue;
      candidates.push([sid, ts]);
    }
    candidates.sort((a, b) => a[1] - b[1]);

    while (
      this.realSessionCount() > SESSION_LRU_CAP &&
      candidates.length > 0
    ) {
      const [sid] = candidates.shift()!;
      this.chatHistory.delete(sid);
      this.sessionLastSeenMs.delete(sid);
    }
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || "/", `http://${this.config.host}`);
    const method = (req.method || "GET").toUpperCase();
    const pathname = url.pathname;

    // CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // --- Public endpoints (no auth) ---
    if (method === "GET" && pathname === "/health") {
      this.sendJson(res, 200, { status: "ok", uptime: this.startedAt });
      return;
    }

    // --- Watchdog endpoints ---
    // Loopback-only regardless of bind config. Belt-and-suspenders:
    // even if the user misconfigures `http.host: "0.0.0.0"` or tunnels the
    // port, watchdog endpoints reject anything that's not local.
    if (pathname.startsWith("/watchdog/")) {
      if (!this.isLoopbackRequest(req)) {
        this.sendJson(res, 403, { error: "loopback-only" });
        return;
      }
      // Token auth inherits the bridge's config: empty token = localhost trust
      // (same as /health today); set token = Bearer required.
      if (this.config.token && !this.checkAuth(req, url)) {
        this.sendJson(res, 401, { error: "Unauthorized — set Bearer token" });
        return;
      }
      if (method === "GET" && pathname === "/watchdog/mcp-ping") {
        if (!this.status.getWatchdogInfo) {
          this.sendJson(res, 503, {
            error: "watchdog probe not wired — server.ts did not provide getWatchdogInfo",
          });
          return;
        }
        try {
          this.sendJson(res, 200, this.status.getWatchdogInfo());
        } catch (err) {
          this.sendJson(res, 500, {
            error: "watchdog probe failed",
            message: String((err as Error).message || err),
          });
        }
        return;
      }
      if (method === "POST" && pathname === "/watchdog/llm-ping") {
        this.handleLlmPing(req, res);
        return;
      }
      this.sendJson(res, 404, {
        error: "Not found",
        watchdogEndpoints: ["GET /watchdog/mcp-ping", "POST /watchdog/llm-ping"],
      });
      return;
    }

    // WebChat UI — auth-gated when token is set (prevents open access on 0.0.0.0)
    if (method === "GET" && (pathname === "/" || pathname === "/chat" || pathname === "/chat.html")) {
      if (this.config.token && !this.checkAuth(req, url)) {
        this.sendJson(res, 401, {
          error: "Unauthorized — add ?token=YOUR_TOKEN to the URL",
        });
        return;
      }
      this.serveChatHtml(res);
      return;
    }

    // --- Auth-gated endpoints ---
    if (this.config.token && !this.checkAuth(req, url)) {
      this.sendJson(res, 401, { error: "Unauthorized — set Bearer token" });
      return;
    }

    // Route
    if (method === "GET" && pathname === "/v1/status") {
      this.handleStatus(res);
    } else if (method === "GET" && pathname === "/v1/webhooks") {
      this.handleDrainWebhooks(res, url);
    } else if (method === "POST" && pathname === "/v1/webhook") {
      this.handleIncomingWebhook(req, res);
    } else if (method === "GET" && pathname === "/v1/skills") {
      this.handleListSkills(res);
    } else if (method === "POST" && pathname === "/v1/chat/send") {
      this.handleChatSend(req, res);
    } else if (method === "GET" && pathname === "/v1/chat/history") {
      this.handleChatHistory(res, url);
    } else if (method === "GET" && pathname === "/v1/chat/stream") {
      this.handleChatStream(req, res);
    } else {
      this.sendJson(res, 404, {
        error: "Not found",
        endpoints: [
          "GET  /",
          "GET  /health",
          "GET  /v1/status",
          "GET  /v1/skills",
          "POST /v1/webhook",
          "GET  /v1/webhooks",
          "POST /v1/chat/send",
          "GET  /v1/chat/history",
          "GET  /v1/chat/stream (SSE)",
          "GET  /watchdog/mcp-ping (loopback-only)",
        ],
      });
    }
  }

  // --- Endpoint handlers ---

  private serveChatHtml(res: http.ServerResponse) {
    // Resolve from PLUGIN_ROOT (set when MCP server starts) or fall back to this file's dir
    const pluginRoot =
      process.env.CLAUDE_PLUGIN_ROOT ||
      path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const htmlPath = path.join(pluginRoot, "static", "chat.html");

    try {
      const html = fs.readFileSync(htmlPath, "utf-8");
      res.writeHead(200, {
        ...corsHeaders(),
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(html),
        "Cache-Control": "no-cache",
      });
      res.end(html);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`WebChat UI not found at ${htmlPath}. Reinstall the plugin.`);
    }
  }

  private handleStatus(res: http.ServerResponse) {
    const identity = this.status.getIdentity();
    const memStats = this.status.getMemoryStats();
    const config = this.status.getConfig();

    this.sendJson(res, 200, {
      agent: {
        identity,
        workspace: this.workspace,
        startedAt: this.startedAt,
      },
      memory: memStats,
      http: {
        port: this.config.port,
        host: this.config.host,
        webhookQueueSize: this.webhookQueue.length,
        chatInboxSize: this.chatInbox.length,
        sseClients: this.sseClients.length,
        chatLogPath: this.convLogsDir,
      },
      config: {
        memoryBackend: config.memory?.backend ?? "builtin",
        citations: config.memory?.citations ?? "auto",
      },
    });
  }

  private handleListSkills(res: http.ServerResponse) {
    const skillsDir = path.join(this.workspace, "skills");
    const skills: Array<{ name: string; description: string }> = [];

    try {
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs.readdirSync(skillsDir, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const match = content.match(
              /^---\s*\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/m
            );
            skills.push({
              name: entry.name,
              description: match?.[1]?.trim() ?? "(no description)",
            });
          } catch {
            skills.push({ name: entry.name, description: "(unreadable)" });
          }
        }
      }
    } catch {}

    this.sendJson(res, 200, { skills, count: skills.length });
  }

  private handleDrainWebhooks(res: http.ServerResponse, url: URL) {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 100);
    const entries = this.drainWebhooks(limit);
    this.sendJson(res, 200, { entries, remaining: this.webhookQueue.length });
  }

  private handleIncomingWebhook(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");

      const entry: WebhookEntry = {
        id: `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        method: req.method || "POST",
        path: req.url || "/v1/webhook",
        headers: {
          "content-type": req.headers["content-type"],
          "x-webhook-source": req.headers["x-webhook-source"] as string,
        },
        body: body.slice(0, 64_000),
      };

      if (this.webhookQueue.length >= 1000) {
        this.webhookQueue.shift();
      }
      this.webhookQueue.push(entry);

      this.sendJson(res, 202, {
        accepted: true,
        id: entry.id,
        queueSize: this.webhookQueue.length,
      });
    });
  }

  private handleChatSend(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let content = "";
      let sessionId = "";
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        content = String(parsed.message || parsed.content || "").trim();
        sessionId = String(parsed.sessionId || "");
      } catch {
        this.sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      if (!isValidPublicSessionId(sessionId)) {
        // 400 (not 200 with empty echo) so a broken client doesn't silently
        // think it's connected. Codex pre-impl 1b/8.
        this.sendJson(res, 400, {
          error: "missing or invalid sessionId",
          hint: "send a UUID v4 in body.sessionId; clear localStorage and reload if upgrading",
        });
        return;
      }

      if (!content) {
        this.sendJson(res, 400, { error: "Empty message" });
        return;
      }

      if (content.length > 32_000) {
        this.sendJson(res, 413, { error: "Message too large (32KB max)" });
        return;
      }

      const msg: ChatMessage = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ts: new Date().toISOString(),
        role: "user",
        content,
        sessionId,
      };

      // Append to per-session history BEFORE broadcast so a slow client
      // missing the SSE event can catch up via /v1/chat/history?since=.
      // The hard-cap branch here defends against a hostile token holder
      // sending from N+1 unique sessionIds; we refuse rather than evict
      // a pinned session.
      const accepted = this.appendToSession(sessionId, msg);
      if (!accepted) {
        this.sendJson(res, 503, {
          error: "session capacity exhausted; retry later",
        });
        return;
      }
      this.logConversation("in", "webchat-user", msg.content, sessionId);
      if (this.chatInbox.length >= INBOX_CAP) this.chatInbox.shift();
      this.chatInbox.push(msg);

      // Echo only to SSE clients in the same session — never broadcast
      // to other sessions (privacy partition).
      this.broadcastSse(msg);

      // Fire handler (channel-style notification into MCP). Sessionid
      // travels on the message so the agent can pass it back to
      // webchat_reply unchanged.
      if (this.onChatMessage) {
        try {
          Promise.resolve(this.onChatMessage(msg)).catch(() => {});
        } catch {}
      }

      this.sendJson(res, 202, { accepted: true, id: msg.id });
    });
  }

  private handleChatHistory(res: http.ServerResponse, url: URL) {
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!isValidPublicSessionId(sessionId)) {
      this.sendJson(res, 400, {
        error: "missing or invalid sessionId",
        hint: "?sessionId=<uuid-v4>",
      });
      return;
    }
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const since = url.searchParams.get("since");

    const bucket = this.chatHistory.get(sessionId) ?? [];
    let entries = bucket;
    if (since) {
      const idx = entries.findIndex((m) => m.id === since);
      if (idx >= 0) entries = entries.slice(idx + 1);
    }

    entries = entries.slice(-limit);
    // Only touch when the bucket actually exists. Codex round 2 MEDIUM #1:
    // an unauthenticated-but-tokened peer hitting many random UUIDs would
    // otherwise grow `sessionLastSeenMs` unboundedly without ever creating
    // `chatHistory` entries (so the hard cap wouldn't catch it).
    if (this.chatHistory.has(sessionId)) this.touchSession(sessionId);
    // 200 with empty entries when sessionId is valid-but-unknown (new
    // tab, post-LRU-eviction). 400 already returned above for invalid.
    this.sendJson(res, 200, { entries, total: bucket.length });
  }

  private handleChatStream(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const url = new URL(req.url || "/", `http://${this.config.host}`);
    const sessionId = url.searchParams.get("sessionId") || "";
    if (!isValidPublicSessionId(sessionId)) {
      this.sendJson(res, 400, {
        error: "missing or invalid sessionId",
        hint: "?sessionId=<uuid-v4>",
      });
      return;
    }

    // Hard-cap check BEFORE writing SSE headers (sendJson must not
    // collide with an already-open text/event-stream response). Codex
    // round 1 MEDIUM. Codex round 5: count REAL sessions only against
    // the hard cap (sentinels live outside budget).
    const isExisting = this.chatHistory.has(sessionId);
    if (!isExisting) {
      this.evictIdleSessionsIfFull();
      if (this.realSessionCount() >= SESSION_HARD_CAP) {
        this.sendJson(res, 503, {
          error: "session capacity exhausted; close idle tabs or retry later",
        });
        return;
      }
    }
    // Defense in depth: per-session SSE-client cap.
    const sameSessionClients = this.sseClients.filter(
      (c) => c.sessionId === sessionId
    ).length;
    if (sameSessionClients >= SSE_CLIENTS_PER_SESSION_CAP) {
      this.sendJson(res, 503, {
        error: "too many SSE clients for this session",
      });
      return;
    }

    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client: SseClient = { id: clientId, sessionId, res };
    this.sseClients.push(client);
    // Touch + ensure bucket exists so a connect-then-history fetch
    // from a fresh client returns 200 with empty entries (rather than
    // appearing to evict the just-created session on the next LRU pass).
    if (!this.chatHistory.has(sessionId)) this.chatHistory.set(sessionId, []);
    this.touchSession(sessionId);

    // Initial hello event — clientId is opaque, no cross-session info leaks.
    res.write(`event: hello\ndata: ${JSON.stringify({ clientId })}\n\n`);

    // Heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 20_000);

    // Clean up on disconnect — filter by object identity (Codex item 6)
    // so a session reusing the clientId space (extremely unlikely but
    // possible across PID-reuse-style restarts mid-test) doesn't drop
    // the wrong client.
    req.on("close", () => {
      clearInterval(heartbeat);
      this.sseClients = this.sseClients.filter((c) => c !== client);
    });
  }

  // -------------------------------------------------------------------------
  // Conversation logging — dual format (JSONL + Markdown)
  // Mirrors the WhatsApp plugin's logConversation() approach.
  // -------------------------------------------------------------------------

  /** Base directory for webchat logs. */
  private get convLogsDir(): string {
    return path.join(this.workspace, ".webchat", "logs", "conversations");
  }

  /** System log path. */
  private get systemLogPath(): string {
    return path.join(this.workspace, ".webchat", "logs", "system.log");
  }

  /** Create .webchat/logs/conversations/ directory lazily on first write. */
  private ensureConvLogDir(): void {
    if (this.convLogDirCreated) return;
    try {
      fs.mkdirSync(this.convLogsDir, { recursive: true });
      this.convLogDirCreated = true;
    } catch {
      // If it already exists that's fine; flag it so we don't retry
      if (fs.existsSync(this.convLogsDir)) this.convLogDirCreated = true;
    }
  }

  /**
   * Log a conversation event in dual format (JSONL + Markdown).
   * Matches the WhatsApp plugin's logConversation() signature.
   */
  private logConversation(
    direction: "in" | "out",
    user: string,
    text: string,
    sessionId: string,
    meta?: Record<string, any>
  ): void {
    try {
      this.ensureConvLogDir();
      const ts = new Date().toISOString();
      const date = ts.slice(0, 10);

      // JSONL — one structured JSON per line
      const jsonLine =
        JSON.stringify({ ts, direction, user, text, channel: "webchat", sessionId, ...meta }) +
        "\n";
      fs.appendFileSync(path.join(this.convLogsDir, `${date}.jsonl`), jsonLine, "utf-8");

      // Markdown — human-readable
      const sidShort = sessionId.slice(0, 8);
      const arrow = direction === "in" ? "\u2190" : "\u2192";
      const mdLine = `**${arrow} ${user}** (${ts.slice(11, 19)}, s:${sidShort}): ${text}\n\n`;
      fs.appendFileSync(path.join(this.convLogsDir, `${date}.md`), mdLine, "utf-8");
    } catch {
      // Logging is best-effort — never crash the chat for a log write failure
    }
  }

  /** Write a system-level log entry. */
  private logSystem(message: string): void {
    try {
      this.ensureConvLogDir();
      const ts = new Date().toISOString();
      const line = `[${ts}] ${message}\n`;
      fs.appendFileSync(this.systemLogPath, line, "utf-8");
    } catch {
      // Best-effort — never crash for a log failure
    }
  }

  /**
   * Load today's conversation history from JSONL on disk.
   * JSONL is the structured source of truth (not MD).
   *
   * Phase 4b: entries with a valid public sessionId go into their
   * proper session bucket. Entries without (pre-Phase-4b logs) or
   * with reserved/invalid sessionIds get bucketed into the internal
   * `_legacy` partition. `_legacy` is never accepted from any public
   * surface so a fresh client never sees those messages — they're
   * preserved only for the agent's internal continuity.
   */
  private loadHistoryFromDisk(): void {
    try {
      const today = datestamp();
      const jsonlPath = path.join(this.convLogsDir, `${today}.jsonl`);
      if (!fs.existsSync(jsonlPath)) return;
      const raw = fs.readFileSync(jsonlPath, "utf-8");
      const lines = raw.split("\n");

      // Two-pass replay so a JSONL with > SESSION_HARD_CAP distinct
      // sessionIds keeps the NEWEST ones, not the oldest. Codex round
      // 3 MEDIUM: v3's chronological-skip-once-full strategy preserved
      // sessions 0..999 and dropped sessions 1000..1499 (the most
      // recent), causing fresh clients to lose history on restart.
      // Pass 1: parse all lines + collect sessionIds in last-seen order.
      type Parsed = {
        ts: string;
        role: "user" | "agent";
        text: string;
        sessionId: string;
      };
      const parsed: Parsed[] = [];
      const lastSeenIdx = new Map<string, number>();
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          const role: "user" | "agent" =
            entry.direction === "in" ? "user" : "agent";
          const sessionId =
            typeof entry.sessionId === "string" &&
            isValidPublicSessionId(entry.sessionId)
              ? entry.sessionId
              : RESERVED_SESSION_LEGACY;
          const text = entry.text || "";
          if (!text) continue;
          const ts = entry.ts || `${today}T00:00:00.000Z`;
          parsed.push({ ts, role, text, sessionId });
          lastSeenIdx.set(sessionId, parsed.length - 1);
        } catch {
          // Skip malformed lines
        }
      }

      // Determine the set of sessionIds we'll keep. Reserved sentinels
      // always pass and DON'T consume the SESSION_HARD_CAP budget for
      // real sessions (Codex round 4 MEDIUM #2). For real sessions
      // take the most recent SESSION_HARD_CAP distinct ones by
      // last-seen index.
      const allowed = new Set<string>();
      for (const sid of RESERVED_SESSIONS) {
        if (lastSeenIdx.has(sid)) allowed.add(sid);
      }
      const realSessions: Array<[string, number]> = [];
      for (const [sid, idx] of lastSeenIdx) {
        if (RESERVED_SESSIONS.has(sid)) continue;
        realSessions.push([sid, idx]);
      }
      realSessions.sort((a, b) => b[1] - a[1]); // newest last-seen first
      let realAdmitted = 0;
      for (let i = 0; i < realSessions.length && realAdmitted < SESSION_HARD_CAP; i++) {
        allowed.add(realSessions[i][0]);
        realAdmitted++;
      }

      // Pass 2: insert messages for allowed sessionIds only, preserving
      // within-session chronological order. We seed sessionLastSeenMs
      // from the parsed lastSeenIdx (a monotonically increasing
      // integer) instead of Date.now() during replay — Codex round 4
      // MEDIUM #1: same-millisecond Date.now() ties break LRU
      // determinism for hot disks. Index values are << any real
      // post-replay Date.now() so any later runtime touch will still
      // dominate.
      let idx = 0;
      for (const m of parsed) {
        if (!allowed.has(m.sessionId)) continue;
        const msg: ChatMessage = {
          id: `log_${today}_${idx++}`,
          ts: m.ts,
          role: m.role,
          content: m.text,
          sessionId: m.sessionId,
        };
        let bucket = this.chatHistory.get(m.sessionId);
        if (!bucket) {
          bucket = [];
          this.chatHistory.set(m.sessionId, bucket);
        }
        bucket.push(msg);
        if (bucket.length > HISTORY_CAP_PER_SESSION) {
          bucket.splice(0, bucket.length - HISTORY_CAP_PER_SESSION);
        }
        // Deterministic LRU seed: the parsed array index of the last
        // entry for this session.
        this.sessionLastSeenMs.set(m.sessionId, lastSeenIdx.get(m.sessionId)!);
      }

      // Final idle-LRU pass. Pinned check is a no-op at startup (no SSE
      // clients yet), so this trims oldest by last-seen-ms until size
      // <= SESSION_LRU_CAP. With the freshest sessions kept above, the
      // LRU will retain the most-recently-active.
      this.evictIdleSessionsIfFull();
    } catch {
      // Best-effort — if log file is corrupted, just start fresh
    }
  }

  // --- Helpers ---

  /**
   * Broadcast `msg` ONLY to SSE clients in its session. Returns true
   * iff at least one live client received the payload — used by
   * `sendChatReply` to surface `delivered:false` when the agent
   * replies after the browser disconnected. Privacy: a per-session
   * filter keeps the payload from ever reaching another browser.
   */
  private broadcastSse(msg: ChatMessage): boolean {
    const payload = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
    const stale: SseClient[] = [];
    let delivered = false;
    for (const client of this.sseClients) {
      if (client.sessionId !== msg.sessionId) continue;
      try {
        client.res.write(payload);
        delivered = true;
      } catch {
        stale.push(client);
      }
    }
    if (stale.length) {
      // Object-identity filter — same as connect-side cleanup. Codex item 6.
      this.sseClients = this.sseClients.filter((c) => !stale.includes(c));
    }
    return delivered;
  }

  /**
   * True iff the request arrived over the loopback interface. Used by
   * `/watchdog/*` to refuse non-local probes even when the bridge is
   * (mis)configured to bind a public interface. Delegates to the pure
   * `isLoopbackAddress` helper so the classification rule can be
   * unit-tested in isolation.
   */
  private isLoopbackRequest(req: http.IncomingMessage): boolean {
    return isLoopbackAddress(req.socket.remoteAddress);
  }

  /**
   * POST /watchdog/llm-ping — injects a canned prompt as a user chat
   * message and polls chatHistory for an agent response matching
   * `PONG-<nonce>`. Returns 200 on match, 504 on timeout. Rate-limited
   * at 1/hour per token to prevent token drain. Requires http.token to
   * be set (defense in depth beyond loopback-only).
   *
   * For this endpoint to work with a real agent, the agent's CLAUDE.md
   * should include an instruction to recognize `__watchdog_ping__`
   * messages and reply via `webchat_reply("PONG-<nonce>")`. Tests
   * bypass the agent by calling `sendChatReply` directly.
   */
  private handleLlmPing(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // Defense in depth: llm-ping requires an http.token even though the
    // route is already loopback-only. A rogue local process could still
    // drain LLM tokens without this.
    if (!this.config.token) {
      this.sendJson(res, 403, {
        error: "llm-ping requires http.token to be set",
      });
      return;
    }

    // Rate limit: 1 call per hour per token.
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const prior = (this.llmPingCallTimes.get(this.config.token) || []).filter(
      (t) => t >= now - windowMs
    );
    if (prior.length >= 1) {
      const retryAfterMs = prior[0] + windowMs - now;
      const retryAfterS = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader("Retry-After", String(retryAfterS));
      this.sendJson(res, 429, {
        error: "rate-limited",
        retry_after_s: retryAfterS,
      });
      return;
    }
    prior.push(now);
    this.llmPingCallTimes.set(this.config.token, prior);

    // Collect optional body with timeout_ms override (clamp to [1s, 60s])
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      let timeoutMs = 30_000;
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        if (body.trim().length > 0) {
          const parsed = JSON.parse(body);
          if (typeof parsed.timeout_ms === "number") {
            timeoutMs = Math.max(1000, Math.min(60_000, parsed.timeout_ms));
          }
        }
      } catch {
        // Ignore invalid bodies; keep default
      }

      const nonce = randomBytes(4).toString("hex");
      const expected = `PONG-${nonce}`;
      const startTime = Date.now();
      const pingMsg: ChatMessage = {
        id: `wdping-${nonce}`,
        ts: new Date().toISOString(),
        role: "user",
        content: `__watchdog_ping__ Respond immediately with just \`${expected}\` (no other text).`,
        // Internal sentinel — never accepted on public surfaces. Keeps
        // the watchdog's traffic out of every real client's history.
        sessionId: RESERVED_SESSION_WATCHDOG,
      };

      // Inject like a webchat message to trigger agent processing.
      // Goes into the dedicated `_watchdog` bucket so a real session's
      // history endpoint never sees it. INBOX_CAP enforcement mirrors
      // handleChatSend (Codex round 2 LOW #3) so repeated probes can't
      // grow the inbox past the documented cap when not drained.
      if (this.chatInbox.length >= INBOX_CAP) this.chatInbox.shift();
      this.chatInbox.push(pingMsg);
      this.appendToSession(RESERVED_SESSION_WATCHDOG, pingMsg);
      if (this.onChatMessage) {
        try {
          await this.onChatMessage(pingMsg);
        } catch {}
      }

      // Poll the watchdog bucket for a matching agent response that arrived
      // after our ping was injected.
      const deadline = startTime + timeoutMs;
      while (Date.now() < deadline) {
        const wdBucket = this.chatHistory.get(RESERVED_SESSION_WATCHDOG) ?? [];
        const match = wdBucket.find(
          (m) =>
            m.role === "agent" &&
            m.content.includes(expected) &&
            new Date(m.ts).getTime() >= startTime
        );
        if (match) {
          this.sendJson(res, 200, {
            ok: true,
            nonce,
            latency_ms: Date.now() - startTime,
            response: match.content.slice(0, 200),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      this.sendJson(res, 504, {
        ok: false,
        nonce,
        error: "timeout",
        timeout_ms: timeoutMs,
        elapsed_ms: Date.now() - startTime,
      });
    });
  }

  private checkAuth(req: http.IncomingMessage, url?: URL): boolean {
    // Bearer header
    const auth = req.headers.authorization;
    if (auth) {
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      if (token === this.config.token) return true;
    }
    // Query string fallback (useful for SSE/EventSource which can't set headers)
    if (url) {
      const qToken = url.searchParams.get("token");
      if (qToken === this.config.token) return true;
    }
    return false;
  }

  private sendJson(
    res: http.ServerResponse,
    statusCode: number,
    data: unknown
  ) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
      ...corsHeaders(),
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
