import http from "node:http";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { LiveStore } from "./live-store.ts";
import { LIVE_TOOLS } from "./live-tools.ts";
import { LIVE_CAPABILITIES, TERMINAL, type LiveState, type Snapshot, type LiveEvent, type Task, type LiveInput, type LiveCommand } from "./live-types.ts";
export { LIVE_TOOLS, LIVE_INSTRUCTIONS } from "./live-tools.ts";

export interface LiveBridgeOptions {
  workspace: string; dataDir: string; token: string; port?: number;
  agent: { id: string; name: string };
  deliver: (message: { content: string; meta: Record<string, string> }) => Promise<void>;
  observeHooks?: boolean; eventRetention?: number;
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
  private running = false;
  private draining = false;
  private sessionId?: string;
  private probeAt = 0;
  private hooksSeen = new Set<string>();
  private exitHandler = () => this.store.close();

  constructor(private readonly options: LiveBridgeOptions) {
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
      this.state.conversation.status = "starting";
      // Connection handles are ephemeral; durable inputs/tasks belong to the
      // logical conversation, not to a transport from a previous process.
      this.state.attachments = {};
      delete this.state.conversation.sessionId;
      delete this.state.conversation.model;
      for (const task of Object.values(this.state.tasks)) if (!TERMINAL.has(task.status)) { task.stale = true; task.controls = { steer: false, cancel: false, resume: false }; }
      this.store.save(this.state);
      await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.options.port ?? 18791, "127.0.0.1", () => { this.server.off("error", reject); resolve(); }); });
      this.running = true;
      process.once("exit", this.exitHandler);
      this.change("connection.started", { channelReady: false }, () => {});
    } catch (error) { this.store.close(); throw error; }
  }
  get port(): number { const a = this.server.address(); return a && typeof a === "object" ? a.port : this.options.port ?? 18791; }
  async close(): Promise<void> {
    if (!this.running) return;
    this.ready = false;
    try { this.change("connection.closed", { channelReady: false }, s => { s.conversation.status = "offline"; }); }
    catch { /* Disk failure must not keep the listener or writer lease alive. */ }
    this.running = false;
    for (const client of this.clients.keys()) client.end();
    this.clients.clear();
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    process.off("exit", this.exitHandler); this.store.close();
  }
  capabilities() {
    return {
      protocolVersion: 1,
      agent: { ...this.options.agent, sessionId: this.sessionId, workspace: this.options.workspace },
      capabilities: { ...LIVE_CAPABILITIES, channelReady: this.ready },
      observations: { hooksEnabled: !!this.options.observeHooks, sessionBound: !!this.sessionId, hooksSeen: [...this.hooksSeen] },
      semantics: { cancel: "request_to_leader", steer: "request_to_leader", delivery: "channel_next_turn", uncertainDelivery: "never_automatically_retried" },
    };
  }
  snapshot(): Snapshot { return structuredClone({ conversation: this.state.conversation, tasks: Object.values(this.state.tasks), approvals: [] }); }
  /** Call only after the MCP client initialized; a transport write is NOT readiness. */
  async probeChannel(): Promise<void> {
    if (!this.running || this.ready || Date.now() - this.probeAt < 1000) return;
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
    draft.conversation.messages = draft.conversation.messages.slice(-300);
    draft.conversation.queuedInputs = Object.values(draft.inputs).filter(i => !i.supersededBy && ["queued", "delivery_uncertain", "transport_written"].includes(i.status)).length;
    const event: LiveEvent = { id: String(++draft.seq), seq: draft.seq, type, conversationId: draft.conversation.id, at: now(), data,
      snapshot: structuredClone({ conversation: draft.conversation, tasks: Object.values(draft.tasks), approvals: [] }) };
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
    const match = /^\/v1\/live\/attachments\/([A-Za-z0-9-]+)(?:\/(inputs|commands|events))?$/.exec(route);
    if (!match) throw new LiveError(404, "Unknown endpoint");
    const [, attachmentId, action] = match; this.attachment(attachmentId);
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

  private acceptInput(attachmentId: string, body: Record<string, any>) {
    const input: LiveInput = { id: identifier(body.id), text: string(body.text, "text"), revision: revision(body.revision), origin: body.origin,
      delegationId: optionalId(body.delegationId, "delegationId"), taskId: optionalId(body.taskId, "taskId") };
    if (!["voice", "web"].includes(input.origin)) throw new LiveError(400, "Invalid origin");
    if (input.taskId && !own(this.state.tasks, input.taskId)) throw new LiveError(404, "Unknown task");
    const key = inputKey(input.id, input.revision), prior = this.state.inputs[key];
    if (prior) {
      const { conversationId, attachmentId: _, at, status, supersededBy, ...original } = prior;
      if (fingerprint(original) !== fingerprint(input)) throw new LiveError(409, "Input ID/revision already has different content");
      return { inputId: input.id, revision: input.revision, conversationId, status: ["acknowledged", "completed", "failed"].includes(status) ? "acknowledged" : "queued" };
    }
    const revisions = Object.values(this.state.inputs).filter(i => i.id === input.id).map(i => i.revision);
    if (input.revision <= Math.max(0, ...revisions)) throw new LiveError(409, "Input revisions must increase");
    if (Object.keys(this.state.inputs).length >= 10000) throw new LiveError(507, "Conversation input retention limit reached");
    this.change("input.queued", { inputId: input.id, revision: input.revision, origin: input.origin, delegationId: input.delegationId }, s => {
      for (const previous of Object.values(s.inputs)) if (previous.id === input.id) {
        previous.supersededBy = input.revision;
        if (previous.status === "queued") previous.status = "superseded";
      }
      s.inputs[key] = { ...input, conversationId: s.conversation.id, attachmentId, at: now(), status: "queued" };
      s.conversation.messages.push({ id: `input:${key}`, role: "user", text: input.text, at: now(), inputId: input.id, revision: input.revision });
    });
    void this.drain();
    return { inputId: input.id, revision: input.revision, conversationId: this.state.conversation.id, status: "queued" };
  }
  private acceptCommand(attachmentId: string, body: Record<string, any>) {
    if (!["steer", "cancel"].includes(body.kind)) throw new LiveError(422, "Unsupported command; approvals and model changes remain in the host");
    const cmd: LiveCommand = { id: identifier(body.id), kind: body.kind, taskId: identifier(body.taskId, "taskId"), revision: revision(body.revision ?? 1) };
    if (body.text !== undefined) cmd.text = string(body.text, "text");
    if (cmd.kind === "steer" && !cmd.text) throw new LiveError(400, "Steer requires text");
    const prior = this.state.commands[cmd.id];
    if (prior) {
      const { conversationId, attachmentId: _, at, status, ...original } = prior;
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
        this.change(`${category}.delivery_started`, { [`${category}Id`]: record.id, revision: record.revision }, s => { (category === "input" ? s.inputs : s.commands)[key].status = "delivery_uncertain"; });
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
      if (!this.ready) {
        this.ready = true;
        try { this.change("connection.ready", { channelReady: true, evidence: "leader_probe_ack" }, s => { s.conversation.status = "ready"; }); }
        catch (error) { this.ready = false; throw error; }
      }
      void this.drain(); return { channelReady: true, conversationId: this.state.conversation.id };
    }
    if (!!args.inputId === !!args.commandId) throw new LiveError(400, "Provide exactly one inputId or commandId");
    const rev = revision(args.revision), category = args.inputId ? "input" : "command";
    const id = identifier(args.inputId ?? args.commandId), key = category === "input" ? inputKey(id, rev) : id;
    const item = (category === "input" ? this.state.inputs : this.state.commands)[key];
    if (!this.ready || !item || item.revision !== rev || item.status === "queued" || item.status === "superseded") throw new LiveError(409, "ID/revision was not delivered to this leader");
    if (["delivery_uncertain", "transport_written"].includes(item.status)) this.change(`${category}.acknowledged`, { [`${category}Id`]: id, revision: rev }, s => {
      (category === "input" ? s.inputs : s.commands)[key].status = "acknowledged"; s.conversation.status = "working";
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
    return this.publication(args, () => {
      if (!this.ready) throw new LiveError(409, "Current leader channel is not ready");
      const command = type.startsWith("command.");
      const id = identifier(command ? args.commandId : args.inputId), rev = command ? undefined : revision(args.revision);
      const item = command ? this.state.commands[id] : this.state.inputs[inputKey(id, rev!)];
      if (!item || !["acknowledged", "completed", "failed", "rejected"].includes(item.status)) throw new LiveError(409, "Explicit acknowledged input/command attribution required");
      if (!command && this.state.inputs[inputKey(id, rev!)].supersededBy) throw new LiveError(409, "Input revision has been superseded; publish against the current acknowledged revision");
      this.change(type, { id: args.id, inputId: command ? undefined : id, revision: rev, commandId: command ? id : undefined, text }, s => {
        s.publications[args.id] = fingerprint(args);
        if (command) s.commands[id].status = type === "command.completed" ? "completed" : "rejected";
        else if (type.startsWith("input.")) s.inputs[inputKey(id, rev!)].status = type === "input.completed" ? "completed" : "failed";
        s.conversation.messages.push({ id: args.id, role: "assistant", text, at: now(), inputId: command ? undefined : id, revision: rev, kind: type === "leader.progress" ? "progress" : type === "leader.reply" ? "reply" : "notice" });
        if (type === "leader.needs_input") s.conversation.status = "waiting_permission";
        else if (type === "input.completed" || type === "input.failed") s.conversation.status = Object.values(s.tasks).some(t => !TERMINAL.has(t.status)) ? "working" : "ready";
      });
      return { id: args.id, published: true };
    });
  }
  private work(args: Record<string, any>, source = "leader_explicit") {
    const taskId = identifier(args.taskId, "taskId"), progress = string(args.progress, "progress", 4000);
    if (args.conversationId !== this.state.conversation.id) throw new LiveError(409, "Explicit current conversationId is required");
    if (args.status !== undefined && !taskStates.has(args.status)) throw new LiveError(400, "Invalid task status");
    for (const key of ["parentTaskId", "nativeId", "executionId"]) if (args[key] !== undefined) identifier(args[key], key);
    for (const key of ["title", "prompt", "result", "error", "model"]) if (args[key] !== undefined) string(args[key], key, key === "title" ? 300 : 16000);
    if (args.parentTaskId && (args.parentTaskId === taskId || !own(this.state.tasks, args.parentTaskId))) throw new LiveError(409, "Unknown or self parent task");
    if (args.nativeId && Object.values(this.state.tasks).some(t => t.nativeId === args.nativeId && t.id !== taskId)) throw new LiveError(409, "Native task ID already mapped; update its existing taskId");
    return this.publication(args, () => {
      if (!own(this.state.tasks, taskId) && Object.keys(this.state.tasks).length >= 500) throw new LiveError(507, "Task retention limit reached");
      const type = args.status && TERMINAL.has(args.status) ? "work.ended" : own(this.state.tasks, taskId) ? "work.activity" : "work.started";
      this.change(type, { taskId, id: args.id, source, progress, status: args.status ?? this.state.tasks[taskId]?.status ?? "running" }, s => {
        s.publications[args.id] = fingerprint(args);
        const task: Task = s.tasks[taskId] ?? { id: taskId, title: args.title ?? taskId, prompt: args.prompt ?? "", workspace: this.options.workspace, status: "running", createdAt: now(), updatedAt: now(), revision: 0, progress: "", history: [], owner: "external", conversationId: s.conversation.id, controls: { steer: true, cancel: true, resume: false } };
        for (const key of ["title", "prompt", "status", "parentTaskId", "nativeId", "executionId", "result", "error", "model"] as const) if (args[key] !== undefined) (task as any)[key] = args[key];
        task.progress = progress; task.revision++; task.updatedAt = now(); task.observedAt = now(); task.stale = false;
        task.sessionId = this.sessionId; task.controls = { steer: !TERMINAL.has(task.status), cancel: !TERMINAL.has(task.status), resume: false };
        task.history.push({ id: args.id, at: now(), kind: task.status === "failed" ? "error" : TERMINAL.has(task.status) ? "result" : "progress", text: progress }); task.history = task.history.slice(-100);
        s.tasks[taskId] = task;
        s.conversation.status = Object.values(s.tasks).some(t => !TERMINAL.has(t.status)) ? "working" : this.ready ? "ready" : "starting";
      });
      return { id: args.id, taskId, published: true };
    });
  }

  /** Sanitized local hooks only; no transcript reads or arbitrary assistant text. */
  observeHook(raw: Record<string, any>): void {
    if (!this.options.observeHooks) throw new LiveError(404, "Hook observations disabled");
    const event = string(raw.event, "event", 60), session = identifier(raw.sessionId, "sessionId");
    if (event === "PostToolUse" && raw.probe === this.probe && this.ready) {
      if (this.sessionId && this.sessionId !== session) throw new LiveError(409, "Hook belongs to another host session");
      this.sessionId = session; this.hooksSeen.add(event);
      this.change("connection.session_bound", { sessionId: session, source: "probe_tool_hook" }, s => { s.conversation.sessionId = session; }); return;
    }
    if (!this.sessionId || session !== this.sessionId) return;
    const allowed = new Set(["SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);
    if (!allowed.has(event)) return;
    this.hooksSeen.add(event);
    if (event === "SessionEnd") {
      this.ready = false;
      this.change("connection.host_ended", { sessionId: session, channelReady: false }, s => { s.conversation.status = "offline"; for (const task of Object.values(s.tasks)) if (!TERMINAL.has(task.status)) { task.stale = true; task.controls = { steer: false, cancel: false, resume: false }; } }); return;
    }
    if (event === "Stop") { this.change("leader.turn_ended", { source: "hook", tasksMayContinue: true }, () => {}); return; }
    if (!raw.agentId) return; // Main-session tool activity has no unambiguous work attribution.
    const nativeId = identifier(raw.agentId, "agentId");
    const existing = Object.values(this.state.tasks).find(t => t.nativeId === nativeId);
    if (!existing && event !== "SubagentStart") return;
    const taskId = existing?.id ?? `agent:${session}:${nativeId}`;
    const progress = event === "SubagentStart" ? "Native agent started or resumed" : event === "SubagentStop" ? "Native agent response ended; awaiting leader outcome" : event === "PreToolUse" ? "Native agent is using a tool" : event === "PostToolUseFailure" ? "Native agent tool reported failure" : "Native agent finished a tool call";
    // A terminal task is never resurrected just because its final hook arrived late.
    if (existing && TERMINAL.has(existing.status)) return;
    this.work({ id: `hook:${identifier(raw.id, "hook.id")}`, taskId, conversationId: this.state.conversation.id, nativeId,
      title: existing?.title ?? "Native background agent", progress, status: "running" }, "native_hook");
  }
}
