/**
 * Skill manager — install, list, and remove community skills.
 *
 * A skill is a directory containing SKILL.md with YAML frontmatter (name,
 * description, ...) — the same format Claude Code and Codex support. We
 * install into one of three scopes:
 *   - "plugin"  → ./skills/<name>/ in the current workspace (ClawCode-managed)
 *   - "project" → .claude/skills/<name>/ or .codex/skills/<name/>
 *   - "user"    → ~/.claude/skills/<name>/ or ~/.codex/skills/<name/>
 *
 * Sources accepted:
 *   - user/repo                 (GitHub shorthand)
 *   - user/repo@branch          (specific branch/tag)
 *   - user/repo#subdir/path     (subdirectory inside the repo)
 *   - https://github.com/...    (full URL, with @ and # supported)
 *   - /absolute/path            (local directory — useful for dev)
 *
 * We detect skills that look OpenClaw-flavored (reference `sessions_spawn`,
 * `gateway`, etc.) and refuse to install them — the user should use
 * /agent:import-skill instead, which runs the GREEN/YELLOW/RED classifier.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  detectRuntime,
  projectSkillsDir,
  runtimeInfo,
  type RuntimeName,
} from "./runtime.ts";

export type InstallScope = "plugin" | "project" | "user";

export interface SkillFrontmatter {
  name: string;
  description: string;
  "user-invocable"?: boolean;
  "argument-hint"?: string;
  requires?: {
    binary?: string[];
    env?: string[];
    os?: string[];
    node?: string;
  };
  [key: string]: unknown;
}

export interface ParsedSource {
  kind: "github" | "local";
  owner?: string;
  repo?: string;
  branch?: string;
  subdir?: string;
  localPath?: string;
  /** Human-readable original input */
  raw: string;
}

export interface RequirementResult {
  kind: "binary" | "env" | "os" | "node";
  value: string;
  met: boolean;
  detail?: string;
}

export interface DetectedFormat {
  format: "skill" | "openclaw" | "invalid";
  frontmatter?: SkillFrontmatter;
  reason?: string;
  evidence?: string[];
}

export interface InstalledSkill {
  name: string;
  scope: InstallScope;
  dir: string;
  description: string;
  userInvocable: boolean;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

export function parseSource(input: string): ParsedSource {
  const trimmed = input.trim();

  // Local absolute path
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    const localPath = trimmed.startsWith("~")
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
    return { kind: "local", localPath, raw: input };
  }

  // Strip trailing .git if present on URLs
  let s = trimmed.replace(/\.git(\/.*)?$/, "");

  // Extract fragment (#subdir) first — must be before @ because subdir can contain @
  let subdir: string | undefined;
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    subdir = s.slice(hashIdx + 1);
    s = s.slice(0, hashIdx);
  }

  // Extract branch (@branch) — the last @ applies
  let branch: string | undefined;
  const atIdx = s.lastIndexOf("@");
  // Don't confuse with https://user@host — check that the @ comes after any ://
  const protoIdx = s.indexOf("://");
  if (atIdx > protoIdx && atIdx >= 0) {
    branch = s.slice(atIdx + 1);
    s = s.slice(0, atIdx);
  }

  // Full URL like https://github.com/owner/repo
  const urlMatch = s.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (urlMatch) {
    return {
      kind: "github",
      owner: urlMatch[1],
      repo: urlMatch[2],
      branch,
      subdir,
      raw: input,
    };
  }

  // Shorthand owner/repo
  const shorthandMatch = s.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)$/);
  if (shorthandMatch) {
    return {
      kind: "github",
      owner: shorthandMatch[1],
      repo: shorthandMatch[2],
      branch,
      subdir,
      raw: input,
    };
  }

  throw new Error(
    `Cannot parse source "${input}". Use: owner/repo, owner/repo@branch#subdir, https://github.com/owner/repo, or /absolute/path`
  );
}

// ---------------------------------------------------------------------------
// Clone / copy to temp
// ---------------------------------------------------------------------------

/** Fetch a source into a temp directory and return the absolute path to it. */
export function cloneToTemp(source: ParsedSource): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawcode-skill-"));

  if (source.kind === "local") {
    if (!source.localPath || !fs.existsSync(source.localPath)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Local path does not exist: ${source.localPath}`);
    }
    copyDirSync(source.localPath, tempDir);
    return tempDir;
  }

  // GitHub clone
  const url = `https://github.com/${source.owner}/${source.repo}.git`;
  try {
    const args = ["clone", "--depth=1"];
    if (source.branch) args.push("--branch", source.branch);
    args.push(url, tempDir);
    execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `git clone failed for ${source.raw}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (source.subdir) {
    const sub = path.join(tempDir, source.subdir);
    if (!fs.existsSync(sub) || !fs.statSync(sub).isDirectory()) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error(`Subdirectory not found in repo: ${source.subdir}`);
    }
    return sub;
  }

  return tempDir;
}

/**
 * Codex 3rd-pass CRITICAL 3: skill names must be safe directory
 * basenames. Without this guard, a skill with `name: ../agent/scope-trust`
 * could escape `~/.claude/skills/` and plant arbitrary files (e.g.
 * the scope owner-trust marker that Phase 4a-2.5 v3 added). The
 * permitted shape is the same as a slug — letters, digits, hyphens,
 * dots, underscores — and explicitly NOT `.` or `..` even though
 * those would otherwise pass the regex.
 */
export function isSafeSkillName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 128) return false;
  if (name === "." || name === "..") return false;
  // No path separators, no leading/trailing dots, no control chars.
  if (/[\\/\0]/.test(name)) return false;
  // Slug-style allowed set.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  return true;
}

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    if (entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

// ---------------------------------------------------------------------------
// Format detection + frontmatter parsing
// ---------------------------------------------------------------------------

const OPENCLAW_TOKENS = [
  "sessions_spawn",
  "NO_REPLY",
  "HEARTBEAT_OK",
  "ANNOUNCE_SKIP",
  "SILENT_REPLY",
  "openclaw",
] as const;

export function detectFormat(skillDir: string): DetectedFormat {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillMdPath)) {
    return {
      format: "invalid",
      reason: "SKILL.md not found in the source root",
    };
  }

  let content = "";
  try {
    content = fs.readFileSync(skillMdPath, "utf-8");
  } catch (err) {
    return {
      format: "invalid",
      reason: `cannot read SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const fm = parseFrontmatter(content);
  if (!fm) {
    return {
      format: "invalid",
      reason: "SKILL.md has no YAML frontmatter",
    };
  }

  if (!fm.name || !fm.description) {
    return {
      format: "invalid",
      reason: "SKILL.md frontmatter missing required fields: name, description",
      frontmatter: fm,
    };
  }

  // OpenClaw token sniff — case-insensitive, word-boundary-ish match
  const evidence: string[] = [];
  const lines = content.split("\n");
  for (const tok of OPENCLAW_TOKENS) {
    const re = new RegExp(`\\b${escapeRegex(tok)}\\b`, "i");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        evidence.push(`"${tok}" at line ${i + 1}`);
        break;
      }
    }
  }

  if (evidence.length > 0) {
    return {
      format: "openclaw",
      frontmatter: fm,
      reason:
        "SKILL.md references OpenClaw-specific tokens not available in this runtime",
      evidence,
    };
  }

  return { format: "skill", frontmatter: fm };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tiny YAML frontmatter parser — sufficient for our flat + `requires:` shape. */
export function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return null;

  const body = match[1];
  const fm: any = {};

  const lines = body.split("\n");
  let currentKey: string | null = null;
  let currentMap: Record<string, any> | null = null;
  let currentArrayKey: string | null = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Top-level key: value
    const topMatch = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      const key = topMatch[1];
      const valRaw = topMatch[2];
      currentKey = key;
      currentMap = null;
      currentArrayKey = null;

      if (valRaw === "") {
        // Could be a nested map (next lines indented) — start empty
        fm[key] = {};
        currentMap = fm[key];
      } else {
        fm[key] = coerceYamlValue(valRaw);
      }
      continue;
    }

    // Indented key inside a map: "  subkey: value"
    const subMatch = line.match(/^\s{2,}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (subMatch && currentMap) {
      const k = subMatch[1];
      const v = subMatch[2];
      if (v === "") {
        // next lines are array entries for k
        currentMap[k] = [];
        currentArrayKey = k;
      } else {
        currentMap[k] = coerceYamlValue(v);
        currentArrayKey = null;
      }
      continue;
    }

    // Array item: "    - "item"" (indented deeper than the map key)
    const arrMatch = line.match(/^\s{2,}-\s+(.+)$/);
    if (arrMatch && currentMap && currentArrayKey) {
      const v = coerceYamlValue(arrMatch[1]);
      (currentMap[currentArrayKey] as any[]).push(v);
      continue;
    }
  }

  // If `description` or `name` is missing, we return what we have so callers
  // can decide (they treat missing name/description as invalid).
  return fm as SkillFrontmatter;
}

function coerceYamlValue(v: string): any {
  const s = v.trim();
  if (s === "") return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);

  // Inline array: ["a", "b"]
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((p) => coerceYamlValue(p.trim().replace(/^["']|["']$/g, "")));
  }

  // Quoted string
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }

  return s;
}

// ---------------------------------------------------------------------------
// Requirements checking
// ---------------------------------------------------------------------------

export function checkRequirements(
  fm: SkillFrontmatter
): RequirementResult[] {
  const results: RequirementResult[] = [];
  const req = fm.requires;
  if (!req) return results;

  if (req.os && Array.isArray(req.os)) {
    const currentOs = process.platform;
    const met = req.os.includes(currentOs);
    results.push({
      kind: "os",
      value: req.os.join("|"),
      met,
      detail: met ? `current: ${currentOs}` : `current: ${currentOs} (not in ${req.os.join(", ")})`,
    });
  }

  if (req.node && typeof req.node === "string") {
    const currentNode = process.versions.node;
    const met = checkNodeVersion(currentNode, req.node);
    results.push({
      kind: "node",
      value: req.node,
      met,
      detail: `current: ${currentNode}`,
    });
  }

  if (req.binary && Array.isArray(req.binary)) {
    for (const bin of req.binary) {
      const met = isBinaryInPath(bin);
      results.push({
        kind: "binary",
        value: bin,
        met,
        detail: met ? "found in PATH" : "not in PATH",
      });
    }
  }

  if (req.env && Array.isArray(req.env)) {
    for (const envVar of req.env) {
      const met = !!process.env[envVar];
      results.push({
        kind: "env",
        value: envVar,
        met,
        detail: met ? "set" : "not set",
      });
    }
  }

  return results;
}

function isBinaryInPath(name: string): boolean {
  try {
    execFileSync(
      process.platform === "win32" ? "where" : "which",
      [name],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return true;
  } catch {
    return false;
  }
}

/** Extremely minimal semver comparison. Supports "1", "1.2", "1.2.3", ">=1.2". */
function checkNodeVersion(current: string, spec: string): boolean {
  const s = spec.trim();
  if (s.startsWith(">=")) return compareVersions(current, s.slice(2).trim()) >= 0;
  if (s.startsWith(">")) return compareVersions(current, s.slice(1).trim()) > 0;
  if (s.startsWith("=")) return compareVersions(current, s.slice(1).trim()) === 0;
  // No operator → treat as exact prefix match (e.g. "18" matches 18.x)
  return current.startsWith(s);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Scope → install directory
// ---------------------------------------------------------------------------

export function scopeDir(
  workspace: string,
  scope: InstallScope,
  runtime: RuntimeName = detectRuntime()
): string {
  if (scope === "plugin") return path.join(workspace, "skills");
  if (scope === "project") return projectSkillsDir(workspace, runtime);
  return runtimeInfo(runtime).userSkillsDir;
}

// ---------------------------------------------------------------------------
// Install / list / remove
// ---------------------------------------------------------------------------

export interface InstallOptions {
  scope?: InstallScope;
  /** Overwrite existing skill with the same name. */
  force?: boolean;
  /** Skip actual filesystem writes — returns what would be done. */
  dryRun?: boolean;
}

export interface InstallResult {
  ok: boolean;
  reason?: string;
  skill?: InstalledSkill;
  format?: DetectedFormat;
  requirements?: RequirementResult[];
  warnings?: string[];
}

export function install(
  workspace: string,
  sourceInput: string,
  opts: InstallOptions = {}
): InstallResult {
  const scope: InstallScope = opts.scope ?? "plugin";

  let source: ParsedSource;
  try {
    source = parseSource(sourceInput);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let tempDir: string;
  try {
    tempDir = cloneToTemp(source);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    const detected = detectFormat(tempDir);

    if (detected.format === "invalid") {
      return { ok: false, reason: detected.reason, format: detected };
    }

    if (detected.format === "openclaw") {
      return {
        ok: false,
        reason:
          `${detected.reason}. Use /agent:import-skill on "${tempDir}" instead — it runs the GREEN/YELLOW/RED classifier for OpenClaw skills. Evidence: ${(detected.evidence || []).join(", ")}`,
        format: detected,
      };
    }

    const fm = detected.frontmatter!;
    const name = fm.name;

    // Codex 3rd-pass CRITICAL 3: validate skill name as a safe basename.
    // Without this, a skill named `../agent/scope-trust` escapes the
    // skills root and lets `copyDirSync` plant arbitrary files in
    // `~/.claude/agent/...` — including the scope-trust marker that
    // `isOwnerTrusted` accepts. Reject anything that isn't a plain
    // slug-style identifier.
    if (!isSafeSkillName(name)) {
      return {
        ok: false,
        reason: `Invalid skill name "${name}": must contain only letters, digits, hyphens, dots, and underscores; cannot be "." or ".." or empty`,
        format: detected,
      };
    }

    const requirements = checkRequirements(fm);
    const warnings: string[] = [];

    // Hard fail on OS incompatibility
    const osReq = requirements.find((r) => r.kind === "os");
    if (osReq && !osReq.met) {
      return {
        ok: false,
        reason: `OS incompatible: requires ${osReq.value}, current ${osReq.detail}`,
        format: detected,
        requirements,
      };
    }

    // Hard fail on node mismatch
    const nodeReq = requirements.find((r) => r.kind === "node");
    if (nodeReq && !nodeReq.met) {
      return {
        ok: false,
        reason: `Node version mismatch: requires ${nodeReq.value}, ${nodeReq.detail}`,
        format: detected,
        requirements,
      };
    }

    // Soft-warn on missing binaries/env
    for (const r of requirements) {
      if (!r.met && (r.kind === "binary" || r.kind === "env")) {
        warnings.push(`${r.kind}: ${r.value} ${r.detail}`);
      }
    }

    const targetRoot = scopeDir(workspace, scope);
    const targetDir = path.join(targetRoot, name);

    // Codex 3rd-pass CRITICAL 3 (defense in depth): even if name passed
    // the slug check, ensure the resolved targetDir stays under
    // targetRoot. Catches OS-specific quirks (e.g. NULs, unicode) that
    // slip the name regex but get normalized to a path that escapes.
    const resolvedRoot = path.resolve(targetRoot);
    const resolvedTarget = path.resolve(targetDir);
    if (
      resolvedTarget !== path.join(resolvedRoot, name) ||
      !resolvedTarget.startsWith(resolvedRoot + path.sep)
    ) {
      return {
        ok: false,
        reason: `Skill name "${name}" resolves outside the skills root (${resolvedRoot}). Refusing to install.`,
        format: detected,
      };
    }

    if (fs.existsSync(targetDir) && !opts.force) {
      return {
        ok: false,
        reason: `Skill "${name}" already installed at ${targetDir}. Pass force=true to overwrite.`,
        format: detected,
        requirements,
      };
    }

    if (!opts.dryRun) {
      fs.mkdirSync(targetRoot, { recursive: true });
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      copyDirSync(tempDir, targetDir);

      // Register in workspace AGENTS.md when installing to plugin scope
      if (scope === "plugin") {
        registerInAgentsMd(workspace, name, fm.description);
      }
    }

    return {
      ok: true,
      skill: {
        name,
        scope,
        dir: targetDir,
        description: fm.description,
        userInvocable: fm["user-invocable"] !== false,
      },
      format: detected,
      requirements,
      warnings: warnings.length ? warnings : undefined,
    };
  } finally {
    // Clean up clone
    try {
      // tempDir may be a subdir — walk up to the mkdtemp root
      let root = tempDir;
      while (!path.basename(root).startsWith("clawcode-skill-") && root !== "/") {
        root = path.dirname(root);
      }
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}

export function list(workspace: string): InstalledSkill[] {
  const all: InstalledSkill[] = [];
  const scopes: InstallScope[] = ["plugin", "project", "user"];
  for (const scope of scopes) {
    const dir = scopeDir(workspace, scope);
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;
        try {
          const content = fs.readFileSync(skillMd, "utf-8");
          const fm = parseFrontmatter(content);
          if (!fm || !fm.name) continue;
          all.push({
            name: fm.name,
            scope,
            dir: path.join(dir, entry.name),
            description: String(fm.description ?? ""),
            userInvocable: fm["user-invocable"] !== false,
          });
        } catch {}
      }
    } catch {}
  }
  return all;
}

export interface RemoveOptions {
  scope?: InstallScope;
  /** If true, actually delete. If false (default), return what would be deleted. */
  confirm?: boolean;
}

export interface RemoveResult {
  ok: boolean;
  reason?: string;
  removed?: InstalledSkill;
}

export function remove(
  workspace: string,
  name: string,
  opts: RemoveOptions = {}
): RemoveResult {
  // Phase 4a-2.5 v5 — Codex 4th-pass HIGH 1: validate skill name as a
  // safe basename before any filesystem operation. v4 only validated
  // in `install`; the agent could still pass `name = "../agent-config.json"`
  // or `"../agent/scope-trust/whatsapp-owner"` through `skill_remove`
  // (the MCP handler exposes `confirm: boolean` so `rmSync` runs on
  // attacker-chosen paths). Blocks arbitrary deletion of workspace
  // files and the trust marker itself.
  if (!isSafeSkillName(name)) {
    return {
      ok: false,
      reason: `Invalid skill name "${name}": must contain only letters, digits, hyphens, dots, and underscores; cannot be "." or ".." or empty`,
    };
  }

  const scopes: InstallScope[] = opts.scope ? [opts.scope] : ["plugin", "project", "user"];
  for (const scope of scopes) {
    const dir = scopeDir(workspace, scope);
    const target = path.join(dir, name);

    // Defense-in-depth: even if name passed the slug check, ensure
    // the resolved target stays under the scope dir.
    const resolvedRoot = path.resolve(dir);
    const resolvedTarget = path.resolve(target);
    if (
      resolvedTarget !== path.join(resolvedRoot, name) ||
      !resolvedTarget.startsWith(resolvedRoot + path.sep)
    ) {
      return {
        ok: false,
        reason: `Skill name "${name}" resolves outside the skills root (${resolvedRoot}). Refusing to remove.`,
      };
    }

    if (!fs.existsSync(target)) continue;

    const skill: InstalledSkill = {
      name,
      scope,
      dir: target,
      description: "",
      userInvocable: true,
    };

    if (!opts.confirm) {
      return {
        ok: false,
        reason: `would delete ${target} (pass confirm=true to actually remove)`,
        removed: skill,
      };
    }

    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (scope === "plugin") {
        unregisterFromAgentsMd(workspace, name);
      }
      return { ok: true, removed: skill };
    } catch (err) {
      return {
        ok: false,
        reason: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return { ok: false, reason: `skill "${name}" not found in any scope` };
}

// ---------------------------------------------------------------------------
// AGENTS.md registration (plugin scope only)
// ---------------------------------------------------------------------------

const AGENTS_BLOCK_HEADER = "## Local imported skills";

function registerInAgentsMd(
  workspace: string,
  name: string,
  description: string
) {
  const agentsPath = path.join(workspace, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) return; // nothing to register against
  let content: string;
  try {
    content = fs.readFileSync(agentsPath, "utf-8");
  } catch {
    return;
  }

  const entry = `- **${name}**: ${description.split("\n")[0]}`;

  if (content.includes(AGENTS_BLOCK_HEADER)) {
    // Append to existing block (after header, before next ## section or EOF)
    const lines = content.split("\n");
    const headerIdx = lines.findIndex((l) => l.trim() === AGENTS_BLOCK_HEADER);
    let insertAt = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        insertAt = i;
        break;
      }
    }
    // Don't dupe
    for (let i = headerIdx + 1; i < insertAt; i++) {
      if (lines[i].startsWith(`- **${name}**:`)) {
        lines[i] = entry;
        fs.writeFileSync(agentsPath, lines.join("\n"));
        return;
      }
    }
    lines.splice(insertAt, 0, entry);
    fs.writeFileSync(agentsPath, lines.join("\n"));
    return;
  }

  // Create new block at end
  const block = `\n\n${AGENTS_BLOCK_HEADER}\n\n${entry}\n`;
  fs.writeFileSync(agentsPath, content.replace(/\n*$/, "") + block);
}

function unregisterFromAgentsMd(workspace: string, name: string) {
  const agentsPath = path.join(workspace, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) return;
  try {
    const content = fs.readFileSync(agentsPath, "utf-8");
    const re = new RegExp(`^- \\*\\*${escapeRegex(name)}\\*\\*:.*(?:\\r?\\n)?`, "m");
    const updated = content.replace(re, "");
    if (updated !== content) fs.writeFileSync(agentsPath, updated);
  } catch {}
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function formatInstallResult(r: InstallResult): string {
  const lines: string[] = [];
  if (!r.ok) {
    lines.push(`❌ Install failed: ${r.reason}`);
    if (r.requirements?.length) {
      lines.push("");
      lines.push("Requirements:");
      for (const req of r.requirements) {
        lines.push(`  ${req.met ? "✅" : "❌"} ${req.kind}: ${req.value} (${req.detail ?? ""})`);
      }
    }
    return lines.join("\n");
  }
  const s = r.skill!;
  lines.push(`✅ Installed "${s.name}" to ${s.dir}`);
  lines.push(`   scope: ${s.scope}`);
  lines.push(`   ${s.description.split("\n")[0]}`);
  if (r.warnings?.length) {
    lines.push("");
    lines.push("⚠️  Warnings (skill installed, but may not work at runtime):");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

export function formatList(skills: InstalledSkill[]): string {
  if (skills.length === 0) {
    return "No skills installed.";
  }
  const lines: string[] = [];
  lines.push(`${skills.length} skill(s) installed:`);
  lines.push("");
  const byScope = new Map<InstallScope, InstalledSkill[]>();
  for (const s of skills) {
    if (!byScope.has(s.scope)) byScope.set(s.scope, []);
    byScope.get(s.scope)!.push(s);
  }
  for (const scope of ["plugin", "project", "user"] as InstallScope[]) {
    const group = byScope.get(scope);
    if (!group) continue;
    lines.push(`--- ${scope} (${scopeDir(process.cwd(), scope)}) ---`);
    for (const s of group) {
      const tag = s.userInvocable ? "user-invocable" : "internal";
      lines.push(`  ${s.name.padEnd(20)} [${tag}]  ${s.description.split("\n")[0].slice(0, 80)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
