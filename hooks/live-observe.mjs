#!/usr/bin/env node
/** Opt-in, metadata-only hook collector. Never reads transcripts or prints input. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readLiveToken } from "../lib/live-credentials.mjs";

export function sanitizeHook(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.session_id !== "string") return null;
  const allowed = new Set(["SessionStart", "PostModelSwitch", "SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);
  if (!allowed.has(payload.hook_event_name)) return null;
  const result = { id: randomUUID(), event: payload.hook_event_name, sessionId: payload.session_id };
  if (["SessionStart", "PostModelSwitch"].includes(payload.hook_event_name)) {
    const model = payload.hook_event_name === "PostModelSwitch" ? payload.to_model : payload.model;
    if (typeof model !== "string" || !model.trim() || model.length > 180) return null;
    result.model = model;
  }
  if (typeof payload.agent_id === "string") result.agentId = payload.agent_id;
  const safeIdentity = value => typeof value === "string" && value.length <= 180 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  // The documented agent type is a declared name, never its prompt or task.
  // A main session's --agent type alone is not evidence of a subagent.
  if (result.agentId && ["SubagentStart", "PreToolUse"].includes(payload.hook_event_name) && safeIdentity(payload.agent_type)) result.agentType = payload.agent_type;
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(payload.hook_event_name)) {
    // Identity metadata lets the UI observe the principal's current tool without
    // turning every tool call into a task or copying its command and arguments.
    if (safeIdentity(payload.tool_name)) result.toolName = payload.tool_name;
    if (safeIdentity(payload.tool_use_id)) result.toolUseId = payload.tool_use_id;
  }
  // Only the probe's PostToolUse can bind the host session. No other tool args,
  // tool results, paths, commands, message text, or channel tokens are retained.
  if (payload.hook_event_name === "PostToolUse" && /^mcp__.+__live_ack$/.test(payload.tool_name ?? "") && typeof payload.tool_input?.probe === "string") result.probe = payload.tool_input.probe;
  if (result.sessionId.length > 180 || result.agentId?.length > 180 || result.probe?.length > 180) return null;
  return result;
}

async function main() {
  const workspace = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(workspace, "agent-config.json"), "utf8")).liveBridge; } catch { return; }
  if (config?.enabled !== true || config.observeHooks !== true) return;
  const token = readLiveToken(workspace, config);
  if (!token) return;
  const port = config.port ?? 18791;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  process.stdin.setEncoding("utf8");
  let raw = "";
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 1048576) return; }
  let payload;
  try { payload = sanitizeHook(JSON.parse(raw)); } catch { return; }
  if (!payload) return;
  await new Promise(resolve => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/live/hooks", method: "POST", timeout: 750,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }, res => { res.resume(); res.on("end", resolve); });
    req.on("timeout", () => req.destroy()); req.on("error", resolve); req.end(JSON.stringify(payload));
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {}).finally(() => { process.exitCode = 0; });
