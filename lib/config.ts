/**
 * Agent configuration — persistent settings stored in agent-config.json
 * Mirrors OpenClaw's openclaw.json memory section.
 */

import fs from "fs";
import path from "path";

/**
 * Channel-scope per-channel knob. ABSENCE means `mode: "off"` —
 * users without this block in `agent-config.json` see zero behavior
 * change. Per the per-canal opt-in design (Phase 3+).
 */
export interface ChannelScopeConfig {
  /** Default `"off"`. `"shadow"` collects stats without filtering;
   *  `"enforce"` filters. */
  mode?: "off" | "shadow" | "enforce";
  /** Foreground identity preference. Default `"auto"`. */
  identity?: "auto" | "owner" | "guest";
  /** Background lane (dreams + indexer) identity per channel. */
  background?: { identity?: "deny" | "system-owner" };
  /**
   * Execution gate — restricts which tools the agent can invoke when
   * the current turn was triggered by a non-owner inbound from this
   * channel. Independent of the read-scope `mode` above. Default
   * `mode: "off"` (no execution restrictions). See
   * `lib/scope/exec-gate.ts` for the resolver and policy semantics.
   */
  execGate?: {
    mode?: "off" | "shadow" | "enforce";
    policy?: "denylist" | "allowlist";
    tools?: string[];
    lookbackMs?: number;
  };
}

export interface WhatsappScopeConfig extends ChannelScopeConfig {
  /** Override path to `access.json`. Default `"auto"` (resolve via
   *  channel-detector). */
  accessJsonPath?: "auto" | string;
  /** When true, only honor a paired install whose projectPath
   *  exactly matches the launch cwd (no first-local fallback). */
  cwdExactMatchOnly?: boolean;
}

export interface ScopeConfigTree {
  whatsapp?: WhatsappScopeConfig;
  telegram?: ChannelScopeConfig;
  discord?: ChannelScopeConfig;
  imessage?: ChannelScopeConfig;
  webchat?: ChannelScopeConfig;
}

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
  /**
   * Channel-scope per-channel opt-in. ABSENT block = all channels
   * `mode: "off"` = zero behavior change for users who haven't run
   * `/agent:scope wizard`. See `docs/channel-scope-compat.md`.
   */
  scope?: ScopeConfigTree;
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
      // Phase 3 — scope.* deep-merge. Absent block stays undefined
      // so detectScopeRuntime() short-circuits to anyArmed=false.
      scope: parsed.scope ? mergeScopeConfig(parsed.scope) : undefined,
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

/**
 * Phase 3 — channel-scope deep-merge. Each channel keeps the user's
 * settings; missing fields default per-channel:
 *   - `mode = "off"` (no opt-in)
 *   - `identity = "auto"`
 *   - `background.identity = "deny"` (no scoped dream/index work)
 *
 * Returns undefined when the input is missing/empty so callers can
 * short-circuit on `if (!config.scope) return ...`.
 */
// Codex Phase 5 round-2 MEDIUM: invalid `mode` strings (e.g. typo
// `"enfroce"`) used to fall through unvalidated. WhatsApp would arm
// on any non-"off" value but the filter only enforces on exact
// "enforce" → silent enforcement bypass on typo. v3 validates each
// scope-config string against its allowed set and fail-closes to
// the safest default. The user gets accurate doctor warnings via the
// existing scope-status row, so they can spot a typo without silent
// drift.
const VALID_MODES = new Set<ChannelScopeConfig["mode"]>(["off", "shadow", "enforce"]);
const VALID_IDENTITIES = new Set<ChannelScopeConfig["identity"]>([
  "auto",
  "owner",
  "guest",
]);
const VALID_BG_IDENTITIES = new Set(["deny", "system-owner"]);

function coerceMode(v: unknown): ChannelScopeConfig["mode"] {
  return typeof v === "string" && VALID_MODES.has(v as ChannelScopeConfig["mode"])
    ? (v as ChannelScopeConfig["mode"])
    : "off";
}
function coerceIdentity(v: unknown): ChannelScopeConfig["identity"] {
  return typeof v === "string" &&
    VALID_IDENTITIES.has(v as ChannelScopeConfig["identity"])
    ? (v as ChannelScopeConfig["identity"])
    : "auto";
}
function coerceBgIdentity(v: unknown): "deny" | "system-owner" {
  return typeof v === "string" && VALID_BG_IDENTITIES.has(v)
    ? (v as "deny" | "system-owner")
    : "deny";
}

/**
 * Codex Phase 5 round-3 LOW: `coerceMode` / `coerceIdentity` /
 * `coerceBgIdentity` silently swallow typos. Without a separate path
 * the user's `"enfroce"` becomes `"off"` and the doctor scope-status
 * row just reports `mode: off` — losing the diagnostic that something
 * is wrong. This helper walks the raw scope tree (post-JSON-parse,
 * pre-merge) and returns a list of invalid-string warnings keyed by
 * channel + field. The doctor pulls these into scope-status so the
 * user sees `whatsapp: invalid mode "enfroce" — fail-closed to off`
 * instead of the scrubbed value.
 */
export interface ScopeConfigWarning {
  channel: string;
  field: string;
  raw: string;
}

export function collectScopeConfigWarnings(
  pluginRoot: string
): ScopeConfigWarning[] {
  const configPath = path.join(pluginRoot, CONFIG_FILENAME);
  let parsed: { scope?: unknown };
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: ScopeConfigWarning[] = [];
  const scope = parsed?.scope;
  if (!scope || typeof scope !== "object") return out;
  for (const [channel, v] of Object.entries(scope as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const cv = v as Record<string, unknown>;
    if (
      typeof cv.mode === "string" &&
      !VALID_MODES.has(cv.mode as ChannelScopeConfig["mode"])
    ) {
      out.push({ channel, field: "mode", raw: cv.mode });
    }
    if (
      typeof cv.identity === "string" &&
      !VALID_IDENTITIES.has(cv.identity as ChannelScopeConfig["identity"])
    ) {
      out.push({ channel, field: "identity", raw: cv.identity });
    }
    const bg = (cv.background as { identity?: unknown } | undefined)?.identity;
    if (typeof bg === "string" && !VALID_BG_IDENTITIES.has(bg)) {
      out.push({ channel, field: "background.identity", raw: bg });
    }
  }
  return out;
}

function mergeScopeConfig(raw: unknown): ScopeConfigTree | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: ScopeConfigTree = {};
  for (const channel of [
    "whatsapp",
    "telegram",
    "discord",
    "imessage",
    "webchat",
  ] as const) {
    const v = r[channel];
    if (!v || typeof v !== "object") continue;
    const cv = v as Record<string, unknown>;
    const merged: ChannelScopeConfig = {
      mode: coerceMode(cv.mode),
      identity: coerceIdentity(cv.identity),
      background: {
        identity: coerceBgIdentity(
          (cv.background as { identity?: unknown })?.identity
        ),
      },
      // execGate is stored as the raw block (not coerced here) and
      // resolved at read time via `execGateConfigForChannel`. This
      // mirrors the read-scope mode handling: the merge layer keeps
      // user intent, and the resolver coerces fail-closed.
      ...(cv.execGate !== undefined ? { execGate: cv.execGate as ChannelScopeConfig["execGate"] } : {}),
    };
    if (channel === "whatsapp") {
      const w = v as Record<string, unknown>;
      // Codex round-1 MEDIUM 1: coerce non-string accessJsonPath to "auto"
      // so a misconfigured object/null/array doesn't bubble through to
      // resolveAccessPath → path.dirname(non-string) → throw on the
      // search hot path.
      const rawAccess = w.accessJsonPath;
      const accessJsonPath: WhatsappScopeConfig["accessJsonPath"] =
        typeof rawAccess === "string" ? rawAccess : "auto";
      const wa: WhatsappScopeConfig = {
        ...merged,
        accessJsonPath,
        cwdExactMatchOnly:
          typeof w.cwdExactMatchOnly === "boolean" ? w.cwdExactMatchOnly : false,
      };
      out.whatsapp = wa;
    } else {
      out[channel] = merged;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
