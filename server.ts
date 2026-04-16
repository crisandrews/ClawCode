import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { loadConfig, saveConfig } from "./lib/config.ts";
import {
  getLiveConfig,
  initLiveConfig,
  startConfigWatcher,
  type CriticalChange,
} from "./lib/live-config.ts";
import {
  formatFixReport,
  formatReport,
  runDoctor,
  runDoctorFix,
} from "./lib/doctor.ts";
import { DreamEngine } from "./lib/dreaming.ts";
import { HttpBridge, HTTP_DEFAULTS } from "./lib/http-bridge.ts";
import { getMemoryContext } from "./lib/memory-context.ts";
import {
  buildLaunchCommand,
  detectChannels,
  formatStatusTable,
} from "./lib/channel-detector.ts";
import {
  formatInstallResult,
  formatList,
  install as skillInstall,
  list as skillList,
  remove as skillRemove,
} from "./lib/skill-manager.ts";
import { buildPlan as buildServicePlan } from "./lib/service-generator.ts";
import {
  discoverCommands,
  formatCommandsCompact,
  formatCommandsTable,
} from "./lib/command-discovery.ts";
import {
  formatVoiceStatus,
  getVoiceStatus,
  speak as voiceSpeak,
  transcribe as voiceTranscribe,
} from "./lib/voice.ts";
import { extractKeywords } from "./lib/keywords.ts";
import { MemoryDB } from "./lib/memory-db.ts";
import { QmdManager } from "./lib/qmd-manager.ts";
import { PaperclipClient, resolvePaperclipConfig } from "./lib/paperclip-bridge.ts";
import type { SearchResult } from "./lib/types.ts";

// ---------------------------------------------------------------------------
// Paths
// PLUGIN_ROOT = where the plugin code lives (templates, lib, etc.)
// WORKSPACE   = where the agent's personality files live (user's project dir)
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || process.cwd();
// WORKSPACE = user's project dir. MCP server inherits cwd from Claude Code.
// npm --prefix installs deps in PLUGIN_ROOT, but tsx runs with inherited cwd.
const WORKSPACE = process.cwd();
const MEMORY_DIR = path.join(WORKSPACE, "memory");
const DREAMS_DIR = path.join(MEMORY_DIR, ".dreams");

// ---------------------------------------------------------------------------
// Config + Memory backends
// ---------------------------------------------------------------------------

// Startup config — used to bootstrap long-lived state (DB, QMD, HTTP server).
// For values that should apply live, call getLiveConfig() inside tool handlers.
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig(WORKSPACE);
} catch {
  config = { memory: { backend: "builtin", citations: "auto", builtin: { temporalDecay: true, halfLifeDays: 30, mmr: true, mmrLambda: 0.7 } } };
}
// Seed the live-config cache with the same initial load.
initLiveConfig(WORKSPACE);

// Always initialize builtin DB (used as fallback even when QMD is primary)
const extraPaths = config.memory.extraPaths || [];
let memoryDB: MemoryDB;
try {
  memoryDB = new MemoryDB(WORKSPACE, extraPaths);
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

// Paperclip bridge (null if not configured — tools gracefully report this)
const paperclipConfig = resolvePaperclipConfig(WORKSPACE);
const paperclipClient = paperclipConfig ? new PaperclipClient(paperclipConfig) : null;

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

// ---------------------------------------------------------------------------
// HTTP Bridge (optional — off by default)
// ---------------------------------------------------------------------------

const httpConfig = {
  enabled: config.http?.enabled ?? HTTP_DEFAULTS.enabled,
  port: config.http?.port ?? HTTP_DEFAULTS.port,
  host: config.http?.host ?? HTTP_DEFAULTS.host,
  token: config.http?.token ?? HTTP_DEFAULTS.token,
};

let httpBridge: HttpBridge | null = null;
if (httpConfig.enabled) {
  httpBridge = new HttpBridge(httpConfig, WORKSPACE, {
    getIdentity: () => {
      try {
        return fs.readFileSync(path.join(WORKSPACE, "IDENTITY.md"), "utf-8").trim();
      } catch {
        return "(no IDENTITY.md)";
      }
    },
    getMemoryStats: () => memoryDB.stats(),
    getConfig: () => {
      try {
        return loadConfig(WORKSPACE);
      } catch {
        return {};
      }
    },
    getWatchdogInfo: () => buildWatchdogPing(),
  });
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

    // Builtin SQLite + FTS5 — tuning knobs are read LIVE so config edits
    // apply without /mcp.
    const live = getLiveConfig();
    return memoryDB.search(query, {
      maxResults,
      enableDecay: live.memory.builtin?.temporalDecay ?? true,
      halfLifeDays: live.memory.builtin?.halfLifeDays ?? 30,
      enableMMR: live.memory.builtin?.mmr ?? true,
      mmrLambda: live.memory.builtin?.mmrLambda ?? 0.7,
    });
  } catch {
    // Total search failure — return empty, never crash
    return [];
  }
}

// ---------------------------------------------------------------------------
// Bootstrap file loading
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
  sections.push("## Runtime\n");
  sections.push("You are running inside Claude Code.");
  sections.push(
    "Use Claude Code tools: Bash, Read, Write, Edit, Grep, Glob, Agent, WebSearch, WebFetch."
  );
  sections.push(
    "Some workspaces include skill files (e.g. SOUL.md, AGENTS.md) that reference tools from a different agent system — names like `message`, `sessions_spawn`, `browser tool`, `gateway`, `cron tool`, `nodes`, `canvas`. Those are NOT available here. If you encounter them in skill instructions, treat them as descriptive intent and substitute with the closest Claude Code equivalent (e.g. `Agent` for sub-agents, messaging plugin `reply` for `message`)."
  );
  sections.push(
    "Ignore tokens like HEARTBEAT_OK, NO_REPLY, ANNOUNCE_SKIP, SILENT_REPLY — they do not apply here."
  );
  sections.push(
    "For WhatsApp/messaging: use MCP tools from the whatsapp plugin if available (reply, react).\n"
  );

  // -- Memory instructions (MUST use MCP tools, not native Claude Code tools)
  sections.push("## Memory — CRITICAL RULES\n");
  sections.push("You have MCP memory tools. You MUST use them instead of Claude Code's native tools:");
  sections.push("- To SEARCH memory: use `memory_search` (MCP tool), NOT Read or Grep");
  sections.push("- To READ memory details: use `memory_get` (MCP tool), NOT Read");
  sections.push("- To RUN dreaming: use `dream` (MCP tool)");
  sections.push("- To CHECK status: use `agent_status` (MCP tool)");
  sections.push("- To CHANGE settings: use `agent_config` (MCP tool)");
  sections.push("");
  sections.push("Before answering about prior work, decisions, dates, people, preferences, or todos:");
  sections.push("1. Run memory_search with a relevant query");
  sections.push("2. Use memory_get to pull specific lines if needed");
  sections.push("3. If low confidence after search, say you checked.");
  sections.push("Citations: include Source: path#Lstart-Lend when it helps verify.");
  sections.push("");
  sections.push("To SAVE information to memory: write to memory/YYYY-MM-DD.md (today's date) using Write or Edit tool. APPEND only.");
  sections.push("Do NOT use Claude Code's auto-memory (~/.claude/projects/.../memory/). Use the memory/ directory in this workspace ONLY.");
  sections.push("For long-term curated memory, update memory/MEMORY.md.");
  sections.push("");

  // -- Session summary
  sections.push("## Session Summary\n");
  sections.push(
    "Before ending a long or significant conversation, write a brief session summary to memory/YYYY-MM-DD.md."
  );
  sections.push("Include: what was discussed, decisions made, tasks completed, and any open items.");
  sections.push("This is critical — without it, the next session has no context about what happened.");
  sections.push("Do this proactively when the conversation feels like it's wrapping up.");
  sections.push("");

  // -- WebChat (only when HTTP bridge is on)
  if (httpBridge) {
    sections.push("## WebChat — CRITICAL\n");
    sections.push(
      "The HTTP bridge is enabled and serves a browser chat at `http://127.0.0.1:" +
        httpConfig.port +
        "`. Messages from that chat arrive via the `webchat_incoming` MCP notification AND are queued for `chat_inbox_read`."
    );
    sections.push(
      "When you receive a user message from WebChat (role: user, source: webchat), respond using `webchat_reply` — this streams your reply to the open browser over SSE."
    );
    sections.push(
      "On every heartbeat and whenever the user interacts, call `chat_inbox_read` FIRST to surface any pending WebChat messages. Process them in order, replying with `webchat_reply` for each."
    );
    sections.push(
      "WebChat messages count as real user input — apply personality, use memory, and respect the same rules as messaging channels."
    );
    sections.push("");
  }

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

  // -- Scheduled tasks (registry-based persistence; see docs/crons.md)
  sections.push("## Scheduled Tasks\n");
  sections.push(
    "This workspace maintains a cron registry at `memory/crons.json` — the source of truth for every scheduled task the user wants alive across sessions."
  );
  sections.push(
    "On session start you may receive a reconcile envelope from `[clawcode]`. Follow it exactly: ToolSearch → CronList → CronCreate for missing entries → writeback.sh set-alive → adopt-unknown → print summary → remove the `memory/.reconciling` marker."
  );
  sections.push(
    "Do not create default crons on your own — the registry is the source of truth, and hooks keep it in sync. User-facing management: `/agent:crons list|add|delete|pause|reconcile` (alias `/agent:reminders`)."
  );
  sections.push("");

  // -- Heartbeat behavior
  sections.push("## Heartbeat\n");
  sections.push("When triggered for a heartbeat:");
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
// MCP tool directory — kept in sync with the tools list below. Used by
// list_commands so the agent can introspect what it has.
// ---------------------------------------------------------------------------

const MCP_TOOL_DIRECTORY: Array<{ name: string; description: string }> = [
  { name: "memory_search", description: "Search memory with BM25, temporal decay, MMR." },
  { name: "memory_get", description: "Read specific lines from a memory file." },
  { name: "dream", description: "Run memory consolidation (status / run / dry-run)." },
  { name: "agent_config", description: "View or update agent settings." },
  { name: "agent_status", description: "Show identity, memory stats, dreaming state." },
  { name: "memory_context", description: "Active-memory turn-start reflex — digest relevant context." },
  { name: "agent_doctor", description: "Run diagnostics and optional auto-fixes." },
  { name: "channels_detect", description: "Inspect messaging channel plugins and build the launch command." },
  { name: "service_plan", description: "Plan install/uninstall/status/logs for the always-on service." },
  { name: "list_commands", description: "Discover installed skills and MCP tools." },
  { name: "voice_speak", description: "Generate a voice audio file from text (TTS)." },
  { name: "voice_transcribe", description: "Transcribe an audio file to text (STT)." },
  { name: "voice_status", description: "Report voice backend availability and WhatsApp-plugin audio state." },
  { name: "skill_install", description: "Install a skill from GitHub or local path." },
  { name: "skill_list", description: "List installed skills across scopes." },
  { name: "skill_remove", description: "Remove an installed skill (requires confirm)." },
  { name: "chat_inbox_read", description: "Read pending WebChat messages." },
  { name: "webchat_reply", description: "Stream a reply to the open WebChat browser." },
  { name: "watchdog_ping", description: "Cheap liveness probe for external watchdogs — returns version + installed channel plugin names. No LLM, no side effects." },
  { name: "paperclip_inbox", description: "Get your Paperclip inbox — assigned issues and pending tasks." },
  { name: "paperclip_issue", description: "Get, create, or update a Paperclip issue." },
  { name: "paperclip_comment", description: "List or add comments on a Paperclip issue." },
  { name: "paperclip_agents", description: "List agents or wake up a specific agent in Paperclip." },
];

/**
 * Liveness probe response used by the `watchdog_ping` MCP tool and the
 * `/watchdog/mcp-ping` HTTP endpoint. Shape deliberately stable — external
 * watchers depend on it.
 */
export interface WatchdogPingResponse {
  ok: true;
  version: string;
  ts: number;
  plugins: string[];
}

let cachedPluginVersion: string | null = null;
function readPluginVersion(): string {
  if (cachedPluginVersion !== null) return cachedPluginVersion;
  try {
    const raw = fs.readFileSync(
      path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
      "utf-8"
    );
    cachedPluginVersion = String(JSON.parse(raw).version || "unknown");
  } catch {
    cachedPluginVersion = "unknown";
  }
  return cachedPluginVersion;
}

/**
 * Build the watchdog ping response. Called by both the MCP tool handler and
 * the HTTP bridge's `/watchdog/mcp-ping` route. Cheap — reads plugin.json
 * once (cached) and walks the channel plugin cache dir via detectChannels.
 */
function buildWatchdogPing(): WatchdogPingResponse {
  let plugins: string[] = [];
  try {
    plugins = detectChannels()
      .filter((c) => c.installed === true)
      .map((c) => c.name);
  } catch {
    // Never fail the probe because of a detection error
  }
  return {
    ok: true,
    version: readPluginVersion(),
    ts: Date.now(),
    plugins,
  };
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const instructions = loadBootstrapFiles();

const server = new Server(
  { name: "clawcode", version: "1.0.0" },
  {
    capabilities: { tools: {}, logging: {} },
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
    {
      name: "memory_context",
      description:
        "Active memory retrieval — call this at the START of each turn for substantive user messages. Given the user's message, this derives complementary queries, searches memory (respects memory.backend: QMD or builtin), dedupes across queries, applies a recency boost, and returns a pre-formatted markdown digest to inject as context. Skips trivial messages (greetings, slash commands). This is a THIN wrapper on top of memory_search — it doesn't replace it; it just decides when and how to call it automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The user's message or the topic to find context for",
          },
          format: {
            type: "string",
            enum: ["digest", "json"],
            description: "'digest' (default) returns a markdown block ready to drop into context. 'json' returns the structured result.",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "agent_doctor",
      description:
        "Run diagnostic checks on the agent workspace (config, identity, memory, SQLite, QMD, HTTP bridge, messaging, dreaming, bootstrap). With action='fix', applies safe auto-repairs (create memory dir, sync index, clean stale BOOTSTRAP) then re-runs checks. Use this when the user asks for a health check or when something feels off.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["check", "fix"],
            description: "'check' (default) runs diagnostics; 'fix' applies safe auto-repairs then re-checks",
          },
          format: {
            type: "string",
            enum: ["card", "json"],
            description: "'card' (default) returns a human-readable card; 'json' returns the structured report",
          },
        },
      },
    },
    {
      name: "channels_detect",
      description:
        "Inspect messaging channel plugins (WhatsApp, Telegram, Discord, iMessage, Slack, Fakechat) and return installed / authenticated / active state per channel, plus a ready-to-use launch command. Read-only and safe — does not install, authenticate, or restart Claude Code.",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: {
            type: "string",
            enum: ["table", "json", "launch"],
            description: "'table' (default) human-readable card; 'json' structured data; 'launch' only the claude launch command",
          },
          includeInstalledOnly: {
            type: "boolean",
            description: "When building the launch command, include channels that are installed even if not authenticated (default: false)",
          },
          skipPermissions: {
            type: "boolean",
            description: "Append --dangerously-skip-permissions to the launch command (default: false — user must opt in)",
          },
        },
      },
    },
    {
      name: "service_plan",
      description:
        "Plan an always-on service install/uninstall/status/logs for this agent. Returns file content (plist on macOS or systemd unit on Linux), file path, log path, and a list of shell commands to execute. The skill runs the commands after getting user confirmation. This tool does NOT touch the filesystem or invoke launchctl/systemctl — it only computes the plan.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["install", "status", "uninstall", "logs"],
            description: "What the plan is for",
          },
          claudeBin: {
            type: "string",
            description: "Absolute path to the `claude` binary (e.g. /usr/local/bin/claude). Default: 'claude' (uses PATH resolution at runtime)",
          },
          extraArgs: {
            type: "array",
            items: { type: "string" },
            description: "Extra arguments to append after --dangerously-skip-permissions (e.g. channel flags)",
          },
          logPath: {
            type: "string",
            description: "Override default log path (default: /tmp/clawcode-<slug>.log)",
          },
        },
        required: ["action"],
      },
    },
    {
      name: "voice_speak",
      description:
        "Generate a voice audio file from text. Picks the best available TTS backend (sag → elevenlabs → openai-tts → say on macOS) unless `backend` overrides. Returns the file path; the agent typically then hands the path to a messaging plugin to deliver as a voice note. Requires `voice.enabled: true` in config.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: { type: "string", description: "Text to speak" },
          voice: {
            type: "string",
            description: "Voice name/id (backend-specific). Overrides config.voice.defaultVoice.",
          },
          backend: {
            type: "string",
            enum: ["auto", "sag", "elevenlabs", "openai-tts", "say"],
            description: "Force a specific backend (default: auto)",
          },
          outputPath: {
            type: "string",
            description: "Override output file path",
          },
        },
        required: ["text"],
      },
    },
    {
      name: "voice_transcribe",
      description:
        "Transcribe an audio file to text. Picks the best available STT backend (whisper-cli → openai-whisper). PRECEDENCE: if the audio came through a channel plugin that already transcribes (e.g. WhatsApp with `audio on`), the agent receives transcribed text and should NOT call this tool for that audio. Use this only for audio from channels without built-in transcription (WebChat uploads, iMessage attachments, raw files).",
      inputSchema: {
        type: "object" as const,
        properties: {
          audioPath: { type: "string", description: "Absolute path to the audio file" },
          language: {
            type: "string",
            description: "Hint language code (e.g. 'es', 'en') for accuracy",
          },
          backend: {
            type: "string",
            enum: ["auto", "whisper-cli", "openai-whisper"],
            description: "Force a specific backend (default: auto)",
          },
        },
        required: ["audioPath"],
      },
    },
    {
      name: "voice_status",
      description:
        "Report which voice backends are available, which would be chosen, and whether the WhatsApp plugin is already handling audio locally (so the agent doesn't double-process).",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: {
            type: "string",
            enum: ["card", "json"],
            description: "'card' (default) or 'json'",
          },
        },
      },
    },
    {
      name: "list_commands",
      description:
        "Discover all user-invocable commands — skills in ./skills/, .claude/skills/, ~/.claude/skills/, and (by default) the agent's own MCP tools. Returns each command's name, description, triggers (parsed from the description), scope, and argument hint. Use this to answer \"what can I do?\" or to render a live /help. Preferred over hardcoded lists because it picks up skills installed after boot.",
      inputSchema: {
        type: "object" as const,
        properties: {
          scope: {
            type: "string",
            enum: ["plugin", "project", "user", "mcp", "all"],
            description: "Filter to one scope (default: all)",
          },
          includeInternal: {
            type: "boolean",
            description: "Include skills marked user-invocable: false (default: false)",
          },
          includeTools: {
            type: "boolean",
            description: "Include MCP tools as scope='mcp' entries (default: true)",
          },
          format: {
            type: "string",
            enum: ["table", "compact", "json"],
            description: "'table' grouped by scope (default), 'compact' one line each, 'json' structured",
          },
        },
      },
    },
    {
      name: "skill_install",
      description:
        "Install a skill from a source into the agent. Accepts GitHub shorthand (owner/repo), full URLs, optional branch via @ and subdir via #, or a local directory path. Detects OpenClaw-flavored skills and refuses them (pointing the user at /agent:import-skill). Rejects OS/node mismatches; warns on missing binaries or env vars. Scope: plugin (default, ./skills/), project (.claude/skills/), user (~/.claude/skills/).",
      inputSchema: {
        type: "object" as const,
        properties: {
          source: {
            type: "string",
            description: "owner/repo | owner/repo@branch#subdir | https URL | /local/path",
          },
          scope: {
            type: "string",
            enum: ["plugin", "project", "user"],
            description: "Install destination (default: plugin)",
          },
          force: {
            type: "boolean",
            description: "Overwrite an existing skill with the same name",
          },
          dryRun: {
            type: "boolean",
            description: "Report what would happen without writing",
          },
        },
        required: ["source"],
      },
    },
    {
      name: "skill_list",
      description:
        "List installed skills across scopes (plugin, project, user). Returns name, scope, description, user-invocable flag.",
      inputSchema: {
        type: "object" as const,
        properties: {
          format: {
            type: "string",
            enum: ["card", "json"],
            description: "'card' (default) human-readable list, 'json' structured array",
          },
        },
      },
    },
    {
      name: "skill_remove",
      description:
        "Remove an installed skill by name. Requires confirm=true to actually delete — otherwise returns a dry-run description of what would be removed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Skill name (the 'name' field from its SKILL.md frontmatter)",
          },
          scope: {
            type: "string",
            enum: ["plugin", "project", "user"],
            description: "Narrow to a specific scope (default: search all)",
          },
          confirm: {
            type: "boolean",
            description: "Must be true to actually delete",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "chat_inbox_read",
      description:
        "Read pending messages from the WebChat inbox. Use this to check for new browser-based chat messages. Returns messages in order. Messages are removed from the inbox once read.",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Max messages to read (default: 20)",
          },
        },
      },
    },
    {
      name: "webchat_reply",
      description:
        "Send a reply to the open WebChat browser over SSE. Use this to respond to WebChat messages. The message is delivered in real time and persisted in chat history.",
      inputSchema: {
        type: "object" as const,
        properties: {
          message: {
            type: "string",
            description: "The reply content (plain text or markdown)",
          },
        },
        required: ["message"],
      },
    },
    {
      name: "watchdog_ping",
      description:
        "Cheap liveness probe for external watchdogs. Returns {ok, version, ts, plugins} where plugins is the list of installed channel plugin names (telegram, whatsapp, etc.). No LLM, no side effects, no network I/O. Used by the /watchdog/mcp-ping HTTP endpoint and available directly here for diagnostics.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "paperclip_inbox",
      description:
        "Get your Paperclip inbox — assigned issues and pending work. Requires Paperclip credentials in env vars or agent-config.json.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "paperclip_issue",
      description:
        "Interact with Paperclip issues. Actions: 'get' (by id/identifier), 'create' (new issue), 'update' (change status/title), 'list' (search), 'checkout' (assign to agent).",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            enum: ["get", "create", "update", "list", "checkout"],
            description: "Action to perform on the issue",
          },
          id: { type: "string", description: "Issue ID or identifier (for get/update/checkout)" },
          title: { type: "string", description: "Issue title (for create)" },
          description: { type: "string", description: "Issue description (for create/update)" },
          status: { type: "string", description: "Issue status (for update/list filter)" },
          agentId: { type: "string", description: "Agent ID (for checkout — defaults to self)" },
          limit: { type: "number", description: "Max results (for list, default 10)" },
        },
        required: ["action"],
      },
    },
    {
      name: "paperclip_comment",
      description:
        "List or add comments on a Paperclip issue. Actions: 'list' (get comments), 'add' (post a comment).",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["list", "add"], description: "Action" },
          issueId: { type: "string", description: "Issue ID" },
          body: { type: "string", description: "Comment body (for add)" },
          limit: { type: "number", description: "Max comments (for list, default 20)" },
        },
        required: ["action", "issueId"],
      },
    },
    {
      name: "paperclip_agents",
      description:
        "List agents in your Paperclip company or wake up (invoke heartbeat on) a specific agent. Actions: 'list', 'wakeup'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          action: { type: "string", enum: ["list", "wakeup"], description: "Action" },
          agentId: { type: "string", description: "Agent ID (for wakeup)" },
          reason: { type: "string", description: "Wakeup reason (for wakeup)" },
        },
        required: ["action"],
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
            `Memory backend: ${qmdManager ? "QMD (" + (getLiveConfig().memory.qmd?.searchMode ?? "vsearch") + ")" : "builtin (SQLite + FTS5)"}`,
            `Memory index: ${stats.files} files, ${stats.chunks} chunks, ${(stats.totalSize / 1024).toFixed(1)} KB total`,
            `Dream tracking: ${recallCount} unique memories recalled`,
            `Features: FTS5 + BM25${getLiveConfig().memory.builtin?.temporalDecay !== false ? " + temporal decay" : ""}${getLiveConfig().memory.builtin?.mmr !== false ? " + MMR" : ""}${qmdManager ? " + QMD embeddings + reranking" : ""}`,
          ].join("\n"),
        },
      ],
    };
  }

  if (name === "memory_context") {
    const message = String(params.message || "");
    const format = String(params.format || "digest");

    const live = getLiveConfig();
    const mcCfg = live.memoryContext ?? {};
    if (mcCfg.enabled === false) {
      return {
        content: [
          {
            type: "text",
            text: "(memory_context disabled via config — memoryContext.enabled=false)",
          },
        ],
      };
    }

    const result = getMemoryContext(message, (q, n) => searchMemory(q, n), {
      maxResults: mcCfg.maxResults,
      includeRecency: mcCfg.includeRecency,
      halfLifeDays: mcCfg.halfLifeDays ?? live.memory.builtin?.halfLifeDays,
    });

    if (format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    return { content: [{ type: "text", text: result.digest }] };
  }

  if (name === "agent_doctor") {
    const action = String(params.action || "check");
    const format = String(params.format || "card");

    try {
      if (action === "fix") {
        const report = await runDoctorFix(WORKSPACE);
        if (format === "json") {
          return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          };
        }
        return { content: [{ type: "text", text: formatFixReport(report) }] };
      }

      // default: check
      const report = await runDoctor(WORKSPACE);
      if (format === "json") {
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
        };
      }
      return { content: [{ type: "text", text: formatReport(report) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Doctor error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "watchdog_ping") {
    const payload = buildWatchdogPing();
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  }

  if (name === "channels_detect") {
    const format = String(params.format || "table");
    const channels = detectChannels();

    if (format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(channels, null, 2) }],
      };
    }

    if (format === "launch") {
      const cmd = buildLaunchCommand(channels, {
        includeInstalledOnly: Boolean(params.includeInstalledOnly),
        skipPermissions: Boolean(params.skipPermissions),
      });
      return { content: [{ type: "text", text: cmd }] };
    }

    const table = formatStatusTable(channels);
    const cmd = buildLaunchCommand(channels, {
      includeInstalledOnly: Boolean(params.includeInstalledOnly),
      skipPermissions: Boolean(params.skipPermissions),
    });
    return {
      content: [
        {
          type: "text",
          text: `📡 Messaging channels\n\n${table}\n\n--- Launch command ---\n\n${cmd}`,
        },
      ],
    };
  }

  if (name === "service_plan") {
    const action = String(params.action || "") as
      | "install"
      | "status"
      | "uninstall"
      | "logs";
    if (!["install", "status", "uninstall", "logs"].includes(action)) {
      return {
        content: [
          { type: "text", text: "Error: action must be install|status|uninstall|logs" },
        ],
        isError: true,
      };
    }
    const claudeBin = String(params.claudeBin || "claude");
    const extraArgs = Array.isArray(params.extraArgs)
      ? params.extraArgs.map(String)
      : undefined;
    const logPath = params.logPath ? String(params.logPath) : undefined;

    const plan = buildServicePlan(action, {
      workspace: WORKSPACE,
      claudeBin,
      extraArgs,
      logPath,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(plan, null, 2) }],
      isError: !!plan.error,
    };
  }

  if (name === "voice_speak") {
    const text = String(params.text || "").trim();
    if (!text) {
      return {
        content: [{ type: "text", text: "Error: text is required" }],
        isError: true,
      };
    }
    const voiceCfg = getLiveConfig().voice;
    if (voiceCfg?.enabled !== true) {
      return {
        content: [
          {
            type: "text",
            text: "Voice is disabled. Enable via /agent:settings → set voice.enabled=true (and set up a backend via /agent:voice setup).",
          },
        ],
        isError: true,
      };
    }
    const result = await voiceSpeak(text, {
      config: voiceCfg,
      preferred: (params.backend as any) || undefined,
      voice: params.voice ? String(params.voice) : undefined,
      outputPath: params.outputPath ? String(params.outputPath) : undefined,
    });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `❌ voice_speak failed: ${result.error}${result.triedBackends ? ` (tried: ${result.triedBackends.join(", ")})` : ""}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `✅ ${result.backend} → ${result.path} (${result.bytes} bytes)\n\nUse MEDIA:${result.path} to send over a messaging channel that supports voice notes.`,
        },
      ],
    };
  }

  if (name === "voice_transcribe") {
    const audioPath = String(params.audioPath || "").trim();
    if (!audioPath) {
      return {
        content: [{ type: "text", text: "Error: audioPath is required" }],
        isError: true,
      };
    }
    const voiceCfg = getLiveConfig().voice;
    if (voiceCfg?.enabled !== true) {
      return {
        content: [
          {
            type: "text",
            text: "Voice is disabled. Enable via /agent:settings → voice.enabled=true.",
          },
        ],
        isError: true,
      };
    }
    const result = await voiceTranscribe(audioPath, {
      config: voiceCfg,
      preferred: (params.backend as any) || undefined,
      language: params.language ? String(params.language) : undefined,
    });
    if (!result.ok) {
      return {
        content: [
          {
            type: "text",
            text: `❌ voice_transcribe failed: ${result.error}${result.triedBackends ? ` (tried: ${result.triedBackends.join(", ")})` : ""}`,
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `✅ ${result.backend}\n\n${result.text}`,
        },
      ],
    };
  }

  if (name === "voice_status") {
    const format = String(params.format || "card");
    const status = getVoiceStatus(getLiveConfig().voice);
    if (format === "json") {
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    }
    return { content: [{ type: "text", text: formatVoiceStatus(status) }] };
  }

  if (name === "list_commands") {
    const scope = (params.scope as any) || "all";
    const includeInternal = Boolean(params.includeInternal);
    const includeTools = params.includeTools !== false;
    const format = String(params.format || "table");

    const commands = discoverCommands({
      workspace: WORKSPACE,
      mcpTools: MCP_TOOL_DIRECTORY,
      scope,
      includeInternal,
      includeTools,
    });

    if (format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(commands, null, 2) }],
      };
    }
    if (format === "compact") {
      return {
        content: [{ type: "text", text: formatCommandsCompact(commands) }],
      };
    }
    return {
      content: [{ type: "text", text: formatCommandsTable(commands) }],
    };
  }

  if (name === "skill_install") {
    const source = String(params.source || "").trim();
    if (!source) {
      return {
        content: [{ type: "text", text: "Error: 'source' is required" }],
        isError: true,
      };
    }
    const scope = (params.scope as "plugin" | "project" | "user") || "plugin";
    const force = Boolean(params.force);
    const dryRun = Boolean(params.dryRun);

    const result = skillInstall(WORKSPACE, source, { scope, force, dryRun });
    return {
      content: [{ type: "text", text: formatInstallResult(result) }],
      isError: !result.ok,
    };
  }

  if (name === "skill_list") {
    const format = String(params.format || "card");
    const skills = skillList(WORKSPACE);
    if (format === "json") {
      return {
        content: [{ type: "text", text: JSON.stringify(skills, null, 2) }],
      };
    }
    return { content: [{ type: "text", text: formatList(skills) }] };
  }

  if (name === "skill_remove") {
    const skillName = String(params.name || "").trim();
    if (!skillName) {
      return {
        content: [{ type: "text", text: "Error: 'name' is required" }],
        isError: true,
      };
    }
    const scope = params.scope as "plugin" | "project" | "user" | undefined;
    const confirm = Boolean(params.confirm);

    const result = skillRemove(WORKSPACE, skillName, { scope, confirm });
    if (!result.ok && !confirm && result.removed) {
      // Dry-run path: explain what would be removed
      return {
        content: [
          {
            type: "text",
            text: `Would remove "${result.removed.name}" from ${result.removed.dir} (scope: ${result.removed.scope}).\n\nPass confirm=true to actually delete.`,
          },
        ],
      };
    }
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `❌ ${result.reason}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `✅ Removed "${result.removed!.name}" from ${result.removed!.dir}`,
        },
      ],
    };
  }

  if (name === "chat_inbox_read") {
    if (!httpBridge) {
      return {
        content: [
          {
            type: "text",
            text: "WebChat is not enabled. Enable via /agent:settings → set http.enabled and http.webchat.enabled.",
          },
        ],
      };
    }
    const limit = Number(params.limit) || 20;
    const messages = httpBridge.drainChatInbox(limit);

    if (messages.length === 0) {
      return { content: [{ type: "text", text: "(webchat inbox empty)" }] };
    }

    const formatted = messages
      .map((m, i) => `[${i + 1}] ${m.ts} — ${m.content}`)
      .join("\n");

    return {
      content: [
        {
          type: "text",
          text: `${messages.length} pending WebChat message(s):\n\n${formatted}\n\nReply to each using webchat_reply.`,
        },
      ],
    };
  }

  if (name === "webchat_reply") {
    if (!httpBridge) {
      return {
        content: [
          {
            type: "text",
            text: "WebChat is not enabled. Enable via /agent:settings.",
          },
        ],
        isError: true,
      };
    }
    const message = String(params.message || "").trim();
    if (!message) {
      return {
        content: [{ type: "text", text: "Error: message is required" }],
        isError: true,
      };
    }
    const msg = httpBridge.sendChatReply(message);
    return {
      content: [
        {
          type: "text",
          text: `Reply sent to WebChat (id: ${msg.id}, ${httpBridge.sseClientCount()} connected client(s)).`,
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Paperclip tools
  // ---------------------------------------------------------------------------

  const PAPERCLIP_NOT_CONFIGURED =
    "Paperclip not configured. Set PAPERCLIP_API_URL, PAPERCLIP_API_KEY, and PAPERCLIP_COMPANY_ID as env vars, or add a 'paperclip' block to agent-config.json.";

  if (name === "paperclip_inbox") {
    if (!paperclipClient) {
      return { content: [{ type: "text", text: PAPERCLIP_NOT_CONFIGURED }], isError: true };
    }
    try {
      const inbox = await paperclipClient.inbox();
      return { content: [{ type: "text", text: JSON.stringify(inbox, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === "paperclip_issue") {
    if (!paperclipClient) {
      return { content: [{ type: "text", text: PAPERCLIP_NOT_CONFIGURED }], isError: true };
    }
    const action = String(params.action || "");
    try {
      if (action === "get") {
        const id = String(params.id || "");
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const issue = await paperclipClient.getIssue(id);
        return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }] };
      }
      if (action === "list") {
        const issues = await paperclipClient.listIssues({
          status: params.status ? String(params.status) : undefined,
          limit: Number(params.limit) || 10,
        });
        return { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }] };
      }
      if (action === "create") {
        const title = String(params.title || "").trim();
        if (!title) return { content: [{ type: "text", text: "Error: title is required" }], isError: true };
        const issue = await paperclipClient.createIssue({
          title,
          description: params.description ? String(params.description) : undefined,
        });
        return { content: [{ type: "text", text: `Issue created: ${JSON.stringify(issue, null, 2)}` }] };
      }
      if (action === "update") {
        const id = String(params.id || "");
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const update: any = {};
        if (params.title) update.title = String(params.title);
        if (params.status) update.status = String(params.status);
        if (params.description) update.description = String(params.description);
        const issue = await paperclipClient.updateIssue(id, update);
        return { content: [{ type: "text", text: `Issue updated: ${JSON.stringify(issue, null, 2)}` }] };
      }
      if (action === "checkout") {
        const id = String(params.id || "");
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const result = await paperclipClient.checkoutIssue(id, params.agentId ? String(params.agentId) : undefined);
        return { content: [{ type: "text", text: `Issue checked out: ${JSON.stringify(result, null, 2)}` }] };
      }
      return { content: [{ type: "text", text: 'Unknown action. Use: "get", "create", "update", "list", "checkout"' }], isError: true };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === "paperclip_comment") {
    if (!paperclipClient) {
      return { content: [{ type: "text", text: PAPERCLIP_NOT_CONFIGURED }], isError: true };
    }
    const action = String(params.action || "");
    const issueId = String(params.issueId || "");
    if (!issueId) return { content: [{ type: "text", text: "Error: issueId is required" }], isError: true };
    try {
      if (action === "list") {
        const comments = await paperclipClient.listComments(issueId, Number(params.limit) || 20);
        return { content: [{ type: "text", text: JSON.stringify(comments, null, 2) }] };
      }
      if (action === "add") {
        const body = String(params.body || "").trim();
        if (!body) return { content: [{ type: "text", text: "Error: body is required" }], isError: true };
        const comment = await paperclipClient.addComment(issueId, body);
        return { content: [{ type: "text", text: `Comment added: ${JSON.stringify(comment, null, 2)}` }] };
      }
      return { content: [{ type: "text", text: 'Unknown action. Use: "list" or "add"' }], isError: true };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  }

  if (name === "paperclip_agents") {
    if (!paperclipClient) {
      return { content: [{ type: "text", text: PAPERCLIP_NOT_CONFIGURED }], isError: true };
    }
    const action = String(params.action || "");
    try {
      if (action === "list") {
        const agents = await paperclipClient.listAgents();
        return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }] };
      }
      if (action === "wakeup") {
        const agentId = String(params.agentId || "");
        if (!agentId) return { content: [{ type: "text", text: "Error: agentId is required" }], isError: true };
        const result = await paperclipClient.wakeupAgent(agentId, params.reason ? String(params.reason) : undefined);
        return { content: [{ type: "text", text: `Agent wakeup requested: ${JSON.stringify(result, null, 2)}` }] };
      }
      return { content: [{ type: "text", text: 'Unknown action. Use: "list" or "wakeup"' }], isError: true };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
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

// Watch agent-config.json — non-critical changes apply live; critical changes
// surface via a logging notification telling the user to run /mcp.
startConfigWatcher(WORKSPACE, async (changes: CriticalChange[]) => {
  const keys = changes.map((c) => c.key).join(", ");
  try {
    await server.notification({
      method: "notifications/message",
      params: {
        level: "warning",
        logger: "clawcode.config",
        data: {
          source: "live-config",
          message: `Config change to ${keys} requires /mcp to apply. Other changes (if any) applied live.`,
          changes,
        },
      },
    });
  } catch {}
});

// Start HTTP bridge if enabled (non-blocking — failure doesn't crash the MCP server)
if (httpBridge) {
  // Wire WebChat messages into MCP notifications (channel-style delivery)
  httpBridge.setChatMessageHandler(async (msg) => {
    // Best-effort notification — if the client doesn't support it, this is silent.
    // The message is also queued in chatInbox for the chat_inbox_read tool fallback.
    try {
      await server.notification({
        method: "notifications/message",
        params: {
          level: "info",
          logger: "webchat",
          data: {
            source: "webchat",
            role: msg.role,
            id: msg.id,
            ts: msg.ts,
            content: msg.content,
          },
        },
      });
    } catch {}
  });

  httpBridge.start().catch(() => {
    // Logged inside HttpBridge — nothing else to do
  });
}
