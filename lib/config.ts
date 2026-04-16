/**
 * Agent configuration — persistent settings stored in agent-config.json
 * Mirrors OpenClaw's openclaw.json memory section.
 */

import fs from "fs";
import path from "path";

export interface AgentConfig {
  /** HTTP bridge — optional local HTTP server for webhooks, status, and API access */
  http?: {
    /** Enable the HTTP bridge (default: false) */
    enabled?: boolean;
    /** Port to listen on (default: 18790) */
    port?: number;
    /** Host to bind to (default: "127.0.0.1" — localhost only) */
    host?: string;
    /** Bearer token for authenticated endpoints. Empty = no auth required. */
    token?: string;
  };
  /** Voice (TTS + STT) configuration */
  voice?: {
    /** Master switch. Default: false (opt-in). */
    enabled?: boolean;
    /** TTS backend preference: "auto" (pick first available) or a specific backend. */
    defaultBackend?: "auto" | "sag" | "elevenlabs" | "openai-tts" | "say";
    /** STT backend preference. */
    defaultSttBackend?: "auto" | "whisper-cli" | "hf-whisper" | "openai-whisper";
    /** Shared STT tuning (applies to whisper-cli and hf-whisper). */
    stt?: {
      /** Model size for local backends. Smaller = faster, larger = more accurate. */
      model?: "tiny" | "base" | "small";
      /** Quality preset — maps to beam size + dtype depending on backend. */
      quality?: "fast" | "balanced" | "best";
    };
    /** Default voice name/id (e.g. "Clawd" for sag, "alloy" for OpenAI). */
    defaultVoice?: string;
    /** Where generated audio files go. Default: /tmp. */
    outputDir?: string;
    elevenlabs?: {
      model?: string;
      voiceId?: string;
    };
    openai?: {
      model?: string;
      voice?: string;
    };
  };
  /** Active-memory / memory_context tool configuration */
  memoryContext?: {
    /** Master switch. Default: true (opt-out). When false, the tool short-circuits with "disabled". */
    enabled?: boolean;
    /** Max chunks in the digest. Default: 4. */
    maxResults?: number;
    /** Apply recency boost to scores. Default: true. */
    includeRecency?: boolean;
    /** Half-life in days for recency boost. Default: 30. */
    halfLifeDays?: number;
  };
  /** Heartbeat configuration */
  heartbeat?: {
    /** Cron schedule (default: every 30 min) */
    schedule?: string;
    /** Active hours — heartbeat only fires within this window */
    activeHours?: {
      /** Start time in HH:MM 24h format (default: "08:00") */
      start?: string;
      /** End time in HH:MM 24h format (default: "23:00") */
      end?: string;
      /** IANA timezone (default: from USER.md or "UTC") */
      timezone?: string;
    };
  };
  /** Dreaming configuration */
  dreaming?: {
    /** Cron schedule (default: daily at 3 AM) */
    schedule?: string;
    /** Timezone for dreaming cron */
    timezone?: string;
    /** AutoResearch — active gap filling during REM phase (Karpathy-inspired) */
    autoresearch?: {
      /** Master switch. Default: false (opt-in). */
      enabled?: boolean;
      /** Max gaps to investigate per dream cycle. Default: 5. */
      maxGapsPerNight?: number;
      /** Minimum confidence to keep a research finding. Default: 0.7. */
      confidenceThreshold?: number;
      /** Sources to consult. Default: ["codebase", "memory"]. */
      sources?: Array<"codebase" | "memory" | "web">;
      /** Time budget per cycle in minutes. Default: 10. */
      maxResearchTimeMinutes?: number;
    };
  };
  memory: {
    /** "builtin" = SQLite+FTS5 (default), "qmd" = QMD external tool */
    backend: "builtin" | "qmd";
    /** Citation mode */
    citations: "auto" | "on" | "off";
    /**
     * Extra paths to index alongside the default memory/ directory.
     * Useful for indexing logs from messaging plugins, e.g.:
     *   ["~/.claude/channels/whatsapp/logs/conversations"]
     * Only *.md files are indexed. .jsonl, .json, binary files are skipped.
     * Paths starting with ~ are expanded to $HOME.
     */
    extraPaths?: string[];
    /** QMD-specific settings (only used when backend = "qmd") */
    qmd?: {
      /** Path to qmd binary (default: "qmd" — searches PATH) */
      command?: string;
      /** Search mode: "search" (fast), "vsearch" (reranked), "query" (slow, best) */
      searchMode?: "search" | "vsearch" | "query";
      /** Include default memory paths (MEMORY.md + memory/) */
      includeDefaultMemory?: boolean;
      /** Session transcript indexing */
      sessions?: {
        enabled?: boolean;
        retentionDays?: number;
      };
      /** Update intervals */
      update?: {
        /** Sync interval (e.g., "5m") */
        interval?: string;
        /** Debounce delay in ms */
        debounceMs?: number;
        /** Timeout for embedding operations in ms */
        embedTimeoutMs?: number;
      };
      /** Search limits */
      limits?: {
        maxResults?: number;
        timeoutMs?: number;
      };
    };
    /** Builtin-specific settings (only used when backend = "builtin") */
    builtin?: {
      /** Enable temporal decay for dated files */
      temporalDecay?: boolean;
      /** Half-life in days for temporal decay (default: 30) */
      halfLifeDays?: number;
      /** Enable MMR diversity re-ranking */
      mmr?: boolean;
      /** MMR lambda (0=diversity, 1=relevance, default: 0.7) */
      mmrLambda?: number;
    };
  };
}

const DEFAULT_CONFIG: AgentConfig = {
  memory: {
    backend: "builtin",
    citations: "auto",
    builtin: {
      temporalDecay: true,
      halfLifeDays: 30,
      mmr: true,
      mmrLambda: 0.7,
    },
  },
};

const CONFIG_FILENAME = "agent-config.json";

export function loadConfig(pluginRoot: string): AgentConfig {
  const configPath = path.join(pluginRoot, CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    // Deep merge with defaults
    return {
      http: parsed.http ? { ...parsed.http } : undefined,
      voice: parsed.voice ? { ...parsed.voice } : undefined,
      memoryContext: parsed.memoryContext ? { ...parsed.memoryContext } : undefined,
      heartbeat: parsed.heartbeat ? { ...parsed.heartbeat } : undefined,
      dreaming: parsed.dreaming ? { ...parsed.dreaming } : undefined,
      memory: {
        ...DEFAULT_CONFIG.memory,
        ...parsed.memory,
        qmd: parsed.memory?.qmd
          ? { ...parsed.memory.qmd }
          : undefined,
        builtin: {
          ...DEFAULT_CONFIG.memory.builtin,
          ...parsed.memory?.builtin,
        },
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(pluginRoot: string, config: AgentConfig): void {
  const configPath = path.join(pluginRoot, CONFIG_FILENAME);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function configExists(pluginRoot: string): boolean {
  return fs.existsSync(path.join(pluginRoot, CONFIG_FILENAME));
}
