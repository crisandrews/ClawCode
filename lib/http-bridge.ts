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
}

type ChatMessageHandler = (msg: ChatMessage) => void | Promise<void>;

interface SseClient {
  id: string;
  res: http.ServerResponse;
}

export class HttpBridge {
  private server: http.Server | null = null;
  private config: HttpBridgeConfig;
  private workspace: string;
  private status: StatusProvider;
  private webhookQueue: WebhookEntry[] = [];
  private startedAt: string | null = null;

  // Chat state
  private chatInbox: ChatMessage[] = [];
  private chatHistory: ChatMessage[] = [];
  private sseClients: SseClient[] = [];
  private onChatMessage: ChatMessageHandler | null = null;
  private convLogDirCreated = false;

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
        // Restore today's chat history from JSONL on disk
        this.loadHistoryFromDisk();
        this.logSystem(`HTTP bridge started on ${this.config.host}:${this.config.port}`);
        console.error(
          `[http-bridge] Listening on http://${this.config.host}:${this.config.port}`
        );
        resolve(this.config.port);
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

  /** Push an agent reply to all connected SSE clients AND chat history. */
  sendChatReply(content: string): ChatMessage {
    const msg: ChatMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      role: "agent",
      content,
    };
    this.chatHistory.push(msg);
    this.capHistory();
    this.logConversation("out", "agent", msg.content);
    this.broadcastSse(msg);
    return msg;
  }

  /** Drain the chat inbox (called by fallback MCP tool). */
  drainChatInbox(limit = 20): ChatMessage[] {
    return this.chatInbox.splice(0, limit);
  }

  /** Peek at chat inbox size. */
  chatInboxCount(): number {
    return this.chatInbox.length;
  }

  /** Get count of connected SSE clients (for testing/status). */
  sseClientCount(): number {
    return this.sseClients.length;
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
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        content = String(parsed.message || parsed.content || "").trim();
      } catch {
        this.sendJson(res, 400, { error: "Invalid JSON body" });
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
      };

      // Store for history and inbox
      this.chatHistory.push(msg);
      this.capHistory();
      this.logConversation("in", "webchat-user", msg.content);
      if (this.chatInbox.length >= 500) this.chatInbox.shift();
      this.chatInbox.push(msg);

      // Echo to SSE clients so the UI confirms the send
      this.broadcastSse(msg);

      // Fire handler (channel-style notification into MCP)
      if (this.onChatMessage) {
        try {
          Promise.resolve(this.onChatMessage(msg)).catch(() => {});
        } catch {}
      }

      this.sendJson(res, 202, { accepted: true, id: msg.id });
    });
  }

  private handleChatHistory(res: http.ServerResponse, url: URL) {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const since = url.searchParams.get("since");

    let entries = this.chatHistory;
    if (since) {
      const idx = entries.findIndex((m) => m.id === since);
      if (idx >= 0) entries = entries.slice(idx + 1);
    }

    entries = entries.slice(-limit);
    this.sendJson(res, 200, { entries, total: this.chatHistory.length });
  }

  private handleChatStream(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    res.writeHead(200, {
      ...corsHeaders(),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const client: SseClient = { id: clientId, res };
    this.sseClients.push(client);

    // Initial hello event
    res.write(`event: hello\ndata: ${JSON.stringify({ clientId })}\n\n`);

    // Heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 20_000);

    // Clean up on disconnect
    req.on("close", () => {
      clearInterval(heartbeat);
      this.sseClients = this.sseClients.filter((c) => c.id !== clientId);
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
  private logConversation(direction: "in" | "out", user: string, text: string, meta?: Record<string, any>): void {
    try {
      this.ensureConvLogDir();
      const ts = new Date().toISOString();
      const date = ts.slice(0, 10);

      // JSONL — one structured JSON per line
      const jsonLine = JSON.stringify({ ts, direction, user, text, channel: "webchat", ...meta }) + "\n";
      fs.appendFileSync(path.join(this.convLogsDir, `${date}.jsonl`), jsonLine, "utf-8");

      // Markdown — human-readable
      const arrow = direction === "in" ? "\u2190" : "\u2192";
      const mdLine = `**${arrow} ${user}** (${ts.slice(11, 19)}): ${text}\n\n`;
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
   */
  private loadHistoryFromDisk(): void {
    try {
      const today = datestamp();
      const jsonlPath = path.join(this.convLogsDir, `${today}.jsonl`);
      if (!fs.existsSync(jsonlPath)) return;
      const raw = fs.readFileSync(jsonlPath, "utf-8");
      const lines = raw.split("\n");
      let idx = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          const role: "user" | "agent" = entry.direction === "in" ? "user" : "agent";
          const msg: ChatMessage = {
            id: `log_${today}_${idx++}`,
            ts: entry.ts || `${today}T00:00:00.000Z`,
            role,
            content: entry.text || "",
          };
          if (msg.content) {
            this.chatHistory.push(msg);
          }
        } catch {
          // Skip malformed lines
        }
      }
      this.capHistory();
    } catch {
      // Best-effort — if log file is corrupted, just start fresh
    }
  }

  // --- Helpers ---

  private broadcastSse(msg: ChatMessage) {
    const payload = `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
    const stale: string[] = [];
    for (const client of this.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        stale.push(client.id);
      }
    }
    if (stale.length) {
      this.sseClients = this.sseClients.filter((c) => !stale.includes(c.id));
    }
  }

  private capHistory() {
    if (this.chatHistory.length > 500) {
      this.chatHistory = this.chatHistory.slice(-500);
    }
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
