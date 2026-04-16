/**
 * Paperclip Bridge — HTTP client for the Paperclip control plane API.
 *
 * Reads credentials from environment variables (injected by Paperclip heartbeat)
 * or from agent-config.json. Provides typed methods for the most common
 * operations: inbox, issues, comments, agents, wakeups.
 *
 * All methods are async and throw on HTTP errors with structured messages.
 */

import { loadConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface PaperclipConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string;
  agentId?: string;
  runId?: string;
  /** Auto-open a task_ledger entry when a Paperclip heartbeat starts. */
  autoSync?: boolean;
}

export function resolvePaperclipConfig(workspace: string): PaperclipConfig | null {
  // Priority: env vars (set by Paperclip heartbeat) > agent-config.json
  const env = {
    apiUrl: process.env.PAPERCLIP_API_URL || process.env.PAPERCLIP_BASE_URL,
    apiKey: process.env.PAPERCLIP_API_KEY || process.env.PAPERCLIP_TOKEN,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    agentId: process.env.PAPERCLIP_AGENT_ID,
    runId: process.env.PAPERCLIP_RUN_ID || process.env.X_PAPERCLIP_RUN_ID,
  };

  if (env.apiUrl && env.apiKey && env.companyId) {
    return {
      apiUrl: env.apiUrl.replace(/\/+$/, ""),
      apiKey: env.apiKey,
      companyId: env.companyId,
      agentId: env.agentId || undefined,
      runId: env.runId || undefined,
      autoSync: true,
    };
  }

  // Fall back to agent-config.json
  try {
    const cfg = loadConfig(workspace) as any;
    const pc = cfg.paperclip;
    if (pc?.apiUrl && pc?.apiKey && pc?.companyId) {
      return {
        apiUrl: String(pc.apiUrl).replace(/\/+$/, ""),
        apiKey: String(pc.apiKey),
        companyId: String(pc.companyId),
        agentId: pc.agentId ? String(pc.agentId) : undefined,
        autoSync: pc.autoSync !== false,
      };
    }
  } catch {}

  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function request(
  cfg: PaperclipConfig,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const url = `${cfg.apiUrl}/api${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Company-Id": cfg.companyId,
    "Content-Type": "application/json",
  };
  if (cfg.runId) {
    headers["X-Paperclip-Run-Id"] = cfg.runId;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// API methods
// ---------------------------------------------------------------------------

export class PaperclipClient {
  constructor(private cfg: PaperclipConfig) {}

  // -- Identity
  async me(): Promise<any> {
    return request(this.cfg, "GET", "/agents/me");
  }

  // -- Inbox
  async inbox(): Promise<any> {
    return request(this.cfg, "GET", "/agents/me/inbox-lite");
  }

  // -- Issues
  async listIssues(params?: {
    status?: string;
    assigneeId?: string;
    projectId?: string;
    limit?: number;
  }): Promise<any> {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.assigneeId) q.set("assigneeId", params.assigneeId);
    if (params?.projectId) q.set("projectId", params.projectId);
    if (params?.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return request(
      this.cfg,
      "GET",
      `/companies/${this.cfg.companyId}/issues${qs ? "?" + qs : ""}`
    );
  }

  async getIssue(idOrIdentifier: string): Promise<any> {
    return request(this.cfg, "GET", `/issues/${idOrIdentifier}`);
  }

  async createIssue(data: {
    title: string;
    description?: string;
    projectId?: string;
    priority?: string;
    labels?: string[];
  }): Promise<any> {
    return request(
      this.cfg,
      "POST",
      `/companies/${this.cfg.companyId}/issues`,
      data
    );
  }

  async updateIssue(
    id: string,
    data: { title?: string; status?: string; priority?: string; description?: string }
  ): Promise<any> {
    return request(this.cfg, "PATCH", `/issues/${id}`, data);
  }

  async checkoutIssue(issueId: string, agentId?: string): Promise<any> {
    return request(this.cfg, "POST", `/issues/${issueId}/checkout`, {
      agentId: agentId || this.cfg.agentId,
    });
  }

  // -- Comments
  async listComments(issueId: string, limit = 20): Promise<any> {
    return request(
      this.cfg,
      "GET",
      `/issues/${issueId}/comments?limit=${limit}`
    );
  }

  async addComment(issueId: string, body: string): Promise<any> {
    return request(this.cfg, "POST", `/issues/${issueId}/comments`, { body });
  }

  // -- Agents
  async listAgents(): Promise<any> {
    return request(
      this.cfg,
      "GET",
      `/companies/${this.cfg.companyId}/agents`
    );
  }

  async getAgent(id: string): Promise<any> {
    return request(this.cfg, "GET", `/agents/${id}`);
  }

  async wakeupAgent(id: string, reason?: string): Promise<any> {
    return request(this.cfg, "POST", `/agents/${id}/wakeup`, {
      reason: reason || "Triggered from ClawCode",
    });
  }

  // -- Heartbeat context
  async heartbeatContext(): Promise<any> {
    if (!this.cfg.runId) return null;
    return request(
      this.cfg,
      "GET",
      `/heartbeat-runs/${this.cfg.runId}`
    );
  }

  getConfig(): PaperclipConfig {
    return { ...this.cfg };
  }
}
