/**
 * Command discovery — scan skill files across the three install scopes
 * (plugin / project / user) and optionally include MCP tools, so the agent
 * can answer "what can I do?" without relying on a hardcoded list.
 *
 * Output is a flat list of CommandRecords that /help can render, a WebChat UI
 * can display, or tests can assert against.
 */

import fs from "fs";
import path from "path";
import { parseFrontmatter, scopeDir, type InstallScope } from "./skill-manager.ts";
import { detectRuntime, runtimeInfo } from "./runtime.ts";

export type CommandScope = InstallScope | "mcp";

export interface CommandRecord {
  name: string;
  description: string;
  triggers: string[];
  scope: CommandScope;
  userInvocable: boolean;
  argumentHint?: string;
  /** Absolute path to the SKILL.md, or "mcp" for MCP tools. */
  source: string;
}

export interface DiscoverOptions {
  workspace: string;
  /** Tools the MCP server exposes. If includeTools is true, these are added as scope: "mcp". */
  mcpTools?: Array<{ name: string; description: string }>;
  /** Filter to one scope, or "all" (default). */
  scope?: CommandScope | "all";
  /** Include skills marked user-invocable: false. Default false. */
  includeInternal?: boolean;
  /** Include MCP tools. Default true. */
  includeTools?: boolean;
}

// ---------------------------------------------------------------------------
// parseTriggers — extract trigger phrases from a SKILL.md description
// ---------------------------------------------------------------------------

/**
 * Descriptions in this project follow the pattern:
 *   "Does X. Triggers on /foo, /agent:bar, 'phrase', another phrase."
 * We extract the list after "Triggers on" (case-insensitive) up to the first
 * sentence terminator or end of string. Tokens are split on commas.
 */
export function parseTriggers(description: string): string[] {
  const match = description.match(/triggers?\s+on\s+([^\n]+?)(?:\.\s|\.$|\n|$)/i);
  if (!match) return [];

  const raw = match[1].trim();
  // Split on commas; handle quoted tokens
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ",") {
      const t = current.trim();
      if (t) tokens.push(t);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) tokens.push(tail);

  return tokens;
}

// ---------------------------------------------------------------------------
// Scope scanners
// ---------------------------------------------------------------------------

function scanScope(workspace: string, scope: InstallScope): CommandRecord[] {
  const dir = scopeDir(workspace, scope);
  if (!fs.existsSync(dir)) return [];

  const records: CommandRecord[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMd)) continue;

      let content = "";
      try {
        content = fs.readFileSync(skillMd, "utf-8");
      } catch {
        continue;
      }

      const fm = parseFrontmatter(content);
      if (!fm || !fm.name || !fm.description) continue;

      const description = String(fm.description);
      records.push({
        name: String(fm.name),
        description: firstLine(description),
        triggers: parseTriggers(description),
        scope,
        userInvocable: fm["user-invocable"] !== false,
        argumentHint: fm["argument-hint"] ? String(fm["argument-hint"]) : undefined,
        source: skillMd,
      });
    }
  } catch {
    // Directory unreadable — skip silently.
  }

  return records;
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  const oneLine = idx === -1 ? s : s.slice(0, idx);
  return oneLine.trim();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function discoverCommands(opts: DiscoverOptions): CommandRecord[] {
  const scope = opts.scope ?? "all";
  const includeInternal = !!opts.includeInternal;
  const includeTools = opts.includeTools !== false;

  const records: CommandRecord[] = [];

  const scopesToScan: InstallScope[] =
    scope === "all"
      ? ["plugin", "project", "user"]
      : scope === "mcp"
      ? []
      : [scope];

  for (const s of scopesToScan) {
    records.push(...scanScope(opts.workspace, s));
  }

  if (includeTools && (scope === "all" || scope === "mcp")) {
    for (const tool of opts.mcpTools ?? []) {
      records.push({
        name: tool.name,
        description: firstLine(tool.description),
        triggers: [],
        scope: "mcp",
        userInvocable: true, // agent can invoke; humans call via the agent
        source: "mcp",
      });
    }
  }

  return records.filter((r) => includeInternal || r.userInvocable);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Grouped markdown table per scope. */
export function formatCommandsTable(commands: CommandRecord[]): string {
  if (commands.length === 0) return "(no commands found)";

  const groups = new Map<CommandScope, CommandRecord[]>();
  for (const c of commands) {
    if (!groups.has(c.scope)) groups.set(c.scope, []);
    groups.get(c.scope)!.push(c);
  }

  const order: CommandScope[] = ["plugin", "project", "user", "mcp"];
  const parts: string[] = [];
  for (const s of order) {
    const group = groups.get(s);
    if (!group || group.length === 0) continue;

    parts.push(`## ${labelFor(s)} (${group.length})`);
    parts.push("");
    for (const c of group) {
      const trigs = c.triggers.length
        ? ` — triggers: ${c.triggers.map((t) => `\`${t}\``).join(", ")}`
        : "";
      parts.push(`- **${c.name}**: ${c.description}${trigs}`);
    }
    parts.push("");
  }

  return parts.join("\n").trim();
}

/** One line per command — good for messaging channels. */
export function formatCommandsCompact(commands: CommandRecord[]): string {
  if (commands.length === 0) return "(no commands found)";
  return commands
    .map((c) => {
      const firstTrigger = c.triggers[0] ?? c.name;
      return `${firstTrigger} — ${c.description}`;
    })
    .join("\n");
}

function labelFor(scope: CommandScope): string {
  const info = runtimeInfo(detectRuntime());
  switch (scope) {
    case "plugin":
      return "Core + imported (./skills/)";
    case "project":
      return `Project (${info.projectSkillsDirName}/skills/)`;
    case "user":
      return `User (${info.homeDir}/skills/)`;
    case "mcp":
      return "MCP tools (agent-invocable)";
  }
}
