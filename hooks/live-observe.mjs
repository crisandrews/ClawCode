#!/usr/bin/env node
/** Opt-in, metadata-only hook collector. Never reads transcripts or prints input. */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export function sanitizeHook(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.session_id !== "string") return null;
  const allowed = new Set(["SubagentStart", "SubagentStop", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd"]);
  if (!allowed.has(payload.hook_event_name)) return null;
  const result = { id: randomUUID(), event: payload.hook_event_name, sessionId: payload.session_id };
  if (typeof payload.agent_id === "string") result.agentId = payload.agent_id;
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
  const tokenEnv = config.tokenEnv ?? "CLAWCODE_LIVE_TOKEN";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(tokenEnv)) return;
  const token = process.env[tokenEnv];
  if (!token || token.length < 32) return;
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
