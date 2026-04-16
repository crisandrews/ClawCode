/**
 * AutoResearch — knowledge gap detection and research-loop engine.
 *
 * Inspired by Karpathy's autoresearch pattern (propose → test → keep/discard),
 * adapted for knowledge consolidation during the dreaming REM phase.
 *
 * Gap detection runs passively during the day: every memory_search that returns
 * zero or low-quality results is logged to memory/.dreams/knowledge-gaps.json.
 *
 * During REM, the research loop iterates over gaps and attempts to fill them
 * using available sources (codebase search, existing memory, optionally web).
 * Findings are validated with a confidence score and only promoted if they pass
 * the threshold.
 *
 * This module is deterministic except for the optional LLM synthesis step
 * (which is deferred to the caller — the MCP tool handler in server.ts).
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeGap {
  query: string;
  timestamp: string;
  resultCount: number;
  maxScore: number;
  gapType: "no_results" | "low_confidence" | "partial_match";
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ResearchSource {
  type: "codebase" | "memory" | "web";
  path?: string;
  snippet: string;
  score: number;
}

export interface ResearchCandidate {
  query: string;
  sources: ResearchSource[];
  snippet: string;
  confidenceScore: number;
  validationMethod:
    | "code-crossref"
    | "web-confirm"
    | "multi-source"
    | "single-source";
  kept: boolean;
  discardReason?: string;
}

export interface AutoResearchConfig {
  enabled: boolean;
  maxGapsPerNight: number;
  confidenceThreshold: number;
  sources: Array<"codebase" | "memory" | "web">;
  maxResearchTimeMinutes: number;
}

export interface AutoResearchResult {
  gapsInvestigated: number;
  kept: ResearchCandidate[];
  discarded: ResearchCandidate[];
  dreamsMarkdown: string;
}

const DEFAULT_AUTORESEARCH_CONFIG: AutoResearchConfig = {
  enabled: false,
  maxGapsPerNight: 5,
  confidenceThreshold: 0.7,
  sources: ["codebase", "memory"],
  maxResearchTimeMinutes: 10,
};

// ---------------------------------------------------------------------------
// Gap tracker — called from trackRecall in server.ts
// ---------------------------------------------------------------------------

export class GapTracker {
  private gapsFile: string;

  constructor(dreamsDir: string) {
    this.gapsFile = path.join(dreamsDir, "knowledge-gaps.json");
  }

  /**
   * Record a gap when a memory search returns poor results.
   * Called from trackRecall after every memory_search.
   */
  recordGap(
    query: string,
    resultCount: number,
    maxScore: number
  ): KnowledgeGap | null {
    const gapType = this.classifyGap(resultCount, maxScore);
    if (!gapType) return null;

    const gaps = this.loadGaps();
    const existing = gaps.find(
      (g) => g.query.toLowerCase() === query.toLowerCase()
    );
    const now = new Date().toISOString();

    if (existing) {
      existing.occurrences++;
      existing.lastSeen = now;
      existing.resultCount = resultCount;
      existing.maxScore = maxScore;
      existing.gapType = gapType;
    } else {
      gaps.push({
        query,
        timestamp: now,
        resultCount,
        maxScore,
        gapType,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }

    this.saveGaps(gaps);
    return existing || gaps[gaps.length - 1];
  }

  loadGaps(): KnowledgeGap[] {
    try {
      return JSON.parse(fs.readFileSync(this.gapsFile, "utf-8"));
    } catch {
      return [];
    }
  }

  /**
   * Return gaps sorted by frequency (most-queried first), capped at `limit`.
   */
  topGaps(limit: number): KnowledgeGap[] {
    return this.loadGaps()
      .sort((a, b) => b.occurrences - a.occurrences)
      .slice(0, limit);
  }

  /**
   * Remove a gap after it has been researched and kept.
   */
  removeGap(query: string): void {
    const gaps = this.loadGaps().filter(
      (g) => g.query.toLowerCase() !== query.toLowerCase()
    );
    this.saveGaps(gaps);
  }

  private classifyGap(
    resultCount: number,
    maxScore: number
  ): KnowledgeGap["gapType"] | null {
    if (resultCount === 0) return "no_results";
    if (maxScore < 0.3) return "low_confidence";
    if (resultCount <= 2 && maxScore < 0.5) return "partial_match";
    return null;
  }

  private saveGaps(gaps: KnowledgeGap[]): void {
    fs.mkdirSync(path.dirname(this.gapsFile), { recursive: true });
    fs.writeFileSync(this.gapsFile, JSON.stringify(gaps, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Research engine — runs during REM phase
// ---------------------------------------------------------------------------

export type SearchFn = (
  query: string,
  maxResults?: number
) => Array<{ path: string; snippet: string; score: number }>;

export class ResearchEngine {
  private workspace: string;
  private dreamsDir: string;
  private config: AutoResearchConfig;
  private gapTracker: GapTracker;

  constructor(
    workspace: string,
    config?: Partial<AutoResearchConfig>
  ) {
    this.workspace = workspace;
    this.dreamsDir = path.join(workspace, "memory", ".dreams");
    this.config = { ...DEFAULT_AUTORESEARCH_CONFIG, ...config };
    this.gapTracker = new GapTracker(this.dreamsDir);
  }

  /**
   * Run the research loop over top gaps. Uses `searchFn` (the existing
   * memory_search backend) as the primary codebase/memory source.
   *
   * Returns candidates with confidence scores. Promotion to MEMORY.md is
   * handled by the caller (dreaming Deep phase).
   */
  runResearchLoop(searchFn: SearchFn): AutoResearchResult {
    const gaps = this.gapTracker.topGaps(this.config.maxGapsPerNight);
    const kept: ResearchCandidate[] = [];
    const discarded: ResearchCandidate[] = [];
    const startTime = Date.now();
    const maxMs = this.config.maxResearchTimeMinutes * 60_000;

    for (const gap of gaps) {
      if (Date.now() - startTime > maxMs) break;

      const candidate = this.investigateGap(gap, searchFn);
      if (candidate.kept) {
        kept.push(candidate);
        this.gapTracker.removeGap(gap.query);
      } else {
        discarded.push(candidate);
      }
    }

    const dreamsMarkdown = this.formatDreamsBlock(kept, discarded);
    this.appendToDreams(dreamsMarkdown);

    return {
      gapsInvestigated: gaps.length,
      kept,
      discarded,
      dreamsMarkdown,
    };
  }

  private investigateGap(
    gap: KnowledgeGap,
    searchFn: SearchFn
  ): ResearchCandidate {
    const sources: ResearchSource[] = [];

    // Strategy 1: broader search with individual keywords
    const keywords = gap.query
      .split(/\s+/)
      .filter((w) => w.length > 2);
    for (const kw of keywords.slice(0, 3)) {
      try {
        const results = searchFn(kw, 3);
        for (const r of results) {
          if (r.score > 0.2) {
            sources.push({
              type: "memory",
              path: r.path,
              snippet: r.snippet.slice(0, 300),
              score: r.score,
            });
          }
        }
      } catch {}
    }

    // Strategy 2: partial-match search with substrings
    if (sources.length === 0 && gap.query.length > 10) {
      const half = gap.query.slice(0, Math.ceil(gap.query.length / 2));
      try {
        const results = searchFn(half, 3);
        for (const r of results) {
          sources.push({
            type: "memory",
            path: r.path,
            snippet: r.snippet.slice(0, 300),
            score: r.score,
          });
        }
      } catch {}
    }

    // Deduplicate sources by path
    const uniqueSources = this.deduplicateSources(sources);

    // Compute confidence
    const confidence = this.computeConfidence(uniqueSources);
    const validationMethod = this.classifyValidation(uniqueSources);
    const kept = confidence >= this.config.confidenceThreshold;

    // Synthesize snippet from best sources
    const snippet = uniqueSources.length > 0
      ? uniqueSources
          .sort((a, b) => b.score - a.score)
          .slice(0, 2)
          .map((s) => s.snippet)
          .join(" | ")
          .slice(0, 500)
      : "";

    return {
      query: gap.query,
      sources: uniqueSources,
      snippet,
      confidenceScore: confidence,
      validationMethod,
      kept,
      discardReason: kept
        ? undefined
        : confidence === 0
          ? "no sources found"
          : "below confidence threshold",
    };
  }

  private deduplicateSources(sources: ResearchSource[]): ResearchSource[] {
    const seen = new Set<string>();
    return sources.filter((s) => {
      const key = `${s.type}:${s.path || ""}:${s.snippet.slice(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private computeConfidence(sources: ResearchSource[]): number {
    if (sources.length === 0) return 0;

    const avgScore =
      sources.reduce((sum, s) => sum + s.score, 0) / sources.length;
    const sourceCount = Math.min(sources.length / 3, 1.0);
    const typeCount =
      new Set(sources.map((s) => s.type)).size / 3;

    // Weighted: avg relevance 50%, source count 30%, source diversity 20%
    return Math.min(
      avgScore * 0.5 + sourceCount * 0.3 + typeCount * 0.2,
      1.0
    );
  }

  private classifyValidation(
    sources: ResearchSource[]
  ): ResearchCandidate["validationMethod"] {
    const types = new Set(sources.map((s) => s.type));
    if (types.size >= 2) return "multi-source";
    if (types.has("codebase")) return "code-crossref";
    if (types.has("web")) return "web-confirm";
    return "single-source";
  }

  private formatDreamsBlock(
    kept: ResearchCandidate[],
    discarded: ResearchCandidate[]
  ): string {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    const total = kept.length + discarded.length;
    if (total === 0) return "";

    const lines: string[] = [
      "",
      `## REM Research — ${now}`,
      "",
      `### Investigated ${total} knowledge gap${total !== 1 ? "s" : ""}`,
      "",
    ];

    let idx = 1;
    for (const c of kept) {
      const srcSummary = c.sources
        .map((s) => `${s.type}${s.path ? ` (${s.path})` : ""}`)
        .join(", ");
      lines.push(
        `${idx}. ✅ "${c.query}" (confidence: ${c.confidenceScore.toFixed(2)})`
      );
      lines.push(`   - Sources: ${srcSummary}`);
      lines.push(`   - Learned: ${c.snippet.slice(0, 200)}`);
      lines.push(`   - Validation: ${c.validationMethod}`);
      lines.push("");
      idx++;
    }

    for (const c of discarded) {
      lines.push(
        `${idx}. ❌ "${c.query}" (confidence: ${c.confidenceScore.toFixed(2)}) — DISCARDED`
      );
      lines.push(`   - Reason: ${c.discardReason}`);
      lines.push("");
      idx++;
    }

    return lines.join("\n");
  }

  private appendToDreams(markdown: string): void {
    if (!markdown) return;
    const dreamsPath = path.join(this.workspace, "DREAMS.md");
    try {
      if (fs.existsSync(dreamsPath)) {
        fs.appendFileSync(dreamsPath, markdown);
      } else {
        fs.writeFileSync(
          dreamsPath,
          `# Dreams\n\n*Memory consolidation diary.*\n${markdown}`
        );
      }
    } catch {}
  }

  getConfig(): AutoResearchConfig {
    return { ...this.config };
  }
}

export function mergeAutoResearchConfig(
  partial?: Partial<AutoResearchConfig>
): AutoResearchConfig {
  return { ...DEFAULT_AUTORESEARCH_CONFIG, ...partial };
}
