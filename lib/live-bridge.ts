import http from "node:http";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { LiveStore } from "./live-store.ts";
import { LIVE_TOOLS } from "./live-tools.ts";
import { normalizeLeaderPolicy, type LeaderPolicy } from "../hooks/live-leader-policy.mjs";
import { LIVE_CAPABILITIES, TERMINAL, type LiveState, type Snapshot, type LiveEvent, type Task, type LiveInput, type LiveCommand, type HostBinding, type ExternalInputProvenance, type LeaderPolicyState } from "./live-types.ts";
export { LIVE_TOOLS, LIVE_INSTRUCTIONS } from "./live-tools.ts";

export interface LiveBridgeOptions {
  workspace: string; dataDir: string; token: string; port?: number;
  agent: { id: string; name: string };
  deliver: (message: { content: string; meta: Record<string, string> }) => Promise<void>;
  observeHooks?: boolean; eventRetention?: number;
  leaderPolicy?: LeaderPolicy;
  onHostBinding?: (host: HostBinding) => void;
  listExternalInputCandidates?: () => Array<{ id: string; sourceChannel: "whatsapp"; occurredAt: string; label: string }> | Promise<Array<{ id: string; sourceChannel: "whatsapp"; occurredAt: string; label: string }>>;
  resolveExternalInput?: (candidateId: string) => ExternalInputProvenance | null | Promise<ExternalInputProvenance | null>;
}
export class LiveError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const now = () => new Date().toISOString();
const own = (o: object, key: string) => Object.hasOwn(o, key);
const hash = (s: string) => createHash("sha256").update(s).digest();
const inputKey = (id: string, revision: number) => `${id}@${revision}`;
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LiveError(400, "Expected object");
  return value as Record<string, any>;
}
function string(value: unknown, label: string, max = 16000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new LiveError(400, `Invalid ${label}`);
  return value;
}
function identifier(value: unknown, label = "id"): string {
  const text = string(value, label, 180);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) || ["__proto__", "constructor", "prototype"].includes(text)) throw new LiveError(400, `Invalid ${label}`);
  return text;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new LiveError(400, "Invalid revision");
  return Number(value);
}
function fingerprint(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}
function optionalId(value: unknown, label: string): string | undefined { return value === undefined ? undefined : identifier(value, label); }
const taskStates = new Set(["queued", "running", "waiting_permission", "completed", "failed", "cancelled", "interrupted"]);

/** Opt-in adapter around ONE existing leader. It never spawns an agent. */
export class LiveBridge {
  private readonly store: LiveStore;
  private state!: LiveState;
  private readonly server: http.Server;
  private readonly clients = new Map<http.ServerResponse, string>();
  private readonly tokenHash: Buffer;
  private readonly probe = randomUUID();
  private readonly retention: number;
  private ready = false;
  private probeAcknowledged = false;
  private readonly generation = randomUUID();
  private readonly modelCandidates = new Map<string, NonNullable<HostBinding["modelObservation"]>>();
  private running = false;
  private draining = false;
  private sessionId?: string;
  private probeAt = 0;
  private hooksSeen = new Set<string>();
  private mainTools = new Map<string, { phase: "tool"; at: string; toolName?: string }>();
  private exitHandler = () => this.store.close();

  constructor(private readonly options: LiveBridgeOptions) {
    normalizeLeaderPolicy(options.leaderPolicy);
    if (typeof options.token !== "string" || options.token.length < 32) throw new Error("LiveBridge requires an environment bearer token of at least 32 characters");
    if (!path.isAbsolute(options.workspace) || !path.isAbsolute(options.dataDir)) throw new Error("LiveBridge requires absolute workspace and dataDir");
    identifier(options.agent.id, "agent.id"); string(options.agent.name, "agent.name", 120);
    if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) throw new Error("Invalid LiveBridge port");
    this.tokenHash = hash(options.token);
    this.retention = Math.max(8, Math.min(options.eventRetention ?? 1000, 10000));
    this.store = new LiveStore(options.dataDir);
    this.server = http.createServer((req, res) => { void this.route(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      this.json(res, error instanceof LiveError ? error.status : 500, { error: error instanceof LiveError ? error.message : "LiveBridge operation failed" });
    }); });
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.store.acquire();
    try {
      const saved = this.store.load();
      if (saved && (saved.version !== 1 || saved.workspace !== this.options.workspace || !saved.conversation || !Number.isSafeInteger(saved.seq))) throw new Error("LiveBridge state belongs to another workspace or protocol");
      this.state = saved ?? {
        version: 1, workspace: this.options.workspace, seq: 0,
        conversation: { id: randomUUID(), name: this.options.agent.name, owner: "external", workspace: this.options.workspace, status: "starting", messages: [], queuedInputs: 0, capabilities: { ...LIVE_CAPABILITIES } },
        tasks: {}, inputs: {}, commands: {}, attachments: {}, publications: {}, events: [],
      };
      // Migrate v1 stores without pretending their public history proves native
      // session continuity. The operator must accept an unbound legacy store.
      this.state.boundNativeSessionId ??= saved?.conversation.sessionId;
      this.state.bindingRequiredForLegacy ??= !!saved && !this.state.boundNativeSessionId;
      this.state.taskAliases ??= {};
      this.state.operatorActions ??= {};
      this.state.externalInputs ??= {};
      this.state.conversation.capabilities = { ...LIVE_CAPABILITIES, externalInputAdoption: !!this.options.resolveExternalInput && !!this.options.listExternalInputCandidates };
      this.state.host = { generation: this.generation, bindingStatus: "awaiting_session", previousSessionId: this.state.boundNativeSessionId, reason: "Waiting for the current native session's probe hook" };
      this.state.conversation.status = "starting";
      // Connection handles are ephemeral; durable inputs/tasks belong to the
      // logical conversation, not to a transport from a previous process.
      this.state.attachments = {};
      delete this.state.conversation.sessionId;
      delete this.state.conversation.model;
      delete this.state.conversation.activity;
      this.mainTools.clear();
      for (const task of Object.values(this.state.tasks)) if (!TERMINAL.has(task.status)) { task.stale = true; task.controls = { steer: false, cancel: false, resume: false }; }
      this.store.save(this.state);
      await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.options.port ?? 18791, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
      this.running = true;
      process.once("exit", this.exitHandler);
      this.change("connection.started", { channelReady: false }, () => {});
    } catch (error) {
      // Publication can fail after listen succeeds. Release the socket before
      // the lease so a failed startup cannot leave an untracked HTTP writer.
      this.ready = false; this.running = false;
      process.off("exit", this.exitHandler);
      this.server.closeAllConnections();
      await new Promise<void>(resolve => this.server.close(() => resolve()));
      this.store.close(); throw error;
    }
  }
  get port(): number { const a = this.server.address(); return a && typeof a === "object" ? a.port : this.options.port ?? 18791; }
  /** Receipt evidence for the local MCP handshake; never disclose its nonce. */
  get channelHandshakeState() {
    return { running: this.running, acknowledged: this.probeAcknowledged, channelReady: this.ready, bindingStatus: this.state?.host?.bindingStatus };
  }
  async close(): Promise<void> {
    if (!this.running) return;
    this.ready = false;
    this.mainTools.clear();
    try { this.change("connection.closed", { channelReady: false }, s => { s.conversation.status = "offline"; delete s.conversation.activity; }); }
    catch { /* Disk failure must not keep the listener or writer lease alive. */ }
    this.running = false;
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    process.off("exit", this.exitHandler); this.store.close();
  }
  private leaderPolicyState(): LeaderPolicyState {
    const policy = normalizeLeaderPolicy(this.options.leaderPolicy);
    return { configured: policy.enabled, maxConcurrent: policy.maxConcurrent, tools: policy.tools, directToolsAllowed: !policy.enabled || policy.tools === "host_native", hookObserved: false, runtimeConfirmed: false, limitSemantics: "native_spawn_limit", resumedAgentsCounted: false, automaticQueue: false };
  }
  capabilities() {
    return {
      protocolVersion: 1,
      agent: { ...this.options.agent, sessionId: this.sessionId, workspace: this.options.workspace },
      capabilities: { ...LIVE_CAPABILITIES, channelReady: this.ready, inputReceipts: true, hostRecovery: true, taskAliases: true, taskPublications: true, externalInputAdoption: !!this.options.resolveExternalInput && !!this.options.listExternalInputCandidates },
      host: structuredClone(this.state.host),
      leaderPolicy: this.leaderPolicyState(),
      observations: { hooksEnabled: !!this.options.observeHooks, sessionBound: !!this.sessionId, hooksSeen: [...this.hooksSeen] },
      semantics: { cancel: "request_to_leader", steer: "request_to_leader", delivery: "channel_next_turn", uncertainDelivery: "never_automatically_retried" },
    };
  }
  private stateSnapshot(state: LiveState): Snapshot {
    return structuredClone({ conversation: { ...state.conversation, capabilities: { ...state.conversation.capabilities, leaderPolicy: this.leaderPolicyState() } }, tasks: Object.values(state.tasks), approvals: [], inputs: Object.values(state.inputs), commands: Object.values(state.commands), host: state.host, taskAliases: state.taskAliases, sources: Object.values(state.externalInputs ?? {}).map(({ sourceInputId, sourceChannel, adoptedAt }) => ({ sourceInputId, sourceChannel, adoptedAt })) });
  }
  snapshot(): Snapshot { return this.stateSnapshot(this.state); }
  private deriveStatus(state: LiveState): void {
    if (!this.ready || state.host?.bindingStatus !== "verified") { state.conversation.status = state.conversation.status === "offline" ? "offline" : "starting"; return; }
    const inputs = Object.values(state.inputs).filter(input => !input.supersededBy);
    const openInput = inputs.some(input => ["queued", "delivery_uncertain", "transport_written", "acknowledged"].includes(input.status));
    const tasks = Object.values(state.tasks);
    const waiting = tasks.some(task => task.status === "waiting_permission") || inputs.some(input => input.status === "acknowledged" && input.needsInput);
    const openCommand = Object.values(state.commands).some(command => ["queued", "delivery_uncertain", "transport_written", "acknowledged"].includes(command.status));
    state.conversation.status = waiting ? "waiting_permission" : openInput || openCommand || state.conversation.activity || tasks.some(task => !TERMINAL.has(task.status)) ? "working" : "ready";
  }
  /** Call only after the MCP client initialized; a transport write is NOT readiness. */
  async probeChannel(): Promise<void> {
    if (!this.running || this.probeAcknowledged || Date.now() - this.probeAt < 1000) return;
    this.probeAt = Date.now();
    try {
      await this.options.deliver({
        content: `LiveBridge delivery probe. If this notification reached the leader through Channels, call live_ack with probe=${this.probe}. This confirms receipt only; do not start work.`,
        meta: { source: "live_probe", probe: this.probe, conversation_id: this.state.conversation.id },
      });
    } catch { /* Disabled Channels keeps readiness false. Probe can be explicitly retried. */ }
  }

  private change(type: string, data: Record<string, unknown>, mutate: (state: LiveState) => void): LiveEvent {
    const draft = structuredClone(this.state);
    mutate(draft);
    this.deriveStatus(draft);
    draft.conversation.messages = draft.conversation.messages.slice(-300);
    draft.conversation.queuedInputs = Object.values(draft.inputs).filter(i => !i.supersededBy && ["queued", "delivery_uncertain", "transport_written"].includes(i.status)).length;
    const event: LiveEvent = { id: String(++draft.seq), seq: draft.seq, type, conversationId: draft.conversation.id, at: now(), data,
      snapshot: this.stateSnapshot(draft) };
    draft.events.push(event); draft.events = draft.events.slice(-this.retention);
    let retainedBytes = 0;
    for (let i = draft.events.length - 1; i >= 0; i--) {
      retainedBytes += Buffer.byteLength(JSON.stringify(draft.events[i]));
      if (retainedBytes > 4 * 1024 * 1024 && i < draft.events.length - 1) { draft.events = draft.events.slice(i + 1); break; }
    }
    this.store.save(draft); this.state = draft;
    for (const [client] of this.clients) this.writeEvent(client, event);
    return event;
  }
  private writeEvent(res: http.ServerResponse, event: LiveEvent): void {
    // A slow/disconnected UI can replay from durable cursors; never accumulate
    // unbounded buffers or block the leader waiting for a browser.
    if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); this.clients.delete(res); return; }
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  private json(res: http.ServerResponse, code: number, value: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(value));
  }
  private async body(req: http.IncomingMessage): Promise<Record<string, any>> {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new LiveError(415, "Expected application/json");
    req.setEncoding("utf8");
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw new LiveError(413, "Body too large"); }
    try { return object(JSON.parse(raw)); } catch (e) { if (e instanceof LiveError) throw e; throw new LiveError(400, "Invalid JSON"); }
  }
  private attachment(id: string) {
    const attachment = own(this.state.attachments, id) && this.state.attachments[id];
    if (!attachment || !attachment.active) throw new LiveError(404, "Unknown or detached attachment");
    return attachment;
  }
  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.running) throw new LiveError(503, "Bridge starting");
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "") || req.headers.origin) throw new LiveError(403, "Only local server clients are supported");
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !timingSafeEqual(hash(auth.slice(7)), this.tokenHash)) throw new LiveError(401, "Bearer authentication required");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.has("token")) throw new LiveError(400, "Tokens must use the Authorization header");
    const route = url.pathname;
    if (req.method === "GET" && route === "/v1/live/capabilities") { this.json(res, 200, this.capabilities()); return; }
    if (req.method === "POST" && route === "/v1/live/host/recovery") { this.json(res, 200, this.recoverHost(await this.body(req))); return; }
    if (req.method === "GET" && route === "/v1/live/sources/candidates") {
      if (!this.options.listExternalInputCandidates || !this.options.resolveExternalInput) throw new LiveError(422, "External source adoption is unavailable");
      this.json(res, 200, { candidates: await this.options.listExternalInputCandidates() }); return;
    }
    if (req.method === "POST" && route === "/v1/live/sources/adopt") {
      if (!this.options.resolveExternalInput) throw new LiveError(422, "External source adoption is unavailable");
      const body = await this.body(req); this.requireGeneration(body.expectedGeneration);
      if (body.conversationId !== this.state.conversation.id) throw new LiveError(409, "Wrong conversation");
      identifier(body.candidateId, "candidateId");
      const prior = this.operatorDuplicate(body);
      if (prior) { this.json(res, 200, prior); return; }
      const provenance = await this.options.resolveExternalInput(body.candidateId);
      if (!provenance) throw new LiveError(409, "Source is expired or not a verified owner input");
      this.json(res, 200, this.adoptExternalInput(body.conversationId, provenance, body)); return;
    }
    if (req.method === "POST" && route === "/v1/live/probe") { void this.probeChannel(); this.json(res, 202, { status: "pending", channelReady: this.ready }); return; }
    if (req.method === "POST" && route === "/v1/live/hooks") { if (!this.options.observeHooks) throw new LiveError(404, "Hook observations disabled"); this.observeHook(await this.body(req)); this.json(res, 200, { accepted: true }); return; }
    if (req.method === "POST" && route === "/v1/live/attachments") {
      const body = await this.body(req);
      if (body.conversationId !== undefined && body.conversationId !== this.state.conversation.id) throw new LiveError(404, "Unknown conversation; omit conversationId for this host's conversation");
      if (Object.values(this.state.attachments).filter(a => a.active).length >= 100) throw new LiveError(429, "Too many active attachments");
      const id = randomUUID();
      this.change("connection.attached", { attachmentId: id }, s => {
        // Detached handles carry no input state and can be discarded safely.
        for (const [key, a] of Object.entries(s.attachments)) if (!a.active) delete s.attachments[key];
        s.attachments[id] = { id, conversationId: s.conversation.id, active: true };
      });
      this.json(res, 201, { attachmentId: id, conversationId: this.state.conversation.id, cursor: this.state.seq, snapshot: this.snapshot() }); return;
    }
    const match = /^\/v1\/live\/attachments\/([A-Za-z0-9-]+)(?:\/(inputs|commands|events|snapshot|resolve))?$/.exec(route);
    if (!match) throw new LiveError(404, "Unknown endpoint");
    const [, attachmentId, action] = match; this.attachment(attachmentId);
    if (req.method === "GET" && action === "snapshot") { this.json(res, 200, { cursor: this.state.seq, snapshot: this.snapshot() }); return; }
    if (req.method === "POST" && action === "resolve") { this.json(res, 200, this.resolveReceipt(await this.body(req))); return; }
    if (req.method === "DELETE" && !action) {
      this.change("connection.detached", { attachmentId }, s => { s.attachments[attachmentId].active = false; });
      for (const [client, id] of this.clients) if (id === attachmentId) { client.end(); this.clients.delete(client); }
      this.json(res, 200, { detached: true }); return;
    }
    if (req.method === "POST" && action === "inputs") { this.json(res, 202, this.acceptInput(attachmentId, await this.body(req))); return; }
    if (req.method === "POST" && action === "commands") { this.json(res, 202, this.acceptCommand(attachmentId, await this.body(req))); return; }
    if (req.method === "GET" && action === "events") {
      if (this.clients.size >= 100) throw new LiveError(429, "Too many streams");
      const raw = url.searchParams.get("cursor") ?? req.headers["last-event-id"] ?? String(this.state.seq);
      const cursor = Number(raw);
      if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(cursor)) throw new LiveError(400, "Invalid event cursor");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      const oldest = this.state.events[0]?.seq ?? this.state.seq;
      if (cursor < oldest - 1 || cursor > this.state.seq) {
        this.writeEvent(res, { id: String(this.state.seq), seq: this.state.seq, type: "work.snapshot", conversationId: this.state.conversation.id, at: now(), data: { resync: true, reason: "cursor_outside_retention" }, snapshot: this.snapshot() });
      } else for (const event of this.state.events) if (event.seq > cursor) this.writeEvent(res, event);
      this.clients.set(res, attachmentId);
      const heartbeat = setInterval(() => { if (res.writableLength > 2 * 1024 * 1024) res.destroy(); else res.write(": keepalive\n\n"); }, 15000); heartbeat.unref();
      res.on("close", () => { clearInterval(heartbeat); this.clients.delete(res); }); return;
    }
    throw new LiveError(405, "Method not allowed");
  }

  private requireGeneration(value: unknown): void {
    if (value !== this.generation) throw new LiveError(409, "Host generation changed; refresh the authoritative snapshot");
  }
  private canonicalTaskId(id: string): string {
    const seen = new Set<string>();
    while (own(this.state.taskAliases ?? {}, id)) {
      if (seen.has(id)) throw new LiveError(409, "Invalid task alias cycle");
      seen.add(id); id = this.state.taskAliases![id];
    }
    return id;
  }
  private operatorDuplicate(body: Record<string, any>): { duplicate: true; snapshot: Snapshot } | undefined {
    identifier(body.id, "operation id");
    const allowed = new Set(["id", "expectedGeneration", "nativeSessionId", "action", "acknowledgeContextChange", "pendingInputs", "inputId", "commandId", "revision", "expectedStatus", "confirmNoExecution", "conversationId", "candidateId"]);
    if (Object.keys(body).some(key => !allowed.has(key))) throw new LiveError(400, "Unexpected operator argument");
    const previous = this.state.operatorActions![body.id];
    if (previous) {
      if (previous !== fingerprint(body)) throw new LiveError(409, "Operator operation ID already has different content");
      return { duplicate: true, snapshot: this.snapshot() };
    }
    if (Object.keys(this.state.operatorActions!).length >= 10000) throw new LiveError(507, "Operator operation retention limit reached");
  }
  private publishHostBinding(): void {
    try { this.options.onHostBinding?.(structuredClone(this.state.host!)); } catch { /* Observation callback must not alter a durable binding. */ }
  }
  private recoverHost(body: Record<string, any>) {
    this.requireGeneration(body.expectedGeneration);
    const duplicate = this.operatorDuplicate(body); if (duplicate) return duplicate;
    const host = this.state.host!;
    if (body.action !== "accept_replacement" || body.acknowledgeContextChange !== true) throw new LiveError(400, "Explicit owner acknowledgement of context change is required");
    if (!this.probeAcknowledged || !host.nativeSessionId || body.nativeSessionId !== host.nativeSessionId || host.bindingStatus !== "recovery_required") throw new LiveError(409, "No matching proven native host is awaiting replacement");
    if (body.pendingInputs !== undefined && !["hold", "resume"].includes(body.pendingInputs)) throw new LiveError(400, "Invalid pending input policy");
    this.ready = true;
    try {
      this.change("connection.recovered", { channelReady: true, evidence: "authenticated_owner_replacement", pendingInputs: body.pendingInputs ?? "hold" }, state => {
        state.operatorActions![body.id] = fingerprint(body);
        state.boundNativeSessionId = host.nativeSessionId; state.bindingRequiredForLegacy = false;
        state.host = { ...host, bindingStatus: "verified", reason: undefined, verifiedAt: now() };
        state.conversation.status = "ready";
        for (const input of Object.values(state.inputs)) if (input.status === "queued" && body.pendingInputs !== "resume") input.status = "held";
        // Cancellation/steer requests describe a previous execution. Never
        // replay those against a replacement just because inputs were resumed.
        for (const command of Object.values(state.commands)) if (command.status === "queued") command.status = "held";
      });
    } catch (error) { this.ready = false; throw error; }
    this.publishHostBinding(); void this.drain();
    return { recovered: true, snapshot: this.snapshot() };
  }
  private resolveReceipt(body: Record<string, any>) {
    this.requireGeneration(body.expectedGeneration);
    const duplicate = this.operatorDuplicate(body); if (duplicate) return duplicate;
    if (!!body.inputId === !!body.commandId) throw new LiveError(400, "Provide exactly one inputId or commandId");
    const input = !!body.inputId, id = identifier(body.inputId ?? body.commandId);
    const key = input ? inputKey(id, revision(body.revision)) : id;
    const item = (input ? this.state.inputs : this.state.commands)[key];
    if (!item) throw new LiveError(404, "Receipt not found");
    if (body.expectedStatus !== item.status) throw new LiveError(409, "Receipt status changed; refresh before resolving");
    if (!["queued", "held", "delivery_uncertain", "transport_written"].includes(item.status) || item.acknowledgedAt) throw new LiveError(409, "Acknowledged or terminal work cannot be replayed or abandoned as an undelivered input");
    if (!["retry_confirmed_not_received", "abandon"].includes(body.action)) throw new LiveError(400, "Unsupported receipt resolution");
    if (body.action === "retry_confirmed_not_received") {
      if (body.confirmNoExecution !== true || !this.ready) throw new LiveError(409, "Retry requires a verified host and explicit owner confirmation of no execution");
      if (input && (this.state.inputs[key].supersededBy || Object.values(this.state.tasks).some(task => task.sourceInputId === id || task.id === this.canonicalTaskId(this.state.inputs[key].taskId ?? "")))) throw new LiveError(409, "Input is superseded or has linked work; reconcile that work first");
    }
    this.change(`${input ? "input" : "command"}.resolved`, { [`${input ? "input" : "command"}Id`]: id, revision: item.revision, action: body.action, cancellation: false }, state => {
      state.operatorActions![body.id] = fingerprint(body);
      const receipt = (input ? state.inputs : state.commands)[key];
      receipt.status = body.action === "abandon" ? "abandoned" : "queued"; receipt.resolvedAt = now();
      state.conversation.messages.push({ id: `resolution:${body.id}`, role: "system", text: body.action === "abandon" ? "Owner abandoned an unconfirmed request. This does not cancel or undo any work." : "Owner confirmed this request was not executed and explicitly requested delivery again.", at: now(), kind: "notice", inputId: input ? id : undefined, revision: item.revision });
    });
    void this.drain(); return { resolved: true, snapshot: this.snapshot() };
  }
  /** Only trusted server adapters/owner HTTP may call this; it is not an MCP tool. */
  adoptExternalInput(conversationId: string, provenance: ExternalInputProvenance, operation?: Record<string, any>) {
    if (conversationId !== this.state.conversation.id || provenance.sourceChannel !== "whatsapp" || provenance.ownerVerified !== true) throw new LiveError(409, "Verified owner provenance for this conversation is required");
    const sourceInputId = identifier(provenance.sourceInputId, "sourceInputId");
    const existing = this.state.externalInputs![sourceInputId];
    if (existing && existing.sourceChannel !== provenance.sourceChannel) throw new LiveError(409, "Source ID already has different provenance");
    if (!existing && Object.keys(this.state.externalInputs!).length >= 10000) throw new LiveError(507, "External source retention limit reached");
    this.change("source.adopted", { sourceInputId, sourceChannel: provenance.sourceChannel, evidence: "authenticated_owner_adoption" }, state => {
      state.externalInputs![sourceInputId] ??= { sourceInputId, sourceChannel: "whatsapp", ownerVerified: true, conversationId, adoptedAt: now() };
      if (operation) state.operatorActions![operation.id] = fingerprint(operation);
    });
    return { sourceInputId, conversationId, adopted: true };
  }

  private acceptInput(attachmentId: string, body: Record<string, any>) {
    if (body.expectedGeneration !== undefined) this.requireGeneration(body.expectedGeneration);
    const input: LiveInput = { id: identifier(body.id), text: string(body.text, "text"), revision: revision(body.revision), origin: body.origin,
      delegationId: optionalId(body.delegationId, "delegationId"), taskId: body.taskId === undefined ? undefined : this.canonicalTaskId(identifier(body.taskId, "taskId")) };
    if (!["voice", "web"].includes(input.origin)) throw new LiveError(400, "Invalid origin");
    if (input.taskId && !own(this.state.tasks, input.taskId)) throw new LiveError(404, "Unknown task");
    const key = inputKey(input.id, input.revision), prior = this.state.inputs[key];
    if (prior) {
      const { conversationId, status } = prior;
      const original: LiveInput = { id: prior.id, text: prior.text, revision: prior.revision, origin: prior.origin, delegationId: prior.delegationId, taskId: prior.taskId };
      if (fingerprint(original) !== fingerprint(input)) throw new LiveError(409, "Input ID/revision already has different content");
      return { inputId: input.id, revision: input.revision, conversationId, status: ["acknowledged", "completed", "failed"].includes(status) ? "acknowledged" : "queued", receiptStatus: status, hostGeneration: this.generation };
    }
    const revisions = Object.values(this.state.inputs).filter(i => i.id === input.id).map(i => i.revision);
    if (input.revision <= Math.max(0, ...revisions)) throw new LiveError(409, "Input revisions must increase");
    if (Object.keys(this.state.inputs).length >= 10000) throw new LiveError(507, "Conversation input retention limit reached");
    this.change("input.queued", { inputId: input.id, revision: input.revision, origin: input.origin, delegationId: input.delegationId }, s => {
      for (const previous of Object.values(s.inputs)) if (previous.id === input.id) {
        previous.supersededBy = input.revision;
        if (["queued", "held"].includes(previous.status)) previous.status = "superseded";
      }
      s.inputs[key] = { ...input, conversationId: s.conversation.id, attachmentId, at: now(), status: "queued" };
      s.conversation.messages.push({ id: `input:${key}`, role: "user", text: input.text, at: now(), inputId: input.id, revision: input.revision });
    });
    void this.drain();
    return { inputId: input.id, revision: input.revision, conversationId: this.state.conversation.id, status: "queued" };
  }
  private acceptCommand(attachmentId: string, body: Record<string, any>) {
    if (body.expectedGeneration !== undefined) this.requireGeneration(body.expectedGeneration);
    if (!["steer", "cancel"].includes(body.kind)) throw new LiveError(422, "Unsupported command; approvals and model changes remain in the host");
    const cmd: LiveCommand = { id: identifier(body.id), kind: body.kind, taskId: this.canonicalTaskId(identifier(body.taskId, "taskId")), revision: revision(body.revision ?? 1) };
    if (body.text !== undefined) cmd.text = string(body.text, "text");
    if (cmd.kind === "steer" && !cmd.text) throw new LiveError(400, "Steer requires text");
    const prior = this.state.commands[cmd.id];
    if (prior) {
      const { conversationId, status } = prior;
      const original: LiveCommand = { id: prior.id, kind: prior.kind, taskId: this.canonicalTaskId(prior.taskId!), revision: prior.revision, text: prior.text };
      if (fingerprint(original) !== fingerprint(cmd)) throw new LiveError(409, "Command ID already has different content");
      return { commandId: cmd.id, status: ["completed", "rejected"].includes(status) ? status : "pending", conversationId };
    }
    const task = this.state.tasks[cmd.taskId!];
    if (!task) throw new LiveError(404, "Unknown task");
    if (TERMINAL.has(task.status) || task.stale) throw new LiveError(409, "Task is terminal or must be reconciled by its leader");
    if (Object.keys(this.state.commands).length >= 10000) throw new LiveError(507, "Command retention limit reached");
    this.change("command.accepted", { commandId: cmd.id, kind: cmd.kind, taskId: cmd.taskId, status: "pending" }, s => {
      s.commands[cmd.id] = { ...cmd, conversationId: s.conversation.id, attachmentId, at: now(), status: "queued" };
      const t = s.tasks[cmd.taskId!];
      t.history.push({ id: `command:${cmd.id}`, at: now(), kind: "instruction", text: cmd.kind === "cancel" ? "Cancellation requested; awaiting leader outcome" : cmd.text! });
      t.history = t.history.slice(-100); t.updatedAt = now(); t.revision++;
    });
    void this.drain();
    return { commandId: cmd.id, status: "pending", conversationId: this.state.conversation.id };
  }
  private async drain(): Promise<void> {
    if (!this.ready || !this.running || this.draining) return;
    this.draining = true;
    try {
      while (this.ready && this.running) {
        const next = [...Object.values(this.state.inputs).map(record => ({ record, category: "input" as const })), ...Object.values(this.state.commands).map(record => ({ record, category: "command" as const }))]
          .filter(item => item.record.status === "queued").sort((a, b) => a.record.at.localeCompare(b.record.at))[0];
        if (!next) break;
        const { record, category } = next;
        const key = category === "input" ? inputKey(record.id, record.revision!) : record.id;
        // Durable intent BEFORE transport: a crash/timeout never causes blind replay.
        this.change(`${category}.delivery_started`, { [`${category}Id`]: record.id, revision: record.revision }, s => { const item = (category === "input" ? s.inputs : s.commands)[key]; item.status = "delivery_uncertain"; item.deliveryGeneration = this.generation; item.deliveryNativeSessionId = this.sessionId; });
        try {
          await this.options.deliver({ content: JSON.stringify({ kind: category, ...record, status: undefined, attachmentId: undefined,
            ...(category === "input" ? { revisionSemantics: "Full replacement text for the same input ID; correct the existing assignment, do not start duplicate work" } : {}) }),
            meta: { source: "live", kind: category, conversation_id: record.conversationId, [`${category}_id`]: record.id, revision: String(record.revision) } });
          if (!this.running) break;
          this.change(`${category}.transport_written`, { [`${category}Id`]: record.id, revision: record.revision, acknowledged: false }, s => {
            const item = (category === "input" ? s.inputs : s.commands)[key]; if (item.status === "delivery_uncertain") item.status = "transport_written";
          });
        } catch {
          if (!this.running) break;
          this.change(`${category}.delivery_uncertain`, { [`${category}Id`]: record.id, revision: record.revision, retrySafe: false }, () => {});
        }
      }
    } catch {
      // A durable write failed. Stop dispatching rather than delivering an
      // unrecorded input or letting an unhandled rejection terminate the host.
      this.ready = false;
    } finally { this.draining = false; }
  }

  callTool(name: string, args: Record<string, any>): unknown {
    if (!this.running) throw new LiveError(503, "LiveBridge is not running");
    object(args);
    const schema = LIVE_TOOLS.find(tool => tool.name === name)?.inputSchema;
    if (!schema) throw new LiveError(404, "Unknown LiveBridge tool");
    if (Object.keys(args).some(key => !own(schema.properties, key))) throw new LiveError(400, "Unexpected tool argument");
    if (schema.required.some(key => args[key] === undefined)) throw new LiveError(400, "Missing required tool argument");
    if (name === "live_status") return { ...this.capabilities(), conversationId: this.state.conversation.id, snapshot: this.snapshot() };
    if (name === "live_ack") return this.ack(args);
    if (name === "live_emit") return this.emit(args);
    if (name === "live_work") return this.work(args);
    throw new LiveError(404, "Unknown LiveBridge tool");
  }
  private ack(args: Record<string, any>) {
    if (args.probe !== undefined) {
      if (args.probe !== this.probe || args.inputId || args.commandId) throw new LiveError(409, "Invalid channel probe");
      if (!this.probeAcknowledged) {
        this.probeAcknowledged = true;
        try { this.change("connection.probe_acknowledged", { channelReady: this.ready, evidence: "leader_probe_ack", nativeSessionVerificationRequired: !this.ready }, () => {}); }
        catch (error) { this.probeAcknowledged = false; throw error; }
      }
      return { channelReady: this.ready, conversationId: this.state.conversation.id, host: structuredClone(this.state.host) };
    }
    if (!!args.inputId === !!args.commandId) throw new LiveError(400, "Provide exactly one inputId or commandId");
    const rev = revision(args.revision), category = args.inputId ? "input" : "command";
    const id = identifier(args.inputId ?? args.commandId), key = category === "input" ? inputKey(id, rev) : id;
    const item = (category === "input" ? this.state.inputs : this.state.commands)[key];
    if (!this.ready || !item || item.revision !== rev || ["queued", "held", "superseded", "abandoned"].includes(item.status) || item.deliveryGeneration !== this.generation && item.deliveryNativeSessionId !== this.sessionId) throw new LiveError(409, "ID/revision was not delivered to this leader");
    if (["delivery_uncertain", "transport_written"].includes(item.status)) this.change(`${category}.acknowledged`, { [`${category}Id`]: id, revision: rev }, s => {
      const receipt = (category === "input" ? s.inputs : s.commands)[key]; receipt.status = "acknowledged"; receipt.acknowledgedAt = now();
    });
    return { [`${category}Id`]: id, revision: rev, status: "acknowledged", conversationId: item.conversationId };
  }
  private publication(args: Record<string, any>, run: () => unknown): unknown {
    const id = identifier(args.id), value = fingerprint(args);
    if (own(this.state.publications, id)) {
      if (this.state.publications[id] !== value) throw new LiveError(409, "Publication ID already has different content");
      return { id, duplicate: true };
    }
    if (Object.keys(this.state.publications).length >= 30000) throw new LiveError(507, "Publication retention limit reached");
    return run();
  }
  private emit(args: Record<string, any>) {
    const type = string(args.type, "type", 60), text = string(args.text, "text");
    if (!["leader.reply", "leader.progress", "leader.needs_input", "input.completed", "input.failed", "command.completed", "command.rejected"].includes(type)) throw new LiveError(400, "Invalid publication type");
    const receipt = this.publication(args, () => {
      if (!this.ready) throw new LiveError(409, "Current leader channel is not ready");
      if (args.destination !== undefined && args.destination !== "live") throw new LiveError(400, "Only the live destination is supported");
      if (args.taskId !== undefined) {
        if (args.inputId || args.commandId || args.destination !== "live" || !["leader.reply", "leader.progress"].includes(type)) throw new LiveError(400, "A proactive task publication requires taskId, destination live and reply/progress only");
        const taskId = this.canonicalTaskId(identifier(args.taskId, "taskId"));
        const task = this.state.tasks[taskId];
        if (!task?.sourceInputId || !task.sourceChannel) throw new LiveError(409, "Task has no authorized input provenance");
        if (task.sourceChannel === "whatsapp") {
          if (!own(this.state.externalInputs!, task.sourceInputId)) throw new LiveError(409, "Task source has not been adopted by the owner");
        } else {
          const input = this.state.inputs[inputKey(task.sourceInputId, task.sourceRevision ?? 0)];
          if (!input || input.supersededBy || !["acknowledged", "completed"].includes(input.status)) throw new LiveError(409, "Task source is not a current acknowledged input");
        }
        this.change(type, { id: args.id, taskId, destination: "live", sourceChannel: task.sourceChannel, sourceInputId: task.sourceInputId, text }, state => {
          state.publications[args.id] = fingerprint(args);
          state.conversation.messages.push({ id: args.id, role: "assistant", text, at: now(), taskId, sourceChannel: task.sourceChannel, sourceInputId: task.sourceInputId, destination: "live", kind: type === "leader.progress" ? "progress" : "reply" });
        });
        return { id: args.id, taskId, published: true };
      }
      const command = type.startsWith("command.");
      const id = identifier(command ? args.commandId : args.inputId), rev = command ? undefined : revision(args.revision);
      const item = command ? this.state.commands[id] : this.state.inputs[inputKey(id, rev!)];
      if (!item || !["acknowledged", "completed", "failed", "rejected"].includes(item.status)) throw new LiveError(409, "Explicit acknowledged input/command attribution required");
      if (item.deliveryGeneration !== this.generation && item.deliveryNativeSessionId !== this.sessionId) throw new LiveError(409, "Input/command belongs to another native host execution");
      if (!command && this.state.inputs[inputKey(id, rev!)].supersededBy) throw new LiveError(409, "Input revision has been superseded; publish against the current acknowledged revision");
      this.change(type, { id: args.id, inputId: command ? undefined : id, revision: rev, commandId: command ? id : undefined, text }, s => {
        s.publications[args.id] = fingerprint(args);
        if (command) s.commands[id].status = type === "command.completed" ? "completed" : "rejected";
        else if (type.startsWith("input.")) s.inputs[inputKey(id, rev!)].status = type === "input.completed" ? "completed" : "failed";
        if (!command) s.inputs[inputKey(id, rev!)].needsInput = type === "leader.needs_input";
        s.conversation.messages.push({ id: args.id, role: "assistant", text, at: now(), inputId: command ? undefined : id, revision: rev, kind: type === "leader.progress" ? "progress" : type === "leader.reply" ? "reply" : "notice", ...(type === "input.completed" ? { voiceEligible: false } : {}) });
      });
      return { id: args.id, published: true };
    }) as Record<string, unknown>;
    // An accepted publication is durable bridge evidence, including idempotent
    // repeats. It cannot confirm that a browser received or played any audio.
    return { ...receipt, published: true, delivery: { stage: "published_to_bridge", voicePlayback: "unconfirmed" } };
  }
  private work(rawArgs: Record<string, any>, source = "leader_explicit") {
    const taskId = this.canonicalTaskId(identifier(rawArgs.taskId, "taskId"));
    const args: Record<string, any> = { ...rawArgs, taskId, ...(rawArgs.parentTaskId ? { parentTaskId: this.canonicalTaskId(identifier(rawArgs.parentTaskId, "parentTaskId")) } : {}) };
    const progress = string(args.progress, "progress", 4000);
    if (args.conversationId !== this.state.conversation.id) throw new LiveError(409, "Explicit current conversationId is required");
    if (source !== "native_hook" && !this.ready) throw new LiveError(409, "Native host verification is required before publishing work");
    if (args.status !== undefined && !taskStates.has(args.status)) throw new LiveError(400, "Invalid task status");
    for (const key of ["parentTaskId", "nativeId", "executionId", "sourceInputId"]) if (args[key] !== undefined) identifier(args[key], key);
    for (const key of ["title", "prompt", "result", "error", "model"]) if (args[key] !== undefined) string(args[key], key, key === "title" ? 300 : 16000);
    if (args.parentTaskId && (args.parentTaskId === taskId || !own(this.state.tasks, args.parentTaskId))) throw new LiveError(409, "Unknown or self parent task");
    const previous = this.state.tasks[taskId];
    const mapped = args.nativeId && Object.values(this.state.tasks).find(task => task.nativeId === args.nativeId && task.id !== taskId);
    if (mapped && (args.parentTaskId === mapped.id || previous?.parentTaskId === mapped.id)) throw new LiveError(409, "Task merge would create a parent cycle");
    if (mapped && (mapped.publicationSource !== "native_hook" || previous?.nativeId && previous.nativeId !== args.nativeId)) throw new LiveError(409, "Native task ID already mapped to another logical task");
    if (previous?.sourceInputId && args.sourceInputId && previous.sourceInputId !== args.sourceInputId) throw new LiveError(409, "A task's source input is immutable");
    if (previous?.sourceChannel && args.sourceChannel && previous.sourceChannel !== args.sourceChannel) throw new LiveError(409, "A task's source channel is immutable");
    if (!!args.sourceInputId !== !!args.sourceChannel) throw new LiveError(400, "Provide sourceInputId and sourceChannel together");
    if (args.sourceInputId) {
      if (args.sourceChannel === "whatsapp") {
        if (!own(this.state.externalInputs!, args.sourceInputId)) throw new LiveError(409, "External source requires authenticated owner adoption");
      } else if (["voice", "web"].includes(args.sourceChannel)) {
        const input = Object.values(this.state.inputs).find(input => input.id === args.sourceInputId && !input.supersededBy);
        if (!input || input.origin !== args.sourceChannel || !["acknowledged", "completed"].includes(input.status)) throw new LiveError(409, "Live source requires an acknowledged current input");
        args.sourceRevision = input.revision;
      } else throw new LiveError(400, "Unsupported source channel");
    }
    return this.publication(args, () => {
      if (!previous && !mapped && Object.keys(this.state.tasks).length >= 500) throw new LiveError(507, "Task retention limit reached");
      const type = args.status && TERMINAL.has(args.status) ? "work.ended" : previous || mapped ? "work.activity" : "work.started";
      this.change(type, { taskId, id: args.id, source, progress, status: args.status ?? previous?.status ?? mapped?.status ?? "running", ...(mapped ? { mergedAlias: mapped.id } : {}) }, state => {
        state.publications[args.id] = fingerprint(args);
        const task: Task = state.tasks[taskId] ?? { ...(mapped ? structuredClone(mapped) : {}), id: taskId, title: args.title ?? mapped?.title ?? taskId, prompt: args.prompt ?? mapped?.prompt ?? "", workspace: this.options.workspace, status: mapped?.status ?? "running", createdAt: mapped?.createdAt ?? now(), updatedAt: now(), revision: mapped?.revision ?? 0, progress: mapped?.progress ?? "", history: mapped?.history ?? [], owner: "external", conversationId: state.conversation.id, controls: { steer: true, cancel: true, resume: false } };
        if (mapped) {
          const histories = [...task.history, ...mapped.history];
          task.history = [...new Map(histories.map(entry => [entry.id, entry])).values()].sort((a, b) => a.at.localeCompare(b.at));
          task.revision = Math.max(task.revision, mapped.revision);
          task.aliases = [...new Set([...(task.aliases ?? []), ...(mapped.aliases ?? []), mapped.id])];
          task.createdAt = task.createdAt < mapped.createdAt ? task.createdAt : mapped.createdAt;
          if (task.status === "queued" && mapped.status !== "queued") task.status = mapped.status;
          task.parentTaskId ??= mapped.parentTaskId;
          task.sourceInputId ??= mapped.sourceInputId; task.sourceChannel ??= mapped.sourceChannel; task.sourceRevision ??= mapped.sourceRevision;
          for (const alias of task.aliases) state.taskAliases![alias] = taskId;
          for (const [alias, canonical] of Object.entries(state.taskAliases!)) if (canonical === mapped.id) state.taskAliases![alias] = taskId;
          for (const other of Object.values(state.tasks)) if (other.parentTaskId === mapped.id) other.parentTaskId = taskId;
          for (const input of Object.values(state.inputs)) if (input.taskId === mapped.id) input.taskId = taskId;
          for (const command of Object.values(state.commands)) if (command.taskId === mapped.id) command.taskId = taskId;
          delete state.tasks[mapped.id];
        }
        for (const key of ["title", "prompt", "status", "parentTaskId", "nativeId", "executionId", "result", "error", "model", "sourceChannel", "sourceInputId", "sourceRevision"] as const) if (args[key] !== undefined) (task as any)[key] = args[key];
        task.publicationSource = source === "native_hook" && task.publicationSource !== "leader_explicit" ? "native_hook" : "leader_explicit";
        task.progress = progress; task.revision++; task.updatedAt = now(); task.observedAt = now(); task.stale = false;
        task.sessionId = this.sessionId; task.controls = { steer: !TERMINAL.has(task.status), cancel: !TERMINAL.has(task.status), resume: false };
        task.history.push({ id: args.id, at: now(), kind: task.status === "failed" ? "error" : TERMINAL.has(task.status) ? "result" : "progress", text: progress }); task.history = task.history.slice(-100);
        state.tasks[taskId] = task;
        // Validate the resulting draft: merging a native ancestor rewrites its
        // children's parents even when this call omitted parentTaskId.
        let ancestor = task.parentTaskId;
        const ancestry = new Set<string>([taskId]);
        while (ancestor) { if (ancestry.has(ancestor)) throw new LiveError(409, "Task parent cycle"); ancestry.add(ancestor); ancestor = state.tasks[ancestor]?.parentTaskId; }
      });
      return { id: args.id, taskId, published: true };
    });
  }

  /** Sanitized local hooks only; no transcript reads or arbitrary assistant text. */
  observeHook(raw: Record<string, any>): void {
    if (!this.options.observeHooks) throw new LiveError(404, "Hook observations disabled");
    const event = string(raw.event, "event", 60), session = identifier(raw.sessionId, "sessionId");
    if (["SessionStart", "PostModelSwitch"].includes(event) && typeof raw.model === "string") {
      const observation: NonNullable<HostBinding["modelObservation"]> = { model: string(raw.model, "model", 180), event: event as "SessionStart" | "PostModelSwitch", observedAt: now(), evidence: "native_hook", ...(typeof raw.runtimeVersion === "string" ? { runtimeVersion: string(raw.runtimeVersion, "runtimeVersion", 100) } : {}) };
      if (this.modelCandidates.size >= 100 && !this.modelCandidates.has(session)) this.modelCandidates.delete(this.modelCandidates.keys().next().value!);
      this.modelCandidates.set(session, observation);
      if (this.state.host?.nativeSessionId === session && this.ready) {
        this.change("host.model_observed", { sessionId: session, ...observation }, state => { state.host!.modelObservation = observation; state.conversation.model = observation.model; });
        this.hooksSeen.add(event); this.publishHostBinding();
      }
      return;
    }
    if (event === "PostToolUse" && raw.probe === this.probe && this.probeAcknowledged) {
      if (this.sessionId && this.sessionId !== session) throw new LiveError(409, "Hook belongs to another host session");
      const previous = this.state.boundNativeSessionId;
      const verified = !this.state.bindingRequiredForLegacy && (!previous || previous === session);
      this.sessionId = session; this.hooksSeen.add(event); this.ready = verified;
      try {
        this.change(verified ? "connection.session_bound" : "connection.recovery_required", { sessionId: session, channelReady: verified, source: "probe_tool_hook" }, state => {
          state.conversation.sessionId = session; state.conversation.status = "starting";
          state.host = { generation: this.generation, nativeSessionId: session, previousSessionId: previous, bindingStatus: verified ? "verified" : "recovery_required", reason: verified ? undefined : previous ? "Native session differs from the persisted leader" : "Legacy store has no verified native session", verifiedAt: verified ? now() : undefined, modelObservation: this.modelCandidates.get(session) };
          if (verified) state.boundNativeSessionId = session;
          if (state.host.modelObservation) state.conversation.model = state.host.modelObservation.model;
        });
      } catch (error) { this.ready = false; throw error; }
      this.publishHostBinding(); if (verified) void this.drain(); return;
    }
    if (!this.sessionId || session !== this.sessionId) return;
    const allowed = new Set(["SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);
    if (!allowed.has(event)) return;
    this.hooksSeen.add(event);
    if (event === "SessionEnd") {
      this.ready = false; this.probeAcknowledged = false;
      this.mainTools.clear();
      this.change("connection.host_ended", { sessionId: session, channelReady: false }, s => { s.conversation.status = "offline"; delete s.conversation.activity; s.host!.bindingStatus = "awaiting_session"; s.host!.reason = "Native host session ended"; for (const task of Object.values(s.tasks)) if (!TERMINAL.has(task.status)) { task.stale = true; task.controls = { steer: false, cancel: false, resume: false }; } }); this.publishHostBinding(); return;
    }
    if (event === "Stop") {
      if (raw.agentId) return;
      this.mainTools.clear();
      this.change("leader.turn_ended", { source: "hook", tasksMayContinue: true }, state => { delete state.conversation.activity; }); return;
    }
    if (!this.ready) return;
    if (!raw.agentId) {
      // Principal activity belongs to the conversation, not an invented work item.
      // Only a matched tool completion may clear it; parallel tools stay visible.
      if (!["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event) || !raw.toolUseId) return;
      const toolUseId = identifier(raw.toolUseId, "toolUseId");
      if (event === "PreToolUse") {
        if (this.mainTools.has(toolUseId) || this.mainTools.size >= 500) return;
        this.mainTools.set(toolUseId, { phase: "tool", at: now(), ...(raw.toolName ? { toolName: identifier(raw.toolName, "toolName") } : {}) });
      } else if (!this.mainTools.delete(toolUseId)) return;
      const activity = [...this.mainTools.values()].at(-1) ?? { phase: "thinking" as const, at: now() };
      this.change("leader.activity", { source: "native_hook" }, state => { state.conversation.activity = activity; });
      return;
    }
    const nativeId = identifier(raw.agentId, "agentId");
    const hookId = `hook:${identifier(raw.id, "hook.id")}`;
    if (own(this.state.publications, hookId)) return;
    const existing = Object.values(this.state.tasks).find(t => t.nativeId === nativeId);
    // Start may precede attachment/verification or be missed by its hook process.
    // A current worker requesting an identified tool is positive activity evidence;
    // an unknown Stop or tool completion cannot prove that work is still active.
    const observedLate = !existing && event === "PreToolUse" && raw.toolUseId !== undefined;
    if (!existing && event !== "SubagentStart" && !observedLate) return;
    if (observedLate) identifier(raw.toolUseId, "toolUseId");
    const taskId = existing?.id ?? `agent:${session}:${nativeId}`;
    const progress = observedLate ? "Native agent requested a tool; its start was not observed" : event === "SubagentStart" ? "Native agent started or resumed" : event === "SubagentStop" ? "Native agent response ended; awaiting leader outcome" : event === "PreToolUse" ? "Native agent requested a tool" : event === "PostToolUseFailure" ? "Native agent tool reported failure" : "Native agent finished a tool call";
    // A terminal task is never resurrected just because its final hook arrived late.
    if (existing && TERMINAL.has(existing.status)) return;
    const agentType = typeof raw.agentType === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(raw.agentType) ? raw.agentType : undefined;
    const genericTitle = !existing || (existing.publicationSource === "native_hook" && ["Native agent", "Native background agent"].includes(existing.title));
    const title = agentType && genericTitle ? `Native agent · ${agentType}` : existing?.title ?? "Native agent";
    this.work({ id: hookId, taskId, conversationId: this.state.conversation.id, nativeId,
      title, progress, status: "running" }, "native_hook");
  }
}
