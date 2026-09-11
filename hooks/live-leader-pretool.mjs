#!/usr/bin/env node
/** Synchronous native hook; no network request or bridge availability dependency. */
import fs from "node:fs";
import path from "node:path";
import { evaluateLeaderTool, normalizeLeaderPolicy, denyLeaderTool } from "./live-leader-policy.mjs";

const workspace = process.env.CLAUDE_PROJECT_DIR || process.cwd();
let enabled = false;
try {
  let live;
  try { live = JSON.parse(fs.readFileSync(path.join(workspace, "agent-config.json"), "utf8")).liveBridge; }
  catch (error) {
    if (process.env.CLAWCODE_LIVE_LEADER_POLICY !== "1") process.exit(0);
    // A configured launcher pins policy activation for malformed/missing config.
    // Unconfigured installations remain silent, including their legacy errors.
    throw new Error("Cannot read valid leader configuration");
  }
  if (live?.enabled !== true || live.leaderPolicy === undefined || live.leaderPolicy?.enabled === false) process.exit(0);
  const policy = normalizeLeaderPolicy(live.leaderPolicy);
  if (!policy.enabled) process.exit(0);
  enabled = true;
  const raw = fs.readFileSync(0, "utf8");
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Hook payload exceeds 1 MiB");
  const result = evaluateLeaderTool(JSON.parse(raw), policy, process.env);
  process.stdout.write(JSON.stringify(result));
} catch {
  process.stdout.write(JSON.stringify(denyLeaderTool(enabled ? "Invalid native hook input; no tool permission was granted." : "Invalid leader policy configuration; repair it before operational work.")));
}
