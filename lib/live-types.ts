/** LiveBridge v1. Public wire types; no application or model SDK dependency. */
export type TaskStatus = "queued" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";
export interface Task {
  id: string; title: string; prompt: string; workspace: string; status: TaskStatus;
  createdAt: string; updatedAt: string; revision: number; progress: string;
  sessionId?: string; result?: string; error?: string;
  history: Array<{ id: string; at: string; kind: "progress" | "instruction" | "result" | "error"; text: string }>;
  owner: "external"; conversationId: string; parentTaskId?: string; nativeId?: string;
  executionId?: string; model?: string; observedAt?: string; stale?: boolean;
  controls: { steer: boolean; cancel: boolean; resume: boolean };
  sourceChannel?: "voice" | "web" | "whatsapp";
  sourceInputId?: string;
  sourceRevision?: number;
  publicationSource?: "leader_explicit" | "native_hook";
  aliases?: string[];
}
export interface Approval { id: string; taskId: string; toolName: string; input: Record<string, unknown>; createdAt: string; owner?: "external"; kind?: "tool" | "question" }
export interface ConversationMessage {
  id: string; role: "user" | "assistant" | "system"; text: string; at: string;
  inputId?: string; revision?: number; kind?: "reply" | "progress" | "notice";
  taskId?: string; sourceChannel?: "voice" | "web" | "whatsapp"; sourceInputId?: string; destination?: "live";
}
export interface ConversationState {
  id: string; name: string; owner: "external"; sessionId?: string; workspace: string;
  status: "offline" | "starting" | "ready" | "working" | "waiting_permission" | "error";
  model?: string; messages: ConversationMessage[]; queuedInputs: number;
  capabilities: { tasks: boolean; steer: boolean; cancel: boolean; approvals: boolean; modelChange: boolean; externalInputAdoption?: boolean; leaderPolicy?: LeaderPolicyState };
}
export interface LeaderPolicyState {
  configured: boolean; hookObserved: boolean; runtimeConfirmed: boolean; maxConcurrent: number;
  tools: "host_native" | "delegate_operations"; directToolsAllowed: boolean;
  limitSemantics: "native_spawn_limit"; resumedAgentsCounted: false; automaticQueue: false;
}
export interface HostBinding {
  generation: string;
  nativeSessionId?: string;
  previousSessionId?: string;
  bindingStatus: "awaiting_session" | "verified" | "recovery_required";
  reason?: string;
  verifiedAt?: string;
  modelObservation?: { model: string; event: "SessionStart" | "PostModelSwitch"; observedAt: string; runtimeVersion?: string; evidence: "native_hook" };
}
export interface ExternalInputProvenance { sourceChannel: "whatsapp"; sourceInputId: string; ownerVerified: true }
export interface Snapshot {
  conversation: ConversationState; tasks: Task[]; approvals: Approval[];
  inputs?: InputRecord[]; commands?: CommandRecord[]; host?: HostBinding;
  taskAliases?: Record<string, string>;
  sources?: Array<{ sourceInputId: string; sourceChannel: "whatsapp"; adoptedAt: string }>;
}
export interface LiveEvent {
  id: string; seq: number; type: string; conversationId: string; at: string;
  data: Record<string, unknown>; snapshot: Snapshot;
}
export interface LiveInput {
  id: string; text: string; revision: number; origin: "voice" | "web";
  delegationId?: string; taskId?: string;
}
export interface LiveCommand {
  id: string; kind: "steer" | "cancel" | "approve"; taskId?: string; text?: string;
  approvalId?: string; allow?: boolean; answer?: string; revision?: number;
}
export interface InputRecord extends LiveInput {
  conversationId: string; attachmentId: string; at: string;
  supersededBy?: number;
  status: "queued" | "held" | "abandoned" | "superseded" | "delivery_uncertain" | "transport_written" | "acknowledged" | "completed" | "failed";
  deliveryGeneration?: string;
  deliveryNativeSessionId?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  needsInput?: boolean;
}
export interface CommandRecord extends LiveCommand {
  conversationId: string; attachmentId: string; at: string;
  status: "queued" | "held" | "abandoned" | "delivery_uncertain" | "transport_written" | "acknowledged" | "completed" | "rejected";
  deliveryGeneration?: string;
  deliveryNativeSessionId?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
}
export interface LiveState {
  version: 1; workspace: string; seq: number; conversation: ConversationState;
  tasks: Record<string, Task>; inputs: Record<string, InputRecord>; commands: Record<string, CommandRecord>;
  attachments: Record<string, { id: string; conversationId: string; active: boolean }>;
  publications: Record<string, string>; events: LiveEvent[];
  host?: HostBinding;
  boundNativeSessionId?: string;
  bindingRequiredForLegacy?: boolean;
  taskAliases?: Record<string, string>;
  operatorActions?: Record<string, string>;
  externalInputs?: Record<string, ExternalInputProvenance & { conversationId: string; adoptedAt: string }>;
}
export const LIVE_CAPABILITIES = { tasks: true, steer: true, cancel: true, approvals: false, modelChange: false } as const;
export const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled", "interrupted"]);
