import os from "os";
import path from "path";

export type RuntimeName = "claude" | "codex";

export interface RuntimeInfo {
  name: RuntimeName;
  displayName: string;
  homeDir: string;
  projectSkillsDirName: ".claude" | ".codex";
  userSkillsDir: string;
  reloadInstruction: string;
}

export function detectRuntime(env: NodeJS.ProcessEnv = process.env): RuntimeName {
  const explicit = String(env.CLAWCODE_RUNTIME || "").toLowerCase();
  if (explicit === "codex" || explicit === "claude") return explicit;
  if (env.CODEX_HOME) return "codex";
  return "claude";
}

export function resolvePluginRoot(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  return path.resolve(
    env.CLAWCODE_PLUGIN_ROOT ||
      env.CLAUDE_PLUGIN_ROOT ||
      cwd
  );
}

export function resolveWorkspaceRoot(
  pluginRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): string {
  const candidates = [
    env.CLAWCODE_WORKSPACE,
    env.CODEX_PROJECT_DIR,
    env.CODEX_WORKSPACE_ROOT,
    env.CODEX_WORKSPACE,
    env.CLAUDE_PROJECT_DIR,
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.trim()) return path.resolve(candidate);
  }

  const resolvedPluginRoot = path.resolve(pluginRoot);
  if (env.OLDPWD && path.resolve(env.OLDPWD) !== resolvedPluginRoot) {
    return path.resolve(env.OLDPWD);
  }

  const resolvedCwd = path.resolve(cwd);
  if (resolvedCwd !== resolvedPluginRoot) return resolvedCwd;

  return resolvedCwd;
}

export function runtimeInfo(
  runtime: RuntimeName = detectRuntime(),
  env: NodeJS.ProcessEnv = process.env
): RuntimeInfo {
  if (runtime === "codex") {
    const homeDir = path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    return {
      name: "codex",
      displayName: "OpenAI Codex",
      homeDir,
      projectSkillsDirName: ".codex",
      userSkillsDir: path.join(homeDir, "skills"),
      reloadInstruction: "Restart Codex, or reload the MCP server if your Codex UI exposes that control.",
    };
  }

  const homeDir = path.resolve(env.CLAUDE_HOME || path.join(os.homedir(), ".claude"));
  return {
    name: "claude",
    displayName: "Claude Code",
    homeDir,
    projectSkillsDirName: ".claude",
    userSkillsDir: path.join(homeDir, "skills"),
    reloadInstruction: "Run `/mcp reconnect clawcode` or `/mcp` to apply.",
  };
}

export function projectSkillsDir(workspace: string, runtime: RuntimeName): string {
  return path.join(workspace, runtimeInfo(runtime).projectSkillsDirName, "skills");
}

export function pluginManifestPaths(pluginRoot: string, runtime: RuntimeName): string[] {
  const first = runtime === "codex" ? ".codex-plugin" : ".claude-plugin";
  const second = runtime === "codex" ? ".claude-plugin" : ".codex-plugin";
  return [
    path.join(pluginRoot, first, "plugin.json"),
    path.join(pluginRoot, second, "plugin.json"),
  ];
}

export function runtimeToolInstruction(runtime: RuntimeName): string {
  if (runtime === "codex") {
    return "Use the tools Codex exposes in this session (shell/exec, file editing, MCP tools, web/search tools, and sub-agents when available). If an imported instruction names a Claude-only tool, translate it to the closest Codex capability instead of inventing a tool.";
  }
  return "Use Claude Code tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebSearch, WebFetch.";
}
