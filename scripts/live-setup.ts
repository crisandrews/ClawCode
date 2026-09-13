#!/usr/bin/env -S node --import tsx
import { applyLiveSetup, createLiveSetupPlan, getLiveSetupStatus, type LiveSetupOptions } from "../lib/live-setup.ts";

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || action === "--help") {
    console.log("live-setup.ts plan|status|apply --workspace /absolute/workspace [--enabled true|false --bridge-port 18791 --web-port 3210 --max-concurrent 3 --live-channel-target plugin:agent@clawcode] [--expected-fingerprint HASH] [-- EXISTING_CLAUDE_ARGV...]");
    return;
  }
  if (!["plan", "status", "apply"].includes(action)) throw new Error("Unknown setup action");
  let workspace: string | undefined, expectedFingerprint: string | undefined;
  const options: LiveSetupOptions = {}, seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { options.extraArgs = args.slice(i + 1); break; }
    if (seen.has(arg)) throw new Error("Duplicate setup option"); seen.add(arg);
    if (!["--workspace", "--expected-fingerprint", "--enabled", "--bridge-port", "--web-port", "--max-concurrent", "--live-channel-target"].includes(arg)) throw new Error("Unknown setup option");
    const value = args[++i]; if (!value || value.startsWith("--")) throw new Error("Missing setup option value");
    if (arg === "--workspace") workspace = value;
    else if (arg === "--enabled") { if (value !== "true" && value !== "false") throw new Error("enabled must be true or false"); options.enabled = value === "true"; }
    else if (arg === "--expected-fingerprint") expectedFingerprint = value;
    else if (arg === "--live-channel-target") options.liveChannelTarget = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error("Port and concurrency options must be integers");
      const key = arg === "--bridge-port" ? "bridgePort" : arg === "--web-port" ? "webPort" : "maxConcurrent";
      options[key] = Number(value);
    }
  }
  if (!workspace) throw new Error("An explicit --workspace is required");
  if (action === "status" && (Object.keys(options).length || expectedFingerprint)) throw new Error("status accepts only --workspace");
  if (action !== "apply" && expectedFingerprint) throw new Error("Fingerprint is only accepted by apply");
  const result = action === "status" ? await getLiveSetupStatus(workspace) : action === "plan" ? await createLiveSetupPlan(workspace, options)
    : await applyLiveSetup(workspace, { ...options, expectedFingerprint: expectedFingerprint ?? "" });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Local setup failed"); process.exitCode = 1; });
