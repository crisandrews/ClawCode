#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = value;
  }
  return out;
}

function parseField(field, min, max) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    if (!part) continue;
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;

    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const pieces = rangePart.split("-").map(Number);
      if (pieces.length !== 2) return null;
      [start, end] = pieces;
    } else {
      start = Number(rangePart);
      end = Number(rangePart);
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

export function cronMatchesDate(cron, date = new Date()) {
  const fields = String(cron).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, dow] = fields;
  const parsed = [
    parseField(minute, 0, 59),
    parseField(hour, 0, 23),
    parseField(day, 1, 31),
    parseField(month, 1, 12),
    parseField(dow === "7" ? "0" : dow, 0, 7),
  ];
  if (parsed.some((p) => p === null)) return false;
  const localDow = date.getDay();
  return (
    parsed[0].has(date.getMinutes()) &&
    parsed[1].has(date.getHours()) &&
    parsed[2].has(date.getDate()) &&
    parsed[3].has(date.getMonth() + 1) &&
    (parsed[4].has(localDow) || (localDow === 0 && parsed[4].has(7)))
  );
}

export function dueEntries(registry, state, now = new Date()) {
  const minuteKey = Math.floor(now.getTime() / 60000);
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const fired = state.fired || {};
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  return entries.filter((entry) => {
    if (!entry || entry.paused || entry.tombstone) return false;
    if (entry.recurring === false && Number.isFinite(entry.targetEpoch)) {
      return entry.targetEpoch <= nowEpoch && fired[entry.key] !== "oneshot";
    }
    if (!cronMatchesDate(entry.cron, now)) return false;
    return fired[entry.key] !== minuteKey;
  });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function runWriteback(pluginRoot, workspace, args) {
  const script = path.join(pluginRoot, "skills", "crons", "writeback.sh");
  return spawnSync("bash", [script, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      CLAWCODE_RUNTIME: "codex",
      CLAWCODE_WORKSPACE: workspace,
      CLAUDE_PROJECT_DIR: workspace,
      CLAWCODE_PLUGIN_ROOT: pluginRoot,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
    encoding: "utf8",
  });
}

function runCodex(codexBin, workspace, prompt) {
  return spawnSync(
    codexBin,
    [
      "exec",
      "-C",
      workspace,
      "--skip-git-repo-check",
      "--ask-for-approval",
      "never",
      "--dangerously-bypass-approvals-and-sandbox",
      prompt,
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        CLAWCODE_RUNTIME: "codex",
        CLAWCODE_WORKSPACE: workspace,
        CLAUDE_PROJECT_DIR: workspace,
      },
      encoding: "utf8",
      stdio: "inherit",
    }
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspace = path.resolve(args.workspace || process.env.CLAWCODE_WORKSPACE || process.cwd());
  const pluginRoot = path.resolve(args["plugin-root"] || process.env.CLAWCODE_PLUGIN_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const codexBin = args["codex-bin"] || process.env.CODEX_BIN || "codex";
  const memoryDir = path.join(workspace, "memory");
  const registryPath = path.join(memoryDir, "crons.json");
  const statePath = path.join(memoryDir, ".codex-cron-runner-state.json");
  const lockDir = path.join(memoryDir, ".codex-cron-runner.lock");

  fs.mkdirSync(memoryDir, { recursive: true });
  try {
    fs.mkdirSync(lockDir);
  } catch {
    return;
  }

  try {
    runWriteback(pluginRoot, workspace, ["seed-defaults"]);
    const registry = readJson(registryPath, { entries: [] });
    const state = readJson(statePath, { fired: {} });
    const now = new Date();
    const minuteKey = Math.floor(now.getTime() / 60000);
    const due = dueEntries(registry, state, now);

    for (const entry of due) {
      const result = runCodex(codexBin, workspace, entry.prompt);
      if (result.status === 0) {
        state.fired = state.fired || {};
        state.fired[entry.key] = entry.recurring === false && Number.isFinite(entry.targetEpoch)
          ? "oneshot"
          : minuteKey;
        state.updatedAt = new Date().toISOString();
        writeJson(statePath, state);
        if (entry.recurring === false && Number.isFinite(entry.targetEpoch)) {
          runWriteback(pluginRoot, workspace, ["tombstone", "--key", entry.key]);
        }
      }
    }
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
