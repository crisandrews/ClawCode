/**
 * QMD Memory Manager — spawns external qmd process for search.
 * Mirrors OpenClaw's qmd-manager.ts
 *
 * QMD is a local-first search tool that handles its own embeddings
 * via node-llama-cpp. No API keys needed.
 * https://github.com/tobi/qmd
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import type { AgentConfig } from "./config.ts";
import { deriveProvenance } from "./scope/provenance.ts";
import { issueScopeToken } from "./scope/tokens.ts";
import type { SearchResult } from "./types.ts";

const DEFAULT_COMMAND = "qmd";
const DEFAULT_SEARCH_MODE = "vsearch";
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SNIPPET_CHARS = 700;

export class QmdManager {
  private command: string;
  private searchMode: string;
  private maxResults: number;
  private timeoutMs: number;
  private pluginRoot: string;
  private qmdHome: string;
  private extraPaths: string[];
  private initialized = false;

  constructor(pluginRoot: string, config: AgentConfig) {
    this.pluginRoot = pluginRoot;
    this.command = config.memory.qmd?.command ?? DEFAULT_COMMAND;
    this.searchMode = config.memory.qmd?.searchMode ?? DEFAULT_SEARCH_MODE;
    this.maxResults = config.memory.qmd?.limits?.maxResults ?? DEFAULT_MAX_RESULTS;
    this.timeoutMs = config.memory.qmd?.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraPaths = (config.memory.extraPaths || []).map((p) => {
      if (p.startsWith("~/")) return path.join(process.env.HOME || "", p.slice(2));
      return path.resolve(p);
    });

    // QMD home directory (isolated per agent, like OpenClaw)
    this.qmdHome = path.join(pluginRoot, ".qmd");
  }

  /**
   * Check if qmd binary is available.
   */
  static isAvailable(command: string = DEFAULT_COMMAND): boolean {
    try {
      const result = spawnSync(command, ["--version"], {
        timeout: 5000,
        stdio: "pipe",
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Initialize QMD: create directories, add collections, run initial update.
   */
  initialize(): void {
    if (this.initialized) return;

    // Create QMD home directories
    const xdgConfig = path.join(this.qmdHome, "xdg-config");
    const xdgCache = path.join(this.qmdHome, "xdg-cache");
    fs.mkdirSync(xdgConfig, { recursive: true });
    fs.mkdirSync(xdgCache, { recursive: true });

    // Add memory collection (may already exist — ignore errors)
    const memoryDir = path.join(this.pluginRoot, "memory");
    if (fs.existsSync(memoryDir)) {
      try {
        this.runQmd(["collection", "add", "memory", memoryDir, "--pattern", "**/*.md"]);
      } catch {
        // Collection may already exist — OK
      }
    }

    // Add root MEMORY.md if exists
    const rootMemory = path.join(this.pluginRoot, "MEMORY.md");
    if (fs.existsSync(rootMemory)) {
      try {
        this.runQmd(["collection", "add", "root-memory", this.pluginRoot, "--pattern", "MEMORY.md"]);
      } catch {
        // Collection may already exist — OK
      }
    }

    // Add extra collections (e.g., whatsapp logs)
    for (const extraPath of this.extraPaths) {
      if (!fs.existsSync(extraPath)) continue;
      const name = `extra-${path.basename(extraPath)}`;
      try {
        // Only index .md (not .jsonl duplicates from claude-whatsapp)
        this.runQmd(["collection", "add", name, extraPath, "--pattern", "**/*.md"]);
      } catch {
        // Collection may already exist — OK
      }
    }

    // Run initial update (non-blocking — embeddings may take time)
    try {
      this.runQmd(["update"], { timeout: 30_000 });
    } catch {
      // Update failures are non-fatal
    }

    this.initialized = true;
  }

  /**
   * Run a qmd command with proper environment.
   */
  private runQmd(
    args: string[],
    options?: { timeout?: number; input?: string }
  ): string {
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(this.qmdHome, "xdg-config"),
      XDG_CACHE_HOME: path.join(this.qmdHome, "xdg-cache"),
    };

    const result = spawnSync(this.command, args, {
      env,
      timeout: options?.timeout ?? this.timeoutMs,
      input: options?.input,
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf-8",
    });

    if (result.error) {
      throw new Error(`QMD error: ${result.error.message}`);
    }

    return result.stdout ?? "";
  }

  /**
   * Search memory using QMD.
   */
  search(query: string, maxResults?: number): SearchResult[] {
    if (!this.initialized) {
      this.initialize();
    }

    const limit = maxResults ?? this.maxResults;

    try {
      const output = this.runQmd(
        [this.searchMode, "--json", "--limit", String(limit), query],
        { timeout: this.timeoutMs }
      );

      if (!output.trim()) return [];

      // QMD returns JSON array of results
      const raw = JSON.parse(output);
      if (!Array.isArray(raw)) return [];

      return raw.map((item: any) => {
        let snippet = String(item.content ?? item.text ?? "");
        if (snippet.length > MAX_SNIPPET_CHARS) {
          snippet = snippet.slice(0, MAX_SNIPPET_CHARS - 3) + "...";
        }

        // Codex P1 5b: when QMD returns an absolute path under one of
        // our configured extraPaths, normalize it to `extra:<root>/<rel>`
        // so deriveProvenance can attribute it to the right channel.
        // Falling through to `path.relative(pluginRoot, ...)` produces
        // a `../...` path that always derives as legacy and dropped
        // channel attribution for QMD-routed hits.
        const filePath = this.toLogicalPath(item.path, item.file);
        const startLine = item.start_line ?? item.startLine ?? 1;
        const endLine = item.end_line ?? item.endLine ?? startLine;
        const score = item.score ?? item.similarity ?? 0.5;

        // Phase 2 — passive provenance metadata. QMD doesn't know
        // about the chunks table, so we derive from the resolved
        // file path. Channel attribution comes from path-pattern
        // (extra:<channel>/...). No enforcement happens here.
        const provenance = deriveProvenance(filePath);
        const scopeToken = issueScopeToken(provenance);

        return {
          path: filePath,
          startLine,
          endLine,
          snippet,
          score,
          citation: `${filePath}#L${startLine}-L${endLine}`,
          provenance,
          scopeToken,
        };
      });
    } catch (err) {
      // QMD failed — return empty (caller should fall back to builtin)
      return [];
    }
  }

  /**
   * Map an absolute filesystem path returned by QMD back to the
   * logical path used everywhere else (the same shape `MemoryDB`
   * stores in `chunks.path`):
   *   - Under `pluginRoot` → workspace-relative (e.g. `memory/x.md`)
   *   - Under one of `extraPaths` → `extra:<basename>/<relative>`
   *   - Anything else → fall back to plugin-relative or "unknown"
   *
   * Codex P1 5b: previously this used `path.relative(pluginRoot, …)`
   * unconditionally, producing `../…` for paths that lived outside
   * the workspace and stripping channel attribution from QMD hits.
   */
  private toLogicalPath(
    absPath: string | undefined,
    file: string | undefined
  ): string {
    if (!absPath) return file ?? "unknown";
    const resolved = path.resolve(absPath);
    // Workspace-relative — keep the existing behavior.
    const inWorkspace = path.relative(this.pluginRoot, resolved);
    if (!inWorkspace.startsWith("..") && !path.isAbsolute(inWorkspace)) {
      return inWorkspace;
    }
    // Try every configured extraPath; longest root-prefix wins so
    // nested roots resolve to the most specific one.
    let best: { prefixLen: number; logical: string } | null = null;
    for (const root of this.extraPaths) {
      const realRoot = path.resolve(root);
      if (
        resolved === realRoot ||
        resolved.startsWith(realRoot + path.sep)
      ) {
        const rel = path.relative(realRoot, resolved);
        const logical = `extra:${path.basename(realRoot)}${rel ? "/" + rel : ""}`;
        if (!best || realRoot.length > best.prefixLen) {
          best = { prefixLen: realRoot.length, logical };
        }
      }
    }
    if (best) return best.logical;
    // Fall back: return the workspace-relative form, even if it
    // climbs out, so callers always get a stable string.
    return inWorkspace || resolved;
  }

  /**
   * Trigger an async update (re-index changed files + generate embeddings).
   */
  update(): void {
    try {
      this.runQmd(["update"], { timeout: 30_000 });
    } catch {
      // Non-fatal
    }
  }

  /**
   * Trigger embedding generation (may be slow on first run).
   */
  embed(): void {
    try {
      this.runQmd(["embed"], { timeout: 300_000 }); // 5 min timeout
    } catch {
      // Non-fatal
    }
  }
}
