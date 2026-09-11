/** Pure, reusable synchronous policy. Returning {} never grants permission. */
const DEFAULT_CONCURRENCY = 3;
const NATIVE_COORDINATION = new Set([
  "AskUserQuestion", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "TaskStop",
]);
const LIVE_COORDINATION = new Set([
  "mcp__clawcode__live_status", "mcp__clawcode__live_ack", "mcp__clawcode__live_emit", "mcp__clawcode__live_work",
  "mcp__plugin_agent_clawcode__live_status", "mcp__plugin_agent_clawcode__live_ack", "mcp__plugin_agent_clawcode__live_emit", "mcp__plugin_agent_clawcode__live_work",
]);
// Preserve the existing channel reply path. These are exact known tool names;
// passthrough still leaves ordinary send authorization and scope gates in place.
const CHANNEL_COORDINATION = new Set(["mcp__whatsapp__reply", "mcp__whatsapp__react"]);
const truthy = value => typeof value === "string" && ["1", "true", "yes", "on"].includes(value.toLowerCase());

export function supportsLeaderRuntime(versionString) {
  if (typeof versionString !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?\s*$/.exec(versionString.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || major === 2 && (minor > 1 || minor === 1 && patch >= 232);
}

export function normalizeLeaderPolicy(value) {
  if (value === undefined || value === null) return { enabled: false, maxConcurrent: DEFAULT_CONCURRENCY, coordinationTools: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("leaderPolicy must be an object");
  if (Object.keys(value).some(key => !["enabled", "maxConcurrent", "coordinationTools"].includes(key))) throw new Error("Unknown leaderPolicy setting");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("leaderPolicy.enabled must be boolean");
  const maxConcurrent = value.maxConcurrent === undefined ? DEFAULT_CONCURRENCY : value.maxConcurrent;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("leaderPolicy.maxConcurrent must be a positive safe integer");
  const coordinationTools = value.coordinationTools === undefined ? [] : value.coordinationTools;
  if (!Array.isArray(coordinationTools) || coordinationTools.length > 64 || coordinationTools.some(name => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,179}$/.test(name))) throw new Error("leaderPolicy.coordinationTools must contain exact tool names (no wildcards)");
  return { enabled: value.enabled === true, maxConcurrent, coordinationTools: [...new Set(coordinationTools)] };
}

export function leaderEnvironment(policy, environment = process.env) {
  const normalized = normalizeLeaderPolicy(policy);
  if (!normalized.enabled) return { ...environment };
  if (truthy(environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) throw new Error("leaderPolicy conflicts with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS");
  return { ...environment, CLAUDE_CODE_FORK_SUBAGENT: "1", CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(normalized.maxConcurrent) };
}

export function denyLeaderTool(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `live-leader-policy: ${reason}` } };
}

export function evaluateLeaderTool(payload, policy, environment = process.env) {
  const normalized = normalizeLeaderPolicy(policy);
  if (!normalized.enabled || payload?.hook_event_name !== "PreToolUse") return {};
  // Native worker attribution is supplied by the hook runtime, never tool_input.
  // The ordinary execution/scope hooks still run for both leader and workers.
  if (typeof payload.agent_id === "string" && payload.agent_id.trim()) return {};
  const tool = payload.tool_name;
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  if (tool === "Agent" || tool === "Task") {
    if (input.team_name !== undefined || input.name !== undefined) return denyLeaderTool("Agent teams and named teammates are outside the conversational leader policy. Delegate an unnamed background subagent.");
    if (input.run_in_background === false || input.mode === "foreground") return denyLeaderTool("Foreground delegation blocks this leader. Delegate in native fork/background mode.");
    if (environment.CLAUDE_CODE_FORK_SUBAGENT !== "1" || truthy(environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return denyLeaderTool("Native background fork mode is not configured for this process. Restart through the configured launcher; do not fall back to foreground work.");
    if (environment.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS !== String(normalized.maxConcurrent)) return denyLeaderTool("The native spawn limit does not match the configured policy. Restart through the configured launcher.");
    return {};
  }
  if (tool === "TaskOutput") return input.block === false ? {} : denyLeaderTool("Use TaskOutput with block:false. Blocking waits prevent the leader from returning to the conversation.");
  if (tool === "SendMessage") {
    if (input.type !== undefined && input.type !== "message" || input.broadcast === true || input.team_name !== undefined) return denyLeaderTool("Team broadcasts and team lifecycle messages are outside this policy. Use direct native subagent continuation.");
    return {};
  }
  if (NATIVE_COORDINATION.has(tool) || LIVE_COORDINATION.has(tool) || CHANNEL_COORDINATION.has(tool) || normalized.coordinationTools.includes(tool)) return {};
  return denyLeaderTool(`Delegate ${typeof tool === "string" ? tool : "this operation"} to a background subagent. Keep this leader available for dialogue, progress and coordination. Native capacity errors are not an automatic queue: record pending work and return to the conversation.`);
}
