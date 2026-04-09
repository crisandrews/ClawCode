import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "./lib/config.ts";
import { DreamEngine } from "./lib/dreaming.ts";
import { extractKeywords } from "./lib/keywords.ts";
import { MemoryDB } from "./lib/memory-db.ts";
import { QmdManager } from "./lib/qmd-manager.ts";
import type { SearchResult } from "./lib/types.ts";

// ---------------------------------------------------------------------------
// Paths
// PLUGIN_ROOT = where the plugin code lives (templates, lib, etc.)
// WORKSPACE   = where the agent's personality files live (user's project dir)
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
const WORKSPACE = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MEMORY_DIR = path.join(WORKSPACE, "memory");
const DREAMS_DIR = path.join(MEMORY_DIR, ".dreams");

// ---------------------------------------------------------------------------
// Config + Memory backends
// ---------------------------------------------------------------------------

let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(WORKSPACE);
} catch {
  config = { memory: { backend: "builtin", citations: "auto", builtin: { temporalDecay: true, halfLifeDays: 30, mmr: true, mmrLambda: 0.7 } } };
}

// Always initialize builtin DB (used as fallback even when QMD is primary)
let memoryDB: MemoryDB;
try {
  memoryDB = new MemoryDB(WORKSPACE);
} catch {
  // SQLite init failed (e.g., better-sqlite3 not compiled) — create a stub
  memoryDB = {
    search: () => [],
    readFile: (p: string) => ({ error: `Database unavailable — read ${p} directly` }),
    stats: () => ({ files: 0, chunks: 0, totalSize: 0 }),
    sync: () => ({ indexed: 0, removed: 0, unchanged: 0 }),
    markDirty: () => {},
    close: () => {},
  } as unknown as MemoryDB;
}

// Dream engine (always available — uses recall data from .dreams/)
const dreamEngine = new DreamEngine(WORKSPACE);

// Initialize QMD if configured (non-blocking, with full error isolation)
let qmdManager: QmdManager | null = null;
if (config.memory.backend === "qmd") {
  try {
    const qmdCommand = config.memory.qmd?.command ?? "qmd";
    if (QmdManager.isAvailable(qmdCommand)) {
      qmdManager = new QmdManager(WORKSPACE, config);
      qmdManager.initialize();
    }
  } catch {
    // QMD init failed — fall back to builtin silently
    qmdManager = null;
  }
}

/**
 * Unified search: uses QMD if available, falls back to builtin SQLite+FTS5.
 */
function searchMemory(query: string, maxResults?: number): SearchResult[] {
  try {
    // Try QMD first
    if (qmdManager) {
      try {
        const results = qmdManager.search(query, maxResults);
        if (results.length > 0) return results;
      } catch {
        // QMD search failed — fall through to builtin
      }
    }

    // Builtin SQLite + FTS5
    return memoryDB.search(query, {
      maxResults,
      enableDecay: config.memory.builtin?.temporalDecay ?? true,
      halfLifeDays: config.memory.builtin?.halfLifeDays ?? 30,
      enableMMR: config.memory.builtin?.mmr ?? true,
      mmrLambda: config.memory.builtin?.mmrLambda ?? 0.7,
    });
  } catch {
    // Total search failure — return empty, never crash
    return [];
  }
}

// ---------------------------------------------------------------------------
// Bootstrap file loading (mirrors OpenClaw's loadWorkspaceBootstrapFiles)
// ---------------------------------------------------------------------------

const BOOTSTRAP_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "TOOLS.md",
  "HEARTBEAT.md",
];

const MAX_PER_FILE = 20_000;
const MAX_TOTAL = 100_000;

function isFirstRun(): boolean {
  try {
    return fs.existsSync(path.join(WORKSPACE, "BOOTSTRAP.md"));
  } catch {
    return false;
  }
}

function loadBootstrapFiles(): string {
  try {
    return _loadBootstrapFilesInner();
  } catch {
    // Total failure — return minimal identity so server still works
    return "You are a personal assistant. Your configuration files could not be loaded — check the plugin installation.";
  }
}

function _loadBootstrapFilesInner(): string {
  const sections: string[] = [];
  let totalChars = 0;

  // -- First run: bootstrap ritual
  if (isFirstRun()) {
    try {
      const bootstrap = fs.readFileSync(
        path.join(WORKSPACE, "BOOTSTRAP.md"),
        "utf-8"
      );
      sections.push("# FIRST RUN — Bootstrap Ritual\n");
      sections.push(
        "BOOTSTRAP.md exists. This is your first time waking up. Follow the instructions in BOOTSTRAP.md below."
      );
      sections.push(
        "After completing the bootstrap conversation, update IDENTITY.md, USER.md, and SOUL.md, then DELETE BOOTSTRAP.md.\n"
      );
      sections.push(`## BOOTSTRAP.md\n\n${bootstrap}\n`);

      for (const file of ["SOUL.md", "IDENTITY.md", "USER.md"]) {
        const filePath = path.join(WORKSPACE, file);
        try {
          const content = fs.readFileSync(filePath, "utf-8").trim();
          if (content)
            sections.push(
              `## ${file} (current — update after bootstrap)\n\n${content}\n`
            );
        } catch {}
      }

      return sections.join("\n");
    } catch {}
  }

  // -- Normal run: persona injection
  sections.push("# Agent Context\n");
  sections.push(
    "The following files define your personality and operational rules."
  );
  sections.push(
    "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance.\n"
  );

  // -- Runtime adaptation
  sections.push("## Runtime Adaptation\n");
  sections.push("You are running inside Claude Code, NOT OpenClaw.");
  sections.push(
    "Use Claude Code tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebSearch, WebFetch."
  );
  sections.push(
    "OpenClaw-specific tools (message, sessions_spawn, browser, gateway, cron, nodes, canvas, etc.) are NOT available."
  );
  sections.push(
    "Ignore references to HEARTBEAT_OK, NO_REPLY, ANNOUNCE_SKIP, SILENT_REPLY — they do not apply here."
  );
  sections.push(
    "Ignore references to `openclaw` CLI commands, gateway restart, config.apply — they do not apply here."
  );
  sections.push(
    "For WhatsApp/messaging: use MCP tools from the whatsapp plugin if available (reply, react).\n"
  );

  // -- Memory instructions
  sections.push("## Memory\n");
  sections.push("You have memory tools: `memory_search` and `memory_get`.");
  sections.push(
    "Before answering about prior work, decisions, dates, people, preferences, or todos:"
  );
  sections.push("1. Run memory_search with a relevant query");
  sections.push("2. Use memory_get to pull specific lines if needed");
  sections.push("3. If low confidence after search, say you checked.");
  sections.push(
    "Citations: include Source: path#Lstart-Lend when it helps verify."
  );
  sections.push("");
  sections.push(
    "To persist information, write to memory/YYYY-MM-DD.md (today's date). APPEND only, never overwrite."
  );
  sections.push(
    "For long-term curated memory, update MEMORY.md in the memory/ directory."
  );
  sections.push("");

  // -- Session summary (mirrors OpenClaw's session-memory hook)
  sections.push("## Session Summary\n");
  sections.push(
    "Before ending a long or significant conversation, write a brief session summary to memory/YYYY-MM-DD.md."
  );
  sections.push("Include: what was discussed, decisions made, tasks completed, and any open items.");
  sections.push("This is critical — without it, the next session has no context about what happened.");
  sections.push("Do this proactively when the conversation feels like it's wrapping up.");
  sections.push("");

  // -- Dreaming
  sections.push("## Dreaming\n");
  sections.push(
    "You have a `dream` tool for memory consolidation. It runs automatically via nightly cron (3 AM)."
  );
  sections.push(
    "Dreaming promotes frequently-recalled memories to MEMORY.md using weighted scoring."
  );
  sections.push(
    "You can run `dream(action='status')` to check dreaming state, or `dream(action='dry-run')` to preview."
  );
  sections.push("");

  // -- Heartbeat (default behavior)
  sections.push("## Heartbeat (default behavior)\n");
  sections.push(
    "A heartbeat cron should run every ~30 minutes (created via CronCreate on first session)."
  );
  sections.push("When triggered for a heartbeat, do:");
  sections.push("1. Read HEARTBEAT.md for specific check instructions");
  sections.push("2. Review recent memory files (today + yesterday)");
  sections.push(
    "3. Consolidate important items from daily logs into memory/MEMORY.md"
  );
  sections.push("4. Remove outdated info from MEMORY.md");
  sections.push(
    "If nothing needs attention, do nothing. Do not announce routine heartbeats to the user."
  );
  sections.push("");

  // -- Load each bootstrap file from plugin root
  for (const file of BOOTSTRAP_FILES) {
    const filePath = path.join(WORKSPACE, file);
    try {
      let content = fs.readFileSync(filePath, "utf-8").trim();
      if (!content) continue;

      if (content.length > MAX_PER_FILE) {
        const headSize = Math.floor(MAX_PER_FILE * 0.7);
        const tailSize = Math.floor(MAX_PER_FILE * 0.2);
        content =
          content.slice(0, headSize) +
          "\n\n[... truncated — file exceeds 20KB ...]\n\n" +
          content.slice(-tailSize);
      }

      if (totalChars + content.length > MAX_TOTAL) {
        sections.push(
          `\n[Skipped ${file} — total context budget (${MAX_TOTAL} chars) reached]`
        );
        break;
      }

      sections.push(`## ${file}\n\n${content}\n`);
      totalChars += content.length;
    } catch {}
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Dream tracking — record memory recalls
// ---------------------------------------------------------------------------

function trackRecall(
  query: string,
  results: Array<{ path: string; startLine: number; endLine: number; snippet: string; score: number }>
): void {
  try {
    fs.mkdirSync(DREAMS_DIR, { recursive: true });

    // Append to events.jsonl
    const event = {
      type: "memory.recall",
      ts: new Date().toISOString(),
      query,
      resultCount: results.length,
    };
    fs.appendFileSync(
      path.join(DREAMS_DIR, "events.jsonl"),
      JSON.stringify(event) + "\n"
    );

    // Update short-term-recall.json
    const recallPath = path.join(DREAMS_DIR, "short-term-recall.json");
    let recall: {
      version: number;
      updatedAt: string;
      entries: Record<string, any>;
    };
    try {
      recall = JSON.parse(fs.readFileSync(recallPath, "utf-8"));
    } catch {
      recall = { version: 1, updatedAt: "", entries: {} };
    }

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    for (const r of results) {
      const key = `memory:${r.path}:${r.startLine}:${r.endLine}`;
      const existing = recall.entries[key] || {
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        snippet: r.snippet.slice(0, 200),
        recallCount: 0,
        totalScore: 0,
        maxScore: 0,
        firstRecalledAt: now,
        lastRecalledAt: now,
        recallDays: [],
        conceptTags: [],
      };

      existing.recallCount++;
      existing.totalScore += r.score;
      existing.maxScore = Math.max(existing.maxScore, r.score);
      existing.lastRecalledAt = now;
      if (!existing.recallDays.includes(today)) {
        existing.recallDays.push(today);
      }
      const tags = extractKeywords(r.snippet).slice(0, 5);
      existing.conceptTags = [
        ...new Set([...existing.conceptTags, ...tags]),
      ].slice(0, 10);

      recall.entries[key] = existing;
    }

    recall.updatedAt = now;
    fs.writeFileSync(recallPath, JSON.stringify(recall, null, 2));
  } catch {
    // Dream tracking is best-effort
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const instructions = loadBootstrapFiles();

const server = new Server(
  { name: "clawcode", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions,
  }
);

// -- Tools list
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_search",
      description:
        "Search agent memory (MEMORY.md + memory/*.md) using full-text search with BM25 ranking, temporal decay, and diversity re-ranking. Returns top snippets with citations. Use before answering about prior work, decisions, dates, people, or preferences.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Search query — keywords or natural language",
          },
          maxResults: {
            type: "number",
            description: "Maximum results to return (default: 6)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_get",
      description:
        "Read specific lines from a memory or bootstrap file. Use after memory_search to pull only the needed lines.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description:
              "Relative file path (e.g., 'memory/2026-04-08.md' or 'SOUL.md')",
          },
          from: {
            type: "number",
            description: "Start line number (1-indexed)",
          },
          lines: {
            type: "number",
            description: "Number of lines to read (default: 50)",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "dream",
      description:
        "Run the dreaming memory consolidation system. Phases: light (ingest signals), deep (rank + promote to MEMORY.md). Produces DREAMS.md diary. Use 'status' to check state, 'run' to execute, 'dry-run' to preview without writing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["status", "run", "dry-run"],
            description: "Action: 'status' (check state), 'run' (full sweep + promote), 'dry-run' (preview without writing)",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "agent_config",
      description:
        "View or update agent settings (memory backend, QMD, active hours, dreaming). Use action='get' to view current config, action='set' with key and value to change a setting. After changes, remind user to run /mcp reconnect clawcode.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["get", "set"],
            description: "'get' to view config, 'set' to update a setting",
          },
          key: {
            type: "string",
            description: "Setting key to update (e.g., 'memory.backend', 'memory.qmd.searchMode', 'heartbeat.activeHours.start')",
          },
          value: {
            type: "string",
            description: "New value for the setting",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "agent_status",
      description:
        "Show agent identity, memory index stats, and dream tracking summary.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ],
}));

// -- Tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const params = (args || {}) as Record<string, any>;

  if (name === "memory_search") {
    const query = String(params.query || "");
    const maxResults = Number(params.maxResults) || 6;

    if (!query.trim()) {
      return {
        content: [{ type: "text", text: "Error: query is required" }],
        isError: true,
      };
    }

    const results = searchMemory(query, maxResults);

    // Dream tracking (best-effort)
    trackRecall(query, results);

    const stats = memoryDB.stats();
    const backendLabel = qmdManager ? "QMD (vsearch)" : "FTS5+BM25";

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results for: "${query}"\nBackend: ${backendLabel} | Index: ${stats.files} files, ${stats.chunks} chunks.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.citation} (score: ${r.score.toFixed(3)})\n${r.snippet}`
      )
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} results for: "${query}" (${backendLabel} | ${stats.files} files, ${stats.chunks} chunks)\n\n${formatted}`,
        },
      ],
    };
  }

  if (name === "memory_get") {
    const filePath = String(params.path || "");
    const from = params.from ? Number(params.from) : undefined;
    const lineCount = params.lines ? Number(params.lines) : undefined;

    const result = memoryDB.readFile(filePath, from, lineCount);

    if ("error" in result) {
      return {
        content: [{ type: "text", text: `Error: ${result.error}` }],
        isError: true,
      };
    }

    return {
      content: [
        { type: "text", text: `## ${result.path}\n\n${result.text}` },
      ],
    };
  }

  if (name === "dream") {
    const action = String(params.action || "status");

    try {
      if (action === "status") {
        const status = dreamEngine.status();
        return {
          content: [
            {
              type: "text",
              text: [
                "## Dreaming Status",
                "",
                `Recall entries tracked: ${status.recallEntries}`,
                `Phase signals recorded: ${status.phaseSignals}`,
                `DREAMS.md exists: ${status.dreamsFileExists}`,
                `Last dream: ${status.lastDream ?? "(never)"}`,
              ].join("\n"),
            },
          ],
        };
      }

      if (action === "run" || action === "dry-run") {
        const dryRun = action === "dry-run";
        const result = dreamEngine.runFullSweep({ dryRun });

        return {
          content: [
            {
              type: "text",
              text: [
                `## Dreaming ${dryRun ? "(dry run)" : "Complete"}`,
                "",
                "### Light Phase",
                `Candidates ingested, reinforcement signals recorded.`,
                "",
                "### REM Phase",
                result.themes.length > 0
                  ? `Themes found: ${result.themes.join(", ")}`
                  : "No recurring themes yet.",
                "",
                "### Deep Phase",
                `Total candidates: ${result.candidates.length}`,
                `Promoted to MEMORY.md: ${result.promoted.length}${dryRun ? " (would promote)" : ""}`,
                `Skipped (below threshold): ${result.skipped.length}`,
                "",
                result.promoted.length > 0
                  ? "### Promoted:\n" +
                    result.promoted
                      .map(
                        (c) =>
                          `- ${c.entry.path}#L${c.entry.startLine} — score: ${c.finalScore.toFixed(3)} (${c.entry.recallCount}x across ${c.entry.recallDays.length} days)`
                      )
                      .join("\n")
                  : "No entries met the promotion threshold.",
                "",
                result.reflectionPrompt
                  ? `### Reflection\n${result.reflectionPrompt}`
                  : "",
                "",
                !dryRun ? "Dream diary written to DREAMS.md" : "",
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      }

      return {
        content: [
          { type: "text", text: 'Unknown action. Use: "status", "run", or "dry-run"' },
        ],
        isError: true,
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `Dreaming error: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }
  }

  if (name === "agent_config") {
    const action = String(params.action || "get");

    if (action === "get") {
      const current = loadConfig(WORKSPACE);
      return {
        content: [
          {
            type: "text",
            text: `## Current Configuration\n\n\`\`\`json\n${JSON.stringify(current, null, 2)}\n\`\`\`\n\nTo change: \`agent_config(action='set', key='memory.backend', value='qmd')\`\nAfter changes: \`/mcp reconnect clawcode\``,
          },
        ],
      };
    }

    if (action === "set") {
      const key = String(params.key || "");
      const value = String(params.value || "");

      if (!key) {
        return {
          content: [{ type: "text", text: "Error: 'key' is required. Example: agent_config(action='set', key='memory.backend', value='qmd')" }],
          isError: true,
        };
      }

      try {
        const current = loadConfig(WORKSPACE);

        // Navigate the nested config object by dot-separated key
        const parts = key.split(".");
        let target: any = current;
        for (let i = 0; i < parts.length - 1; i++) {
          if (target[parts[i]] === undefined) target[parts[i]] = {};
          target = target[parts[i]];
        }

        const lastKey = parts[parts.length - 1];

        // Parse value: try JSON first, then boolean, then number, then string
        let parsedValue: any = value;
        if (value === "true") parsedValue = true;
        else if (value === "false") parsedValue = false;
        else if (/^\d+(\.\d+)?$/.test(value)) parsedValue = Number(value);
        else {
          try { parsedValue = JSON.parse(value); } catch { /* keep as string */ }
        }

        target[lastKey] = parsedValue;
        saveConfig(WORKSPACE, current);

        return {
          content: [
            {
              type: "text",
              text: `Set \`${key}\` = \`${JSON.stringify(parsedValue)}\`\n\nRun \`/mcp reconnect clawcode\` to apply.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }

    return {
      content: [{ type: "text", text: "Unknown action. Use 'get' or 'set'." }],
      isError: true,
    };
  }

  if (name === "agent_status") {
    let identity = "(no IDENTITY.md)";
    try {
      identity = fs
        .readFileSync(path.join(WORKSPACE, "IDENTITY.md"), "utf-8")
        .trim();
    } catch {}

    const stats = memoryDB.stats();

    let recallCount = 0;
    try {
      const recall = JSON.parse(
        fs.readFileSync(
          path.join(DREAMS_DIR, "short-term-recall.json"),
          "utf-8"
        )
      );
      recallCount = Object.keys(recall.entries || {}).length;
    } catch {}

    return {
      content: [
        {
          type: "text",
          text: [
            `Workspace: ${WORKSPACE}`,
            "",
            identity,
            "",
            `Memory backend: ${qmdManager ? "QMD (" + (config.memory.qmd?.searchMode ?? "vsearch") + ")" : "builtin (SQLite + FTS5)"}`,
            `Memory index: ${stats.files} files, ${stats.chunks} chunks, ${(stats.totalSize / 1024).toFixed(1)} KB total`,
            `Dream tracking: ${recallCount} unique memories recalled`,
            `Features: FTS5 + BM25${config.memory.builtin?.temporalDecay !== false ? " + temporal decay" : ""}${config.memory.builtin?.mmr !== false ? " + MMR" : ""}${qmdManager ? " + QMD embeddings + reranking" : ""}`,
          ].join("\n"),
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
