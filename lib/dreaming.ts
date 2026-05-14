/**
 * Dreaming system — background memory consolidation.
 * Mirrors OpenClaw's memory-core dreaming (3 phases).
 *
 * Phases:
 *   Light  → Ingest recent signals + recall traces, deduplicate candidates
 *   REM    → Extract patterns, build reflection summaries
 *   Deep   → Rank with 6 weighted signals, promote to MEMORY.md
 *
 * Signal weights (from OpenClaw docs):
 *   Frequency:           0.24 — how many short-term signals accumulated
 *   Relevance:           0.30 — average retrieval quality
 *   Query diversity:     0.15 — distinct query/day contexts
 *   Recency:             0.15 — time-decayed freshness
 *   Consolidation:       0.10 — multi-day recurrence strength
 *   Conceptual richness: 0.06 — concept-tag density
 */

import fs from "fs";
import path from "path";
import os from "node:os";
import crypto from "node:crypto";
import { loadConfig } from "./config.ts";
import {
  applyPreventivePromoteGuard,
  detectScopeRuntime,
  type ScopeRuntimeState,
} from "./scope/runtime.ts";
import { deriveProvenance } from "./scope/provenance.ts";
import {
  isSyntheticChunkPath,
  type MemoryDB,
} from "./memory-db.ts";
import {
  isKnownScopeChannel,
  isScopedMemoryPath,
  scopedMemoryPath,
} from "./scope/scoped-paths.ts";
import { decodeChatIdFromSyntheticPath } from "./scope/messages-db-indexer.ts";
import type { ChannelName } from "./channel-detector.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecallEntry {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  recallDays: string[];
  conceptTags: string[];
}

interface ScoredCandidate {
  key: string;
  entry: RecallEntry;
  signals: {
    frequency: number;
    relevance: number;
    queryDiversity: number;
    recency: number;
    consolidation: number;
    conceptualRichness: number;
  };
  finalScore: number;
}

interface DreamResult {
  phase: "light" | "rem" | "deep";
  candidates: ScoredCandidate[];
  promoted: ScoredCandidate[];
  skipped: ScoredCandidate[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Signal weights (from OpenClaw docs)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  frequency: 0.24,
  relevance: 0.30,
  queryDiversity: 0.15,
  recency: 0.15,
  consolidation: 0.10,
  conceptualRichness: 0.06,
};

// ---------------------------------------------------------------------------
// Default thresholds
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SCORE = 0.3;
const DEFAULT_MIN_RECALL_COUNT = 2;
const DEFAULT_MIN_UNIQUE_QUERIES = 1;
const DEFAULT_MAX_PROMOTIONS = 10;

// ---------------------------------------------------------------------------
// Core dreaming engine
// ---------------------------------------------------------------------------

export class DreamEngine {
  private pluginRoot: string;
  private dreamsDir: string;
  private memoryDb: MemoryDB | null;

  /**
   * `memoryDb` is optional. When supplied, the rehydration gate falls
   * back to `memoryDb.readFile` for paths that aren't readable from
   * disk — primarily synthetic chunks
   * (`extra:claude-whatsapp/messages-db/...`) which Phase 4a-2.6 stores
   * only in SQLite. Without this fallback, the entire scoped lane
   * silently disappears at the rehydration gate (Codex Phase 4a-3
   * pre-impl CRITICAL #10).
   */
  constructor(pluginRoot: string, memoryDb?: MemoryDB | null) {
    this.pluginRoot = pluginRoot;
    this.dreamsDir = path.join(pluginRoot, "memory", ".dreams");
    this.memoryDb = memoryDb ?? null;
  }

  /**
   * Load short-term recall state.
   */
  private loadRecallState(): Record<string, RecallEntry> {
    const recallPath = path.join(this.dreamsDir, "short-term-recall.json");
    try {
      const data = JSON.parse(fs.readFileSync(recallPath, "utf-8"));
      return data.entries || {};
    } catch {
      return {};
    }
  }

  /**
   * Load phase signals (reinforcement from previous light/rem runs).
   */
  private loadPhaseSignals(): Record<string, number> {
    const signalsPath = path.join(this.dreamsDir, "phase-signals.json");
    try {
      return JSON.parse(fs.readFileSync(signalsPath, "utf-8"));
    } catch {
      return {};
    }
  }

  /**
   * Save phase signals.
   */
  private savePhaseSignals(signals: Record<string, number>): void {
    const signalsPath = path.join(this.dreamsDir, "phase-signals.json");
    fs.mkdirSync(this.dreamsDir, { recursive: true });
    fs.writeFileSync(signalsPath, JSON.stringify(signals, null, 2));
  }

  /**
   * Compute individual signal scores for a recall entry.
   */
  private computeSignals(
    key: string,
    entry: RecallEntry,
    maxRecallCount: number,
    maxTotalScore: number,
    maxDays: number,
    maxTags: number,
    phaseBoost: number
  ): ScoredCandidate["signals"] {
    // Frequency: normalized recall count
    const frequency = maxRecallCount > 0
      ? entry.recallCount / maxRecallCount
      : 0;

    // Relevance: average score per recall
    const avgScore = entry.recallCount > 0
      ? entry.totalScore / entry.recallCount
      : 0;
    const relevance = Math.min(avgScore, 1.0);

    // Query diversity: unique recall days as proxy for distinct contexts
    const queryDiversity = maxDays > 0
      ? entry.recallDays.length / maxDays
      : 0;

    // Recency: time-decayed freshness (half-life 7 days for dreaming)
    const lastRecalled = new Date(entry.lastRecalledAt).getTime();
    const ageDays = (Date.now() - lastRecalled) / (1000 * 60 * 60 * 24);
    const lambda = Math.LN2 / 7; // 7-day half-life for recency signal
    const recency = Math.exp(-lambda * Math.max(0, ageDays));

    // Consolidation: multi-day recurrence strength
    const consolidation = entry.recallDays.length >= 2
      ? Math.min(entry.recallDays.length / 5, 1.0) // cap at 5 days
      : 0;

    // Conceptual richness: concept-tag density
    const conceptualRichness = maxTags > 0
      ? entry.conceptTags.length / maxTags
      : 0;

    return {
      frequency,
      relevance,
      queryDiversity,
      recency: recency + phaseBoost * 0.1, // phase reinforcement
      consolidation,
      conceptualRichness,
    };
  }

  /**
   * Compute final weighted score from signals.
   */
  private computeFinalScore(signals: ScoredCandidate["signals"]): number {
    return (
      signals.frequency * WEIGHTS.frequency +
      signals.relevance * WEIGHTS.relevance +
      signals.queryDiversity * WEIGHTS.queryDiversity +
      signals.recency * WEIGHTS.recency +
      signals.consolidation * WEIGHTS.consolidation +
      signals.conceptualRichness * WEIGHTS.conceptualRichness
    );
  }

  /**
   * Replace channel-derived (extra:* or memory/.scoped/*) paths with a
   * sanitized form for any user-visible dream surface that escapes the
   * scoped lane — `DREAMS.md`, `MEMORY.md` headers, and the `dream`
   * MCP tool response. Non-channel paths pass through unchanged.
   *
   * Output shape: `<scoped:<channel>:<8-char-hash>>` for known
   * channels, `<scoped:unknown:<8-char-hash>>` for legacy `extra:`
   * paths whose channel hint we can't derive. The hash is a stable
   * SHA-256 prefix so a recurring entry stays identifiable across
   * dream cycles without exposing chat_id or date.
   *
   * Codex Phase 4a-3 post-impl CRITICAL #2 + post-impl-round2 CRITICAL
   * #6: absolute paths under the workspace are normalized to
   * workspace-relative form BEFORE provenance lookup so
   * `/abs/path/memory/.scoped/whatsapp/MEMORY.alice.md` redacts
   * correctly instead of falling through unrecognized.
   */
  private redactDreamPath(p: string): string {
    if (typeof p !== "string" || p.length === 0) return "<unknown>";
    const hash = () =>
      crypto.createHash("sha256").update(p).digest("hex").slice(0, 8);

    // Codex post-impl-round3 CRITICAL #1 + post-impl-round4 H1:
    // any path that contains the sentinel `/memory/.scoped/`
    // substring MUST redact, regardless of pluginRoot containment.
    // This closes the symlink-canonical-form bypass AND the
    // case-insensitive-FS bypass (Windows / APFS) where a path
    // surfaces as `Memory/.scoped/...`. Lowercase BOTH sides for
    // the substring match so case variants don't slip through.
    const pLower = p.toLowerCase();
    if (
      pLower.includes("/memory/.scoped/") ||
      pLower.includes("\\memory\\.scoped\\")
    ) {
      // Recover the channel name from the path body for a cleaner
      // hash label. Codex post-impl-round5 RH-7: validate the
      // captured name against `KNOWN_SCOPE_CHANNELS`; an arbitrary
      // `[a-z0-9_-]+` directory name (e.g. an attacker-planted
      // `notreal/`) must NOT be emitted as a trusted channel
      // label.
      const m =
        pLower.match(/[/\\]memory[/\\]\.scoped[/\\]([a-z0-9_-]+)[/\\]/) ??
        null;
      const captured = m && m[1] ? m[1] : null;
      const ch =
        captured && isKnownScopeChannel(captured) ? captured : "unknown";
      return `<scoped:${ch}:${hash()}>`;
    }

    // Normalize absolute paths under pluginRoot back to logical form
    // so the path-pattern matchers in deriveProvenance / scoped-paths
    // can recognize them. We avoid `fs.realpathSync` here because the
    // `/memory/.scoped/` substring guard above is the authoritative
    // PII gate — `path.resolve` is enough for the happy path.
    let logical = p;
    try {
      if (path.isAbsolute(p)) {
        const resolvedRoot = path.resolve(this.pluginRoot);
        const resolvedP = path.resolve(p);
        if (
          resolvedP === resolvedRoot ||
          resolvedP.startsWith(resolvedRoot + path.sep)
        ) {
          const rel = path.relative(resolvedRoot, resolvedP);
          logical = rel.split(path.sep).join("/");
        }
      }
    } catch {}
    try {
      const prov = deriveProvenance(logical);
      if (prov.class.kind === "channel" && prov.sourceChannel) {
        return `<scoped:${prov.sourceChannel}:${hash()}>`;
      }
    } catch {}
    if (logical.startsWith("extra:") || p.startsWith("extra:")) {
      return `<scoped:unknown:${hash()}>`;
    }
    if (logical.startsWith("memory/.scoped/")) {
      return `<scoped:unknown:${hash()}>`;
    }
    return p;
  }

  /**
   * Public alias for `redactDreamPath`. Used by the `dream` MCP tool
   * handler in `server.ts` to redact citation paths before they
   * appear in the tool response. Codex post-impl-round3 CRITICAL #7:
   * the tool was emitting raw `c.entry.path` directly; without this
   * accessor a non-owner caller of `dream` would see chat IDs that
   * the search lane would have filtered.
   */
  redactPathForDisplay(p: string): string {
    return this.redactDreamPath(p);
  }

  /**
   * Rehydrate snippet from live file — skip if file/lines no longer
   * exist.
   *
   * Routing:
   *   1. Synthetic chunk paths (`extra:claude-whatsapp/messages-db/...`)
   *      have no on-disk file — read via `MemoryDB.readFile` which
   *      dispatches to the chunks table (Codex pre-impl CRITICAL
   *      #10).
   *   2. Other `extra:<root>/...` paths refer to real on-disk files
   *      under a configured `memory.extraPaths` root, but
   *      `path.resolve(pluginRoot, "extra:...")` does NOT understand
   *      the `extra:` prefix — it'd produce nonsense. Route through
   *      `MemoryDB.readFile` which understands `extra:` via
   *      `resolveLogicalPath` and returns the real file content
   *      (Codex post-impl-round8 HIGH).
   *   3. Workspace-relative paths fall back to direct
   *      `fs.readFileSync(path.resolve(pluginRoot, entry.path))`
   *      because that's the original behavior and `MemoryDB.readFile`
   *      for workspace paths returns line-numbered text we'd have to
   *      strip.
   */
  private rehydrateSnippet(entry: RecallEntry): string | null {
    if (this.memoryDb && entry.path.startsWith("extra:")) {
      const lineCount = Math.max(
        1,
        entry.endLine - entry.startLine + 1
      );
      const result = this.memoryDb.readFile(
        entry.path,
        entry.startLine,
        lineCount
      );
      if ("error" in result) return null;
      // For synthetic paths `MemoryDB.readFile` returns plain text
      // and we MUST NOT strip a `\d+\t` prefix that happens to appear
      // naturally in chat content (Codex post-impl-round9 WATCH #1).
      // For real `extra:` paths it returns line-number-prefixed
      // text and we strip per line.
      const raw = result.text;
      let snippet: string;
      if (isSyntheticChunkPath(entry.path)) {
        snippet = raw.trim();
      } else {
        const linePrefixRe = /^\d+\t/;
        const stripped = raw
          .split("\n")
          .map((l) =>
            linePrefixRe.test(l) ? l.replace(linePrefixRe, "") : l
          );
        snippet = stripped.join("\n").trim();
      }
      return snippet || null;
    }
    try {
      const fullPath = path.resolve(this.pluginRoot, entry.path);
      if (!fs.existsSync(fullPath)) return null;

      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      const start = Math.max(0, entry.startLine - 1);
      const end = Math.min(lines.length, entry.endLine);
      const snippet = lines.slice(start, end).join("\n").trim();

      return snippet || null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a candidate is already in MEMORY.md (avoid duplicates).
   */
  private isAlreadyInMemory(snippet: string): boolean {
    try {
      const memoryPath = path.join(this.pluginRoot, "memory", "MEMORY.md");
      const content = fs.readFileSync(memoryPath, "utf-8");
      // Check if a significant portion of the snippet is already present
      const words = snippet.split(/\s+/).filter((w) => w.length > 3);
      if (words.length === 0) return false;

      let matches = 0;
      for (const word of words.slice(0, 10)) {
        if (content.toLowerCase().includes(word.toLowerCase())) matches++;
      }
      return matches / Math.min(words.length, 10) > 0.7;
    } catch {
      return false;
    }
  }

  /**
   * Read recent daily memory files (last N days) for REM theme extraction.
   */
  private readRecentDailyFiles(days: number = 3): Array<{ path: string; content: string; date: string }> {
    const memoryDir = path.join(this.pluginRoot, "memory");
    const files: Array<{ path: string; content: string; date: string }> = [];

    try {
      const entries = fs.readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith(".md"));
      // Sort by date descending
      entries.sort().reverse();

      for (const entry of entries.slice(0, days * 3)) { // Allow multiple files per day
        try {
          const content = fs.readFileSync(path.join(memoryDir, entry), "utf-8");
          const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            files.push({ path: `memory/${entry}`, content, date: dateMatch[1] });
          }
        } catch {}
      }
    } catch {}

    return files;
  }

  /**
   * Run Light phase — ingest signals, deduplicate, record reinforcements.
   * Also reads recent daily files to feed into REM phase.
   */
  runLight(): { candidates: number; signals: number; dailyFiles: number } {
    const entries = this.loadRecallState();
    const phaseSignals = this.loadPhaseSignals();

    let signalCount = 0;
    for (const [key, entry] of Object.entries(entries)) {
      if (entry.recallCount >= 1) {
        // Record reinforcement signal: recency-decayed boost
        const lastRecalled = new Date(entry.lastRecalledAt).getTime();
        const ageDays = (Date.now() - lastRecalled) / (1000 * 60 * 60 * 24);
        const boost = Math.exp(-Math.LN2 / 14 * ageDays); // 14-day half-life
        phaseSignals[key] = (phaseSignals[key] || 0) + boost;
        signalCount++;
      }
    }

    this.savePhaseSignals(phaseSignals);

    const dailyFiles = this.readRecentDailyFiles(3);
    return { candidates: Object.keys(entries).length, signals: signalCount, dailyFiles: dailyFiles.length };
  }

  /**
   * Run REM phase — extract themes and reflection patterns from recall traces.
   * Produces a ## REM Sleep block in DREAMS.md with themes found.
   * Returns a prompt that can be used for LLM-driven reflection.
   */
  runREM(): { themes: string[]; reflectionPrompt: string } {
    const entries = this.loadRecallState();
    const dailyFiles = this.readRecentDailyFiles(3);

    // Extract themes from concept tags across all recall entries
    const tagCounts: Record<string, number> = {};
    for (const entry of Object.values(entries)) {
      for (const tag of entry.conceptTags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }

    // Top themes by frequency
    const themes = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => `${tag} (${count}x)`);

    // Find patterns: entries recalled on multiple days
    const multiDayEntries = Object.values(entries)
      .filter((e) => e.recallDays.length >= 2)
      .sort((a, b) => b.recallDays.length - a.recallDays.length);

    // Build REM block for DREAMS.md
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const remLines: string[] = [
      "",
      `## REM Sleep — ${now}`,
      "",
    ];

    if (themes.length > 0) {
      remLines.push("### Recurring Themes");
      remLines.push(themes.map((t) => `- ${t}`).join("\n"));
      remLines.push("");
    }

    if (multiDayEntries.length > 0) {
      remLines.push("### Multi-Day Patterns");
      for (const entry of multiDayEntries.slice(0, 5)) {
        const safePath = this.redactDreamPath(entry.path);
        remLines.push(
          `- **${safePath}#L${entry.startLine}** — recalled ${entry.recallDays.length} days, tags: ${entry.conceptTags.slice(0, 5).join(", ")}`
        );
      }
      remLines.push("");
    }

    if (dailyFiles.length > 0) {
      remLines.push(`### Recent Context (${dailyFiles.length} daily files scanned)`);
      for (const f of dailyFiles.slice(0, 3)) {
        const preview = f.content.split("\n").filter((l) => l.trim()).slice(0, 2).join(" | ");
        remLines.push(`- ${f.path}: ${preview.slice(0, 100)}...`);
      }
      remLines.push("");
    }

    // Write REM block to DREAMS.md
    const dreamsPath = path.join(this.pluginRoot, "DREAMS.md");
    try {
      if (fs.existsSync(dreamsPath)) {
        fs.appendFileSync(dreamsPath, remLines.join("\n"));
      } else {
        fs.writeFileSync(dreamsPath, `# Dreams\n\n*Memory consolidation diary.*\n${remLines.join("\n")}`);
      }
    } catch {}

    // Build reflection prompt for agent (LLM-driven part of REM)
    const reflectionPrompt = [
      "Review these recurring memory themes from your recent recall traces:",
      themes.length > 0 ? `Themes: ${themes.join(", ")}` : "No strong themes yet.",
      multiDayEntries.length > 0
        ? `Patterns: ${multiDayEntries.length} memories recalled across multiple days.`
        : "No multi-day patterns yet.",
      "Reflect: Are there insights or connections worth noting in your daily memory file?",
    ].join("\n");

    // Record REM reinforcement signals
    const phaseSignals = this.loadPhaseSignals();
    for (const entry of multiDayEntries) {
      const key = `memory:${entry.path}:${entry.startLine}:${entry.endLine}`;
      phaseSignals[key] = (phaseSignals[key] || 0) + 0.15; // REM boost
    }
    this.savePhaseSignals(phaseSignals);

    return { themes: themes.map((t) => t.replace(/ \(\d+x\)$/, "")), reflectionPrompt };
  }

  /**
   * Run Deep phase — rank candidates, promote winners to MEMORY.md.
   */
  runDeep(options?: {
    minScore?: number;
    minRecallCount?: number;
    minUniqueQueries?: number;
    maxPromotions?: number;
    dryRun?: boolean;
  }): DreamResult {
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
    const minRecallCount = options?.minRecallCount ?? DEFAULT_MIN_RECALL_COUNT;
    const minUniqueQueries = options?.minUniqueQueries ?? DEFAULT_MIN_UNIQUE_QUERIES;
    const maxPromotions = options?.maxPromotions ?? DEFAULT_MAX_PROMOTIONS;
    const dryRun = options?.dryRun ?? false;

    const entries = this.loadRecallState();
    const phaseSignals = this.loadPhaseSignals();

    // Compute normalization maxes
    const allEntries = Object.values(entries);
    const maxRecallCount = Math.max(...allEntries.map((e) => e.recallCount), 1);
    const maxTotalScore = Math.max(...allEntries.map((e) => e.totalScore), 1);
    const maxDays = Math.max(...allEntries.map((e) => e.recallDays.length), 1);
    const maxTags = Math.max(...allEntries.map((e) => e.conceptTags.length), 1);

    // Score all candidates
    const candidates: ScoredCandidate[] = [];
    for (const [key, entry] of Object.entries(entries)) {
      const phaseBoost = phaseSignals[key] || 0;
      const signals = this.computeSignals(
        key, entry, maxRecallCount, maxTotalScore, maxDays, maxTags, phaseBoost
      );
      const finalScore = this.computeFinalScore(signals);
      candidates.push({ key, entry, signals, finalScore });
    }

    // Sort by final score descending
    candidates.sort((a, b) => b.finalScore - a.finalScore);

    // Apply threshold gates
    const promoted: ScoredCandidate[] = [];
    const skipped: ScoredCandidate[] = [];

    for (const candidate of candidates) {
      if (promoted.length >= maxPromotions) break;

      const passesScore = candidate.finalScore >= minScore;
      const passesRecall = candidate.entry.recallCount >= minRecallCount;
      const passesQueries = candidate.entry.recallDays.length >= minUniqueQueries;

      if (!passesScore || !passesRecall || !passesQueries) {
        skipped.push(candidate);
        continue;
      }

      // Rehydrate snippet from live file
      const snippet = this.rehydrateSnippet(candidate.entry);
      if (!snippet) {
        skipped.push(candidate);
        continue;
      }

      // Skip if already in MEMORY.md
      if (this.isAlreadyInMemory(snippet)) {
        skipped.push(candidate);
        continue;
      }

      promoted.push(candidate);
    }

    // Write promotions to MEMORY.md (unless dry run)
    if (!dryRun && promoted.length > 0) {
      this.promoteToMemory(promoted);
    }

    // Write DREAMS.md summary
    const summary = this.writeDreamSummary(promoted, skipped, candidates.length);

    return {
      phase: "deep",
      candidates,
      promoted,
      skipped,
      summary,
    };
  }

  /**
   * Append promoted entries to MEMORY.md and per-channel scoped
   * mirrors.
   *
   * Phase 0/3 preventive scope guard runs first: when any channel is
   * armed, candidates sourced from `memory.extraPaths` (channel logs,
   * prefixed `extra:`) are pulled out of the shared `MEMORY.md` flow.
   *
   * Phase 4a-3 dual-lane: instead of dropping those guarded candidates
   * silently, route them to per-channel
   * `memory/.scoped/<channel>/MEMORY.<encoded-chat-id>.md` mirrors so
   * the user keeps useful long-term memory while honoring the same
   * channel/chat visibility rules the search lane already enforces.
   * Provenance derivation determines the destination per candidate.
   * Routing is fully inert when no channel is armed (legacy behavior).
   */
  private promoteToMemory(promoted: ScoredCandidate[]): void {
    const memoryPath = path.join(this.pluginRoot, "memory", "MEMORY.md");
    const today = new Date().toISOString().slice(0, 10);

    // Codex CRITICAL fix (Phase 4a-2): runtime must be live, not the
    // no-arg default which is hard-wired to no-armed.
    const runtime = detectScopeRuntime(loadConfig(this.pluginRoot), this.pluginRoot);

    // Phase 4a-3 dual-lane router — splits the input into local and
    // per-channel-scoped destinations. Fully inert when no channel is
    // armed (returns all candidates as `local`, scoped map empty).
    const { local, scoped } = this.routePromotions(promoted, runtime);

    // Defense in depth: even after routing, run the original
    // preventive guard against the local lane to ensure no `extra:`
    // path slipped through (e.g. a future provenance derivation gap).
    // Today this should always be a no-op when routing is correct.
    const { kept: localPromotable, skipped: guardSkipped } =
      applyPreventivePromoteGuard(local, runtime);

    // ---- Local lane → memory/MEMORY.md
    const lines: string[] = ["", `## Promoted by dreaming (${today})`, ""];
    let routedToScoped = 0;
    for (const group of scoped.values()) routedToScoped += group.length;
    if (routedToScoped > 0) {
      lines.push(
        `<!-- ${routedToScoped} candidate(s) routed to memory/.scoped/<channel>/ per dual-lane scope -->`
      );
      lines.push("");
    }
    if (guardSkipped > 0) {
      lines.push(
        `<!-- ${guardSkipped} candidate(s) skipped: scope guard fallback (channel-derived source paths) -->`
      );
      lines.push("");
    }
    let localWritten = 0;
    for (const candidate of localPromotable) {
      const snippet = this.rehydrateSnippet(candidate.entry);
      if (!snippet) continue;
      lines.push(
        `- ${snippet.split("\n")[0].trim()} *(score: ${candidate.finalScore.toFixed(2)}, source: ${candidate.entry.path}#L${candidate.entry.startLine})*`
      );
      localWritten++;
    }
    lines.push("");
    if (localWritten > 0 || routedToScoped > 0 || guardSkipped > 0) {
      try {
        fs.appendFileSync(memoryPath, lines.join("\n"));
      } catch {
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
        fs.writeFileSync(memoryPath, `# Memory\n${lines.join("\n")}`);
      }
    }

    // ---- Scoped lane → memory/.scoped/<channel>/MEMORY.<chat>.md
    for (const [destRelPath, group] of scoped) {
      this.writeScopedMemory(destRelPath, group);
    }
  }

  /**
   * Phase 4a-3 dual-lane router. Per candidate, derive provenance
   * from the entry path:
   *
   *   - `class.kind === "channel"` AND that channel is armed in the
   *     current runtime → scoped lane keyed by
   *     `memory/.scoped/<channel>/MEMORY.<encoded-chat-id>.md`
   *   - everything else → local lane → `memory/MEMORY.md`
   *
   * When `runtime.anyArmed === false`, every candidate goes local.
   * This is the legacy behavior — the dual-lane is strictly
   * opt-in.
   *
   * When at least one channel is armed but a candidate's source is a
   * DIFFERENT, unarmed channel, that candidate also goes local. This
   * preserves data instead of silently dropping it: the user
   * explicitly opted in to scope `whatsapp`, not `telegram`, so
   * `telegram` content remains in MEMORY.md as before. Subsequent
   * arming of `telegram` will start routing new candidates to
   * `.scoped/telegram/`; older ones stay in MEMORY.md (no
   * retroactive movement).
   */
  private routePromotions(
    promoted: ScoredCandidate[],
    runtime: ScopeRuntimeState
  ): {
    local: ScoredCandidate[];
    scoped: Map<string, ScoredCandidate[]>;
  } {
    // Codex round-8 ship-readiness BLOCKER fix: also route when any
    // channel is enforce-configured but adapter is missing — those
    // chunks must NOT land in MEMORY.md while the adapter is down.
    if (!runtime.anyArmed && !runtime.anyEnforceConfigured) {
      return { local: [...promoted], scoped: new Map() };
    }
    const local: ScoredCandidate[] = [];
    const scoped = new Map<string, ScoredCandidate[]>();
    for (const c of promoted) {
      const prov = deriveProvenance(c.entry.path);
      if (prov.class.kind === "channel" && prov.sourceChannel) {
        const channelName = prov.sourceChannel as ChannelName;
        const channelState = runtime.channels[channelName];
        // Codex round-8 BLOCKER fix: divert to scoped lane when channel
        // is armed OR enforce-configured-but-adapter-missing.
        if (channelState?.armed || channelState?.mode === "enforce") {
          // Already-scoped candidates (a `.scoped/...` path picked up
          // by a later dream cycle) round-trip through the same
          // destination — idempotent.
          let dest: string;
          try {
            // Stage-1 provenance leaves sourceChatId null for `extra:`
            // paths because it's path-pattern-only. Synthetic chunk
            // paths encode chat_id in the path itself
            // (`extra:<channel>/messages-db/<chat>/<date>`); recover
            // it here so the dual-lane file is keyed per chat instead
            // of dumping every chat into the `_anychat` bucket.
            let chatId = prov.sourceChatId;
            if (!chatId && isSyntheticChunkPath(c.entry.path)) {
              chatId = decodeChatIdFromSyntheticPath(c.entry.path);
            }
            dest = scopedMemoryPath(channelName, chatId ?? "*");
          } catch {
            // Unsafe channel name in provenance — shouldn't happen
            // because runtime channels are name-validated, but fall
            // back to local lane rather than crashing the dream.
            local.push(c);
            continue;
          }
          // If the candidate's path is already the destination,
          // append still produces an idempotent dedup-by-content
          // step downstream via `isAlreadyInScoped`.
          const arr = scoped.get(dest) ?? [];
          arr.push(c);
          scoped.set(dest, arr);
          continue;
        }
      }
      local.push(c);
    }
    return { local, scoped };
  }

  /**
   * Append a routed candidate group to a per-channel scoped MEMORY
   * mirror. Creates the directory tree with restrictive 0700
   * permissions and the file with 0600 so direct filesystem reads at
   * least face the host OS's permission gate (the MCP scope filter is
   * still authoritative — see docs/channel-scope-compat.md "Native
   * bypass" for the full threat model).
   *
   * Codex Phase 4a-3 post-impl MEDIUM #7: read-then-append is racy
   * across concurrent dream cycles (a multi-instance MCP setup or
   * an external `dream` invocation overlapping the scheduled tick)
   * because two processes can both miss the dedup check and append
   * the same bullet. Mitigated with an exclusive `O_EXCL` lockfile
   * created at `<destPath>.lock` with a short stale-lock recovery
   * window. The whole read-dedup-write block runs under the lock.
   */
  private writeScopedMemory(
    destRelPath: string,
    group: ScoredCandidate[]
  ): void {
    if (!isScopedMemoryPath(destRelPath)) return; // defense in depth
    const fullPath = path.resolve(this.pluginRoot, destRelPath);
    const channelDir = path.dirname(fullPath);
    const scopedRoot = path.dirname(channelDir);

    fs.mkdirSync(channelDir, { recursive: true });
    try {
      fs.chmodSync(scopedRoot, 0o700);
    } catch {}
    try {
      fs.chmodSync(channelDir, 0o700);
    } catch {}

    const lockPath = fullPath + ".lock";
    const acquired = this.acquireScopedLock(lockPath);
    if (!acquired) return; // peer is writing; their bullets cover ours

    try {
      const today = new Date().toISOString().slice(0, 10);
      const isNewFile = !fs.existsSync(fullPath);
      const channel = path.basename(channelDir);

      // Read existing content ONCE under the lock so dedup is
      // consistent with the appendFile that follows.
      const existing = isNewFile
        ? ""
        : fs.readFileSync(fullPath, "utf-8");

      const lines: string[] = [];
      if (isNewFile) {
        lines.push(`# Scoped memory — ${channel}`);
        lines.push("");
        lines.push(
          "> Per-channel mirror of dream-promoted candidates. Visibility"
        );
        lines.push(
          "> follows the same scope rules as the source content. Direct"
        );
        lines.push(
          "> filesystem access (Read/Grep/SQLite/import-export) bypasses"
        );
        lines.push(
          "> the MCP scope filter — see docs/channel-scope-compat.md."
        );
        lines.push("");
      }
      lines.push(`## Promoted by dreaming (${today})`);
      lines.push("");

      let written = 0;
      const seenThisRun = new Set<string>();
      for (const c of group) {
        // Codex post-impl MEDIUM #9: skip a candidate whose own path
        // resolves to the destination — feeding the destination back
        // through dream as a new candidate (e.g. `MemoryDB.sync()`
        // re-indexed the scoped file and a later cycle picked it up)
        // would otherwise produce a wrap-around duplicate that the
        // substring dedup misses because the bullet text contains the
        // current `source:` field.
        if (c.entry.path === destRelPath) continue;
        const snippet = this.rehydrateSnippet(c.entry);
        if (!snippet) continue;
        const firstLine = snippet.split("\n")[0].trim();
        // Stable dedup key: hash of (first-line, source path). Score
        // intentionally excluded since it drifts across cycles. The
        // hash is appended to the bullet so subsequent ticks can
        // recognize the same candidate via a substring grep.
        const identitySrc = `${firstLine}::${c.entry.path}#L${c.entry.startLine}`;
        const idHash = crypto
          .createHash("sha256")
          .update(identitySrc)
          .digest("hex")
          .slice(0, 12);
        if (seenThisRun.has(idHash)) continue;
        seenThisRun.add(idHash);
        const idMarker = `[id:${idHash}]`;
        if (existing.includes(idMarker)) continue;
        const bullet = `- ${firstLine} *(score: ${c.finalScore.toFixed(2)}, source: ${c.entry.path}#L${c.entry.startLine}, ${idMarker})*`;
        lines.push(bullet);
        written++;
      }
      if (written === 0) {
        return; // nothing to write — don't pad headers
      }

      lines.push("");
      if (isNewFile) {
        fs.writeFileSync(fullPath, lines.join("\n"), { mode: 0o600 });
      } else {
        fs.appendFileSync(fullPath, lines.join("\n"));
        try {
          fs.chmodSync(fullPath, 0o600);
        } catch {}
      }
    } finally {
      this.releaseScopedLock(lockPath);
    }
  }

  private acquireScopedLock(lockPath: string): boolean {
    const STALE_MS = 30_000;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const fd = fs.openSync(lockPath, "wx", 0o600);
        try {
          // Codex post-impl-round2 MEDIUM #2: write a structured
          // `{pid, hostname, ts}` payload so stale-lock recovery
          // can verify the holder is dead before takeover instead
          // of trusting mtime alone (which lags on shared FS / VM
          // clock skew).
          fs.writeSync(
            fd,
            JSON.stringify({
              pid: process.pid,
              hostname: os.hostname(),
              ts: Date.now(),
            })
          );
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
        // Stale-lock recovery — verify ownership before takeover.
        // We unlink ONLY when the lockfile is older than STALE_MS AND
        // (a) the writer is on this host with a dead PID, OR (b) the
        // lockfile is unreadable/malformed (interrupted writer / legacy
        // format), OR (c) the writer is on a different host AND the
        // lockfile is older than the long grace window (5 min).
        //
        // Codex post-impl-round4 H6: clamp future mtimes to `now` so a
        // clock-skewed Windows / VM workspace can't wedge the lane
        // forever. A lockfile timestamped in the future evaluates as
        // "instantly stale" via min(mtime, now), then falls back to
        // the existing PID-probe path; if no PID can be probed, the
        // 5-minute cross-host grace still bounds the wait.
        let canTakeOver = false;
        try {
          const st = fs.statSync(lockPath);
          const now = Date.now();
          const effectiveMtime = Math.min(st.mtimeMs, now);
          // Codex post-impl-round5 RH-3 + post-impl-round6 #1:
          // far-future mtime is treated AS-IF stale (enters the
          // ownership-probe path) but does NOT immediately fire
          // takeover. Round 5's unconditional takeover discarded
          // the PID/hostname check — a live cross-host writer with
          // a fast clock would lose its lock. v6+round6 routes
          // far-future through the same probe; only dead/unknown
          // owners get unlinked.
          const FUTURE_SKEW_TOLERANCE_MS = 5 * 60_000;
          const farFuture = st.mtimeMs > now + FUTURE_SKEW_TOLERANCE_MS;
          if (farFuture || now - effectiveMtime > STALE_MS) {
            let payload: { pid?: unknown; hostname?: unknown } | null = null;
            try {
              const raw = fs.readFileSync(lockPath, "utf-8");
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object") {
                payload = parsed as { pid?: unknown; hostname?: unknown };
              }
            } catch {
              // Non-JSON payload (interrupted writer / pre-v2 format)
              // — fall through to the malformed-payload takeover.
            }
            // Codex post-impl-round7 concern #8: validate the PID
            // shape before probing. `pid: 0`, negative, fractional,
            // or non-safe-integer values produce non-ESRCH errors
            // (or worse, signal the running Node process via PID 0
            // semantics). Treat invalid PIDs as unprobeable → fall
            // through to the cross-host / timestamp branch.
            const validPid =
              payload &&
              typeof payload.pid === "number" &&
              Number.isSafeInteger(payload.pid) &&
              payload.pid > 0;
            if (
              payload &&
              validPid &&
              typeof payload.hostname === "string"
            ) {
              if (payload.hostname === os.hostname()) {
                try {
                  process.kill(payload.pid as number, 0);
                  // Live process — don't steal regardless of mtime.
                } catch (probeErr) {
                  const code = (probeErr as NodeJS.ErrnoException).code;
                  if (code === "ESRCH") {
                    // Definitely dead.
                    canTakeOver = true;
                  } else if (code === "EPERM") {
                    // Codex post-impl-round3 MEDIUM #6: Windows
                    // throws EPERM for both live and dead processes.
                    // Without a fallthrough the lock wedges until
                    // manual cleanup. After the longer grace window
                    // (5 minutes) OR far-future mtime (corrupt
                    // timestamp on this host), trust the timestamp.
                    if (farFuture || now - effectiveMtime > 5 * 60_000) {
                      canTakeOver = true;
                    }
                  }
                  // Any other code: assume live — don't steal.
                }
              } else if (farFuture || now - effectiveMtime > 5 * 60_000) {
                // Cross-host writer + (far-future-mtime corrupt
                // timestamp OR > 5-min cross-host grace). We can't
                // probe a remote PID, so timestamp-based takeover
                // is the only bound on the wedge. Codex
                // post-impl-round6 #1: this is the path that
                // actually unsticks legitimate-corrupt lockfiles.
                canTakeOver = true;
              }
            } else {
              // Malformed / wrong-shape payload — assume interrupted
              // writer past STALE_MS. Safer to take over than to
              // wedge the lane forever on a corrupted lock.
              canTakeOver = true;
            }
          }
        } catch {}
        if (canTakeOver) {
          try {
            fs.unlinkSync(lockPath);
          } catch {}
          continue;
        }
        // Brief synchronous wait then retry.
        const start = Date.now();
        while (Date.now() - start < 20) {
          /* spin */
        }
      }
    }
    return false;
  }

  private releaseScopedLock(lockPath: string): void {
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }

  /**
   * Write/append DREAMS.md with phase summary.
   */
  private writeDreamSummary(
    promoted: ScoredCandidate[],
    skipped: ScoredCandidate[],
    totalCandidates: number
  ): string {
    const dreamsPath = path.join(this.pluginRoot, "DREAMS.md");
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");

    const lines: string[] = [
      "",
      `## Deep Sleep — ${now}`,
      "",
      `Candidates: ${totalCandidates} | Promoted: ${promoted.length} | Skipped: ${skipped.length}`,
      "",
    ];

    if (promoted.length > 0) {
      lines.push("### Promoted to MEMORY.md");
      for (const c of promoted) {
        const safePath = this.redactDreamPath(c.entry.path);
        lines.push(
          `- **${safePath}#L${c.entry.startLine}** — score: ${c.finalScore.toFixed(3)} (recalled ${c.entry.recallCount}x across ${c.entry.recallDays.length} days)`
        );
      }
      lines.push("");
    }

    if (skipped.length > 0 && skipped.length <= 10) {
      lines.push("### Skipped (below threshold)");
      for (const c of skipped.slice(0, 5)) {
        const safePath = this.redactDreamPath(c.entry.path);
        lines.push(
          `- ${safePath}#L${c.entry.startLine} — score: ${c.finalScore.toFixed(3)} (recalled ${c.entry.recallCount}x)`
        );
      }
      lines.push("");
    }

    const summary = lines.join("\n");

    try {
      // Append to existing DREAMS.md
      if (fs.existsSync(dreamsPath)) {
        fs.appendFileSync(dreamsPath, summary);
      } else {
        fs.writeFileSync(
          dreamsPath,
          `# Dreams\n\n*Memory consolidation diary.*\n${summary}`
        );
      }
    } catch {
      // Non-fatal
    }

    return summary;
  }

  /**
   * Run full dreaming sweep (all 3 phases).
   * Returns deep result + REM themes + reflection prompt.
   */
  runFullSweep(options?: {
    minScore?: number;
    minRecallCount?: number;
    maxPromotions?: number;
    dryRun?: boolean;
  }): DreamResult & { themes: string[]; reflectionPrompt: string } {
    // Phase 1: Light — ingest signals, record reinforcements
    const light = this.runLight();

    // Phase 2: REM — extract themes, patterns, write REM block, record reinforcements
    const rem = this.runREM();

    // Phase 3: Deep — score candidates, promote to MEMORY.md, write diary
    const deep = this.runDeep(options);

    return {
      ...deep,
      themes: rem.themes,
      reflectionPrompt: rem.reflectionPrompt,
    };
  }

  /**
   * Get dreaming status summary.
   */
  status(): {
    recallEntries: number;
    phaseSignals: number;
    dreamsFileExists: boolean;
    lastDream: string | null;
  } {
    const entries = this.loadRecallState();
    const signals = this.loadPhaseSignals();
    const dreamsPath = path.join(this.pluginRoot, "DREAMS.md");
    const dreamsExists = fs.existsSync(dreamsPath);

    let lastDream: string | null = null;
    if (dreamsExists) {
      try {
        const content = fs.readFileSync(dreamsPath, "utf-8");
        const match = content.match(/## Deep Sleep — (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/g);
        if (match) lastDream = match[match.length - 1].replace("## Deep Sleep — ", "");
      } catch {}
    }

    return {
      recallEntries: Object.keys(entries).length,
      phaseSignals: Object.keys(signals).length,
      dreamsFileExists: dreamsExists,
      lastDream,
    };
  }
}
