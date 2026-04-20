/**
 * Voice — text-to-speech (TTS) and speech-to-text (STT) backends.
 *
 * This module is a thin routing layer. It detects which backends are
 * available (binaries on PATH, API keys in env), picks one according to
 * preferred-then-fallback chain, and executes. Side-effects (spawning
 * processes, HTTP calls) are isolated behind injected functions so the
 * routing logic can be unit-tested without actually generating audio.
 *
 * Channel plugins own their own audio path — e.g. the WhatsApp plugin has a
 * local-Whisper transcriber for inbound voice notes. We expose WhatsApp's
 * audio-config state via `detectWhatsappAudio` so the agent and the /agent:voice
 * skill can honour that precedence and not double-process.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { detectWhatsappProjectDir } from "./channel-detector.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TtsBackendName = "sag" | "elevenlabs" | "openai-tts" | "say";
export type SttBackendName = "whisper-cli" | "hf-whisper" | "openai-whisper";

export type WhisperModelSize = "tiny" | "base" | "small";
export type WhisperQuality = "fast" | "balanced" | "best";

export interface BackendStatus {
  name: TtsBackendName | SttBackendName;
  kind: "tts" | "stt";
  available: boolean;
  /** Why unavailable (when !available). */
  reason?: string;
  /** Extra info, e.g. detected binary path or model. */
  detail?: string;
}

export interface DetectOpts {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Hook that decides if a binary exists — default uses `which`. */
  hasBinary?: (bin: string) => boolean;
  /** Hook that decides if an npm module is installed — default uses createRequire. */
  hasModule?: (name: string) => boolean;
}

export interface VoiceConfig {
  enabled?: boolean;
  defaultBackend?: "auto" | TtsBackendName;
  defaultSttBackend?: "auto" | SttBackendName;
  defaultVoice?: string;
  outputDir?: string;
  elevenlabs?: {
    model?: string;
    voiceId?: string;
  };
  openai?: {
    model?: string;
    voice?: string;
  };
  stt?: {
    /** Model size for local STT backends (whisper-cli, hf-whisper). */
    model?: WhisperModelSize;
    /** Quality preset. fast = quantized no-beam; balanced = quantized single-beam; best = fp32 5-beam. */
    quality?: WhisperQuality;
  };
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

function defaultHasBinary(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an npm module can be resolved without actually importing it.
 * Used to detect optional peer deps like @huggingface/transformers without
 * loading the heavy module at startup.
 *
 * Pass a custom resolver in tests to avoid touching the real module graph.
 */
export function canResolveModule(
  name: string,
  resolver?: (specifier: string) => string
): boolean {
  try {
    if (resolver) {
      resolver(name);
      return true;
    }
    const req = createRequire(import.meta.url);
    req.resolve(name);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public detection API
// ---------------------------------------------------------------------------

/** Detect all TTS backends and their availability. */
export function detectTtsBackends(opts: DetectOpts = {}): BackendStatus[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const has = opts.hasBinary ?? defaultHasBinary;

  const out: BackendStatus[] = [];

  // sag — brew package that wraps ElevenLabs with nice prompt conventions
  const sagInstalled = has("sag");
  const elKey = env.ELEVENLABS_API_KEY || env.SAG_API_KEY;
  out.push({
    name: "sag",
    kind: "tts",
    available: !!(sagInstalled && elKey),
    reason: !sagInstalled
      ? "sag not in PATH — `brew install steipete/tap/sag`"
      : !elKey
      ? "ELEVENLABS_API_KEY not set"
      : undefined,
    detail: sagInstalled ? "sag binary found" : undefined,
  });

  // elevenlabs direct API (no sag required)
  out.push({
    name: "elevenlabs",
    kind: "tts",
    available: !!elKey,
    reason: elKey ? undefined : "ELEVENLABS_API_KEY not set",
  });

  // OpenAI TTS
  const openaiKey = env.OPENAI_API_KEY;
  out.push({
    name: "openai-tts",
    kind: "tts",
    available: !!openaiKey,
    reason: openaiKey ? undefined : "OPENAI_API_KEY not set",
  });

  // macOS `say` — always on darwin, never elsewhere
  out.push({
    name: "say",
    kind: "tts",
    available: platform === "darwin",
    reason:
      platform === "darwin"
        ? undefined
        : `macOS only (current platform: ${platform})`,
    detail:
      platform === "darwin" ? "built-in (outputs AIFF unless piped)" : undefined,
  });

  return out;
}

/** Detect all STT backends and their availability. */
export function detectSttBackends(opts: DetectOpts = {}): BackendStatus[] {
  const env = opts.env ?? process.env;
  const has = opts.hasBinary ?? defaultHasBinary;
  const hasMod = opts.hasModule ?? ((name: string) => canResolveModule(name));

  const out: BackendStatus[] = [];

  // whisper.cpp CLI (whisper-cli or main binary)
  const whisperCli = has("whisper-cli") || has("whisper");
  out.push({
    name: "whisper-cli",
    kind: "stt",
    available: whisperCli,
    reason: whisperCli ? undefined : "whisper-cli not in PATH",
  });

  // @huggingface/transformers — runs Whisper models in pure Node, no binary.
  // Optional dep — installed only if the user adds it to package.json (or we do).
  const hfInstalled = hasMod("@huggingface/transformers");
  out.push({
    name: "hf-whisper",
    kind: "stt",
    available: hfInstalled,
    reason: hfInstalled
      ? undefined
      : "@huggingface/transformers not installed (optional dep)",
    detail: hfInstalled ? "runs locally via ONNX, no binary needed" : undefined,
  });

  // OpenAI Whisper API
  const openaiKey = env.OPENAI_API_KEY;
  out.push({
    name: "openai-whisper",
    kind: "stt",
    available: !!openaiKey,
    reason: openaiKey ? undefined : "OPENAI_API_KEY not set",
  });

  return out;
}

// ---------------------------------------------------------------------------
// Chain selection (pure, testable)
// ---------------------------------------------------------------------------

export const TTS_CHAIN_ORDER: TtsBackendName[] = [
  "sag",
  "elevenlabs",
  "openai-tts",
  "say",
];

export const STT_CHAIN_ORDER: SttBackendName[] = [
  "whisper-cli",   // fastest if installed (native whisper.cpp)
  "hf-whisper",    // no binary needed, pure Node
  "openai-whisper", // cloud fallback
];

/**
 * Pick a TTS backend from the available ones.
 * - If `preferred` is set and available → use it.
 * - If `preferred` is set but not available → error (explicit user choice, don't silently fall back).
 * - Otherwise → first available from TTS_CHAIN_ORDER.
 */
export function pickTtsBackend(
  statuses: BackendStatus[],
  preferred?: TtsBackendName | "auto"
): { backend: TtsBackendName } | { error: string; triedBackends: string[] } {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  if (preferred && preferred !== "auto") {
    const s = byName.get(preferred);
    if (!s || !s.available) {
      return {
        error: `Preferred backend "${preferred}" not available: ${s?.reason ?? "unknown"}`,
        triedBackends: [preferred],
      };
    }
    return { backend: preferred };
  }
  const tried: string[] = [];
  for (const name of TTS_CHAIN_ORDER) {
    tried.push(name);
    const s = byName.get(name);
    if (s?.available) return { backend: name };
  }
  return {
    error: "No TTS backend available. Install sag (brew), set OPENAI_API_KEY, or run on macOS.",
    triedBackends: tried,
  };
}

export function pickSttBackend(
  statuses: BackendStatus[],
  preferred?: SttBackendName | "auto"
): { backend: SttBackendName } | { error: string; triedBackends: string[] } {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  if (preferred && preferred !== "auto") {
    const s = byName.get(preferred);
    if (!s || !s.available) {
      return {
        error: `Preferred STT backend "${preferred}" not available: ${s?.reason ?? "unknown"}`,
        triedBackends: [preferred],
      };
    }
    return { backend: preferred };
  }
  const tried: string[] = [];
  for (const name of STT_CHAIN_ORDER) {
    tried.push(name);
    const s = byName.get(name);
    if (s?.available) return { backend: name };
  }
  return {
    error: "No STT backend available. Install whisper-cli or set OPENAI_API_KEY.",
    triedBackends: tried,
  };
}

// ---------------------------------------------------------------------------
// Args assembly (pure — what we'd pass to each CLI)
// ---------------------------------------------------------------------------

export interface SpeakOptions {
  text: string;
  voice?: string;
  outputPath: string;
  config?: VoiceConfig;
}

export function sagArgs(opts: SpeakOptions): string[] {
  const args: string[] = [];
  const voice = opts.voice || opts.config?.defaultVoice;
  if (voice) args.push("-v", voice);
  args.push("-o", opts.outputPath);
  args.push(opts.text);
  return args;
}

export function sayArgs(opts: SpeakOptions): string[] {
  // `say -o out.aiff "hello"` → writes AIFF to out.aiff
  const args: string[] = [];
  const voice = opts.voice || opts.config?.defaultVoice;
  if (voice) args.push("-v", voice);
  args.push("-o", opts.outputPath);
  args.push(opts.text);
  return args;
}

/** ElevenLabs API POST body. Returns { url, headers, body }. */
export function elevenlabsRequest(
  opts: SpeakOptions,
  apiKey: string
): { url: string; headers: Record<string, string>; body: string } {
  const voiceId =
    opts.voice || opts.config?.elevenlabs?.voiceId || "EXAVITQu4vr4xnSDxMaL"; // default "Sarah"
  const model = opts.config?.elevenlabs?.model || "eleven_v3";
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: opts.text,
      model_id: model,
    }),
  };
}

// ---------------------------------------------------------------------------
// Whisper — model + quality helpers (shared across local backends)
// ---------------------------------------------------------------------------

/** Map a quality preset to whisper-cli flags. */
export function whisperCliArgs(opts: {
  audioPath: string;
  model?: WhisperModelSize;
  quality?: WhisperQuality;
  language?: string;
}): string[] {
  const args = ["-f", opts.audioPath, "--output-txt"];
  if (opts.model) {
    // whisper-cli accepts `-m <model-name>` — binary selects from local GGML files
    args.push("-m", opts.model);
  }
  const q = opts.quality ?? "balanced";
  if (q === "best") {
    args.push("-bs", "5"); // beam search size
    args.push("-bo", "5"); // best-of candidates
  } else if (q === "fast") {
    args.push("-bs", "1");
  }
  // "balanced" uses defaults (-bs 1 or so depending on build)
  if (opts.language) args.push("-l", opts.language);
  return args;
}

/** HF transformers.js pipeline options for Whisper. */
export interface HfWhisperPipelineOptions {
  /** e.g. "onnx-community/whisper-base" */
  modelId: string;
  /** Data type — fp32 for best, q8 for quantized (faster, lower memory) */
  dtype: "fp32" | "q8";
  /** Chunk length for long-audio streaming (seconds). */
  chunk_length_s: number;
  /** Overlap between chunks (seconds). */
  stride_length_s: number;
  /** Number of beams — >1 enables beam search (slower, more accurate). */
  num_beams?: number;
  /** Language code (ISO-639-1) or null for auto-detect. */
  language?: string;
  /** Task. Always "transcribe" for STT (vs "translate"). */
  task: "transcribe" | "translate";
}

/** Build pipeline options from user config + per-call overrides. */
export function hfWhisperPipelineOptions(opts: {
  model?: WhisperModelSize;
  quality?: WhisperQuality;
  language?: string;
}): HfWhisperPipelineOptions {
  const model = opts.model ?? "base";
  const quality = opts.quality ?? "balanced";
  return {
    modelId: `onnx-community/whisper-${model}`,
    dtype: quality === "best" ? "fp32" : "q8",
    chunk_length_s: 30,
    stride_length_s: 5,
    num_beams: quality === "best" ? 5 : 1,
    language: opts.language,
    task: "transcribe",
  };
}

/** OpenAI TTS API POST body. */
export function openaiTtsRequest(
  opts: SpeakOptions,
  apiKey: string
): { url: string; headers: Record<string, string>; body: string } {
  const voice = opts.voice || opts.config?.openai?.voice || "alloy";
  const model = opts.config?.openai?.model || "tts-1";
  return {
    url: "https://api.openai.com/v1/audio/speech",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: opts.text,
      voice,
    }),
  };
}

// ---------------------------------------------------------------------------
// Output path helpers
// ---------------------------------------------------------------------------

export function generateOutputPath(config?: VoiceConfig, ext = "mp3"): string {
  const dir = config?.outputDir || "/tmp";
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `clawcode-voice-${stamp}-${rand}.${ext}`);
}

// ---------------------------------------------------------------------------
// Side-effectful execution (not in unit tests — skill/server invokes these)
// ---------------------------------------------------------------------------

export interface SpeakResult {
  ok: boolean;
  backend?: TtsBackendName;
  path?: string;
  bytes?: number;
  error?: string;
  triedBackends?: string[];
}

export async function speak(
  text: string,
  opts: {
    config?: VoiceConfig;
    preferred?: TtsBackendName | "auto";
    voice?: string;
    outputPath?: string;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<SpeakResult> {
  if (!text || !text.trim()) {
    return { ok: false, error: "text is required" };
  }

  const env = opts.env ?? process.env;
  const statuses = detectTtsBackends({ env });
  const choice = pickTtsBackend(statuses, opts.preferred ?? opts.config?.defaultBackend);
  if ("error" in choice) {
    return { ok: false, error: choice.error, triedBackends: choice.triedBackends };
  }
  const backend = choice.backend;

  const ext = backend === "say" ? "aiff" : "mp3";
  const outputPath = opts.outputPath ?? generateOutputPath(opts.config, ext);

  try {
    // Ensure output dir exists
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (backend === "sag") {
      const args = sagArgs({ text, voice: opts.voice, outputPath, config: opts.config });
      execFileSync("sag", args, { stdio: ["ignore", "ignore", "pipe"] });
    } else if (backend === "say") {
      const args = sayArgs({ text, voice: opts.voice, outputPath, config: opts.config });
      execFileSync("say", args, { stdio: ["ignore", "ignore", "pipe"] });
    } else if (backend === "elevenlabs") {
      const key = env.ELEVENLABS_API_KEY || env.SAG_API_KEY;
      if (!key) throw new Error("ELEVENLABS_API_KEY missing at execution time");
      const req = elevenlabsRequest({ text, voice: opts.voice, outputPath, config: opts.config }, key);
      const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
      if (!res.ok) throw new Error(`ElevenLabs API ${res.status}: ${await res.text()}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outputPath, buf);
    } else if (backend === "openai-tts") {
      const key = env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY missing at execution time");
      const req = openaiTtsRequest({ text, voice: opts.voice, outputPath, config: opts.config }, key);
      const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
      if (!res.ok) throw new Error(`OpenAI TTS ${res.status}: ${await res.text()}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(outputPath, buf);
    }

    const stat = fs.statSync(outputPath);
    return { ok: true, backend, path: outputPath, bytes: stat.size };
  } catch (err) {
    return {
      ok: false,
      backend,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface TranscribeResult {
  ok: boolean;
  backend?: SttBackendName;
  text?: string;
  error?: string;
  triedBackends?: string[];
}

export async function transcribe(
  audioPath: string,
  opts: {
    config?: VoiceConfig;
    preferred?: SttBackendName | "auto";
    language?: string;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<TranscribeResult> {
  if (!audioPath) return { ok: false, error: "audioPath is required" };
  if (!fs.existsSync(audioPath)) {
    return { ok: false, error: `file not found: ${audioPath}` };
  }

  const env = opts.env ?? process.env;
  const statuses = detectSttBackends({ env });
  const choice = pickSttBackend(statuses, opts.preferred ?? opts.config?.defaultSttBackend);
  if ("error" in choice) {
    return { ok: false, error: choice.error, triedBackends: choice.triedBackends };
  }
  const backend = choice.backend;

  try {
    if (backend === "whisper-cli") {
      // whisper-cli -f <audio> --output-txt — writes <audio>.txt alongside.
      // Pass model + quality flags derived from config.
      const args = whisperCliArgs({
        audioPath,
        model: opts.config?.stt?.model,
        quality: opts.config?.stt?.quality,
        language: opts.language,
      });
      execFileSync("whisper-cli", args, { stdio: ["ignore", "ignore", "pipe"] });
      const txtPath = audioPath + ".txt";
      const text = fs.readFileSync(txtPath, "utf-8").trim();
      try {
        fs.unlinkSync(txtPath);
      } catch {}
      return { ok: true, backend, text };
    }

    if (backend === "hf-whisper") {
      // Dynamic import so the heavy dep only loads when this backend is used.
      const pipelineOpts = hfWhisperPipelineOptions({
        model: opts.config?.stt?.model,
        quality: opts.config?.stt?.quality,
        language: opts.language,
      });
      // @ts-expect-error — optional peer dep; may not be present at type-check time
      const mod = await import("@huggingface/transformers");
      const pipeline = (mod as any).pipeline;
      if (typeof pipeline !== "function") {
        throw new Error(
          "@huggingface/transformers installed but `pipeline` export missing"
        );
      }
      const transcriber = await pipeline("automatic-speech-recognition", pipelineOpts.modelId, {
        dtype: pipelineOpts.dtype,
      });
      const result = await transcriber(audioPath, {
        chunk_length_s: pipelineOpts.chunk_length_s,
        stride_length_s: pipelineOpts.stride_length_s,
        num_beams: pipelineOpts.num_beams,
        language: pipelineOpts.language,
        task: pipelineOpts.task,
      });
      const text = typeof result === "string" ? result : (result?.text ?? "");
      return { ok: true, backend, text: String(text).trim() };
    }

    if (backend === "openai-whisper") {
      const key = env.OPENAI_API_KEY!;
      const form = new FormData();
      const file = fs.readFileSync(audioPath);
      const blob = new Blob([file]);
      form.append("file", blob, path.basename(audioPath));
      form.append("model", "whisper-1");
      if (opts.language) form.append("language", opts.language);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) throw new Error(`OpenAI Whisper ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { text?: string };
      return { ok: true, backend, text: (data.text ?? "").trim() };
    }

    return { ok: false, error: `Unhandled backend: ${backend}`, backend };
  } catch (err) {
    return {
      ok: false,
      backend,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// WhatsApp plugin audio detection (so voice_status can honour precedence)
// ---------------------------------------------------------------------------

export interface WhatsappAudioState {
  /** Plugin's config.json exists on disk */
  pluginConfigured: boolean;
  /** Plugin has `audio.enabled: true` (or similar) — transcribes locally */
  audioEnabled: boolean;
  /** Detected language setting, if any */
  audioLanguage?: string;
  /** Path inspected */
  configPath: string;
  /** Error reading config (if any) */
  error?: string;
}

export function detectWhatsappAudio(
  opts: { home?: string; cwd?: string } = {}
): WhatsappAudioState {
  const home = opts.home ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();

  // Mirror the plugin's channel-dir resolution exactly: read
  // installed_plugins.json to find its local-scope projectPath, then fall
  // back to the global channel dir. Documented in claude-whatsapp's README
  // under "State contract for companion plugins".
  const candidates: string[] = [];
  const projectDir = detectWhatsappProjectDir(home, cwd);
  if (projectDir) {
    candidates.push(path.join(projectDir, ".whatsapp", "config.json"));
  }
  candidates.push(
    path.join(home, ".claude", "channels", "whatsapp", "config.json")
  );

  let raw: string | null = null;
  let configPath = candidates[0];
  let lastError: string | undefined;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      raw = fs.readFileSync(candidate, "utf-8");
      configPath = candidate;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const state: WhatsappAudioState = {
    pluginConfigured: false,
    audioEnabled: false,
    configPath,
  };

  if (raw === null) {
    if (lastError) state.error = lastError;
    return state;
  }
  state.pluginConfigured = true;

  try {
    const parsed = JSON.parse(raw) as any;
    // Top-level schema from claude-whatsapp v1.x (README → State contract):
    // `audioTranscription` (boolean) + `audioLanguage` (ISO code or null).
    if (parsed.audioTranscription === true) state.audioEnabled = true;
    if (typeof parsed.audioLanguage === "string" && parsed.audioLanguage) {
      state.audioLanguage = parsed.audioLanguage;
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Status — formatter
// ---------------------------------------------------------------------------

export interface VoiceStatus {
  enabled: boolean;
  tts: BackendStatus[];
  stt: BackendStatus[];
  chosen: {
    tts: TtsBackendName | null;
    stt: SttBackendName | null;
  };
  whatsapp: WhatsappAudioState;
}

export function getVoiceStatus(config?: VoiceConfig, env?: Record<string, string | undefined>): VoiceStatus {
  const tts = detectTtsBackends({ env });
  const stt = detectSttBackends({ env });
  const ttsPick = pickTtsBackend(tts, config?.defaultBackend);
  const sttPick = pickSttBackend(stt, config?.defaultSttBackend);
  return {
    enabled: config?.enabled === true,
    tts,
    stt,
    chosen: {
      tts: "backend" in ttsPick ? ttsPick.backend : null,
      stt: "backend" in sttPick ? sttPick.backend : null,
    },
    whatsapp: detectWhatsappAudio(),
  };
}

export function formatVoiceStatus(status: VoiceStatus): string {
  const lines: string[] = [];
  lines.push(`🎙️ Voice status`);
  lines.push("");
  lines.push(`Enabled: ${status.enabled ? "✅" : "⏸️ (voice.enabled=false)"}`);
  lines.push("");

  lines.push("TTS backends:");
  for (const b of status.tts) {
    const icon = b.available ? "✅" : "❌";
    const reason = b.available ? b.detail ?? "" : b.reason ?? "";
    lines.push(`  ${icon} ${b.name.padEnd(14)} ${reason}`);
  }
  lines.push(`  → chosen: ${status.chosen.tts ?? "(none)"}`);
  lines.push("");

  lines.push("STT backends:");
  for (const b of status.stt) {
    const icon = b.available ? "✅" : "❌";
    const reason = b.available ? b.detail ?? "" : b.reason ?? "";
    lines.push(`  ${icon} ${b.name.padEnd(16)} ${reason}`);
  }
  lines.push(`  → chosen: ${status.chosen.stt ?? "(none)"}`);
  lines.push("");

  if (status.whatsapp.pluginConfigured) {
    lines.push("WhatsApp channel:");
    if (status.whatsapp.audioEnabled) {
      lines.push(
        `  ✅ Local Whisper transcription is ON (${status.whatsapp.audioLanguage ?? "auto-detect"}).`
      );
      lines.push(
        `     Inbound WhatsApp voice notes arrive already transcribed — no need to call voice_transcribe for those.`
      );
    } else {
      lines.push(
        `  ⏸️ WhatsApp audio transcription disabled (run /whatsapp:configure audio to enable).`
      );
    }
  } else {
    lines.push(
      `WhatsApp plugin: not configured (no config.json in <project>/.whatsapp/ or ~/.claude/channels/whatsapp/)`
    );
  }

  return lines.join("\n");
}
