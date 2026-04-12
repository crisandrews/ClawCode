/**
 * Active Memory — `memory_context` helper.
 *
 * Given the current user message, derive 1–3 complementary queries, run them
 * through the existing search backend (QMD or builtin via the injected
 * `searchFn`), dedupe across queries, apply a small recency boost, and return
 * a pre-formatted digest the agent can drop into its response context.
 *
 * This is a THIN layer over `searchMemory`. It does not reimplement search —
 * it decides when and how to call it, and formats the output. Works unchanged
 * whether the backend is QMD (semantic) or builtin (BM25).
 */

import { extractKeywords, expandBilingual, expandDateWords } from "./keywords.ts";
import { getDecayMultiplier } from "./temporal-decay.ts";
import type { SearchResult } from "./types.ts";

export interface MemoryContextOptions {
  enabled?: boolean;
  /** Max chunks in the final digest. Default: 4. */
  maxResults?: number;
  /** Apply recency multiplier to scores. Default: true. */
  includeRecency?: boolean;
  /** Half-life in days for recency. Default: 30. */
  halfLifeDays?: number;
  /** Cap on per-query search calls. Default: 6 per derived query. */
  perQueryResults?: number;
}

export interface MemoryContextEntry {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  citation: string;
  matchedQueries: string[];
}

export interface MemoryContextResult {
  /** Whether context is expected to be useful. False for greetings, slash commands, etc. */
  applicable: boolean;
  /** Whether we actually found anything worth returning. */
  found: boolean;
  /** Markdown digest — safe to inject verbatim. */
  digest: string;
  /** Structured entries (for tools that prefer JSON). */
  entries: MemoryContextEntry[];
  /** The queries we derived — surfaced for debugging and tests. */
  queriesRun: string[];
  /** Reason we returned early without searching (if any). */
  skippedReason?: string;
}

export type SearchFn = (query: string, maxResults?: number) => SearchResult[];

// ---------------------------------------------------------------------------
// Applicability heuristics
// ---------------------------------------------------------------------------

/** Messages we don't bother searching memory for — they're too short or trivial. */
const SKIP_PREFIXES = [
  "/help",
  "/status",
  "/usage",
  "/whoami",
  "/new",
  "/compact",
  "/clear",
  "/mcp",
  "/doctor",
  "/who",
  "/context",
  "/memory",
  "/agent:",
];

const SKIP_EXACT = new Set([
  "hola",
  "hello",
  "hi",
  "hey",
  "ok",
  "okay",
  "yes",
  "no",
  "sí",
  "si",
  "nope",
  "yep",
  "buenas",
  "buenos días",
  "buenas tardes",
  "buenas noches",
  "thanks",
  "gracias",
  "thx",
  "ty",
  "👍",
  "👋",
]);

function isTrivial(message: string): { skip: boolean; reason?: string } {
  const trimmed = message.trim();
  if (!trimmed) return { skip: true, reason: "empty message" };
  const lower = trimmed.toLowerCase();

  // Slash commands
  for (const p of SKIP_PREFIXES) {
    if (lower.startsWith(p)) {
      return { skip: true, reason: `slash command (${p})` };
    }
  }

  // Short greeting / ack
  if (SKIP_EXACT.has(lower)) {
    return { skip: true, reason: "greeting or ack" };
  }

  // Very short — less than 3 words and no question mark
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount < 3 && !trimmed.includes("?")) {
    return { skip: true, reason: `too short (${wordCount} words, no question)` };
  }

  return { skip: false };
}

// ---------------------------------------------------------------------------
// Query derivation
// ---------------------------------------------------------------------------

/** Extract capitalized words that look like proper nouns (names, places). */
function extractProperNouns(message: string): string[] {
  const tokens = message.split(/\s+/);
  const proper: string[] = [];
  for (const raw of tokens) {
    // Strip leading/trailing punctuation
    const t = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t) continue;
    // Skip all-uppercase tokens that are short (like "OK") unless likely an initial like "JC"
    // Accept: starts with uppercase letter, has at least one lowercase OR is all-uppercase 2–5 letters
    const allUpper = t === t.toUpperCase();
    const startsUpper = /^\p{Lu}/u.test(t);
    if (!startsUpper) continue;
    if (allUpper && (t.length < 2 || t.length > 5)) continue;
    // Skip sentence-start artifacts: pronouns, articles, question words, verbs
    const lower = t.toLowerCase();
    if ([
      "i", "el", "la", "los", "las", "un", "una",
      // Spanish question words (often sentence-initial and capitalized)
      "cómo", "como", "cuándo", "cuando", "cuál", "cual", "dónde", "donde",
      "qué", "que", "quién", "quien", "por",
      // Common sentence-initial verbs
      "sugiere", "dime", "recuérdame", "cuéntame", "dame", "muestra",
      "what", "when", "where", "how", "why", "which", "who",
      "tell", "show", "give", "find", "get", "make", "let",
    ].includes(lower)) continue;
    proper.push(t);
  }
  return [...new Set(proper)];
}

export interface DerivedQueries {
  original: string;
  keywords?: string;
  persona?: string;
  /** Bilingual-expanded keyword query (if expansion added new terms). */
  bilingual?: string;
  /** Date-resolved query (when user says "hoy", "ayer", etc.). */
  dateQuery?: string;
  all: string[];
}

export function deriveQueries(message: string, now?: Date): DerivedQueries {
  const original = message.trim().slice(0, 500);
  const keywords = extractKeywords(original).slice(0, 5);
  const keywordQuery = keywords.length >= 2 ? keywords.join(" ") : undefined;
  const propers = extractProperNouns(original);
  const personaQuery = propers.length > 0 ? propers.join(" ") : undefined;

  // --- Bilingual expansion ---
  const expanded = expandBilingual(keywords);
  // Only emit a bilingual query if expansion actually added new terms
  const newTerms = expanded.filter((w) => !keywords.includes(w));
  const bilingualQuery =
    newTerms.length > 0
      ? [...keywords, ...newTerms].slice(0, 8).join(" ")
      : undefined;

  // --- Date-word expansion ---
  const dates = expandDateWords(original, now);
  const dateQuery = dates.length > 0 ? dates.join(" ") : undefined;

  const all: string[] = [original];
  if (keywordQuery && keywordQuery !== original.toLowerCase()) {
    all.push(keywordQuery);
  }
  if (bilingualQuery && !all.includes(bilingualQuery)) {
    all.push(bilingualQuery);
  }
  if (personaQuery && !all.includes(personaQuery)) {
    all.push(personaQuery);
  }
  if (dateQuery && !all.includes(dateQuery)) {
    all.push(dateQuery);
  }

  return {
    original,
    keywords: keywordQuery,
    persona: personaQuery,
    bilingual: bilingualQuery,
    dateQuery,
    all,
  };
}

// ---------------------------------------------------------------------------
// Recency helper
// ---------------------------------------------------------------------------

/** Extract YYYY-MM-DD from a path like `memory/2026-04-09.md`. Returns null if none. */
function pathDate(p: string): string | null {
  const m = p.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function recencyBoost(filePath: string, halfLifeDays: number): number {
  return getDecayMultiplier(filePath, new Date(), halfLifeDays);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function getMemoryContext(
  message: string,
  searchFn: SearchFn,
  opts: MemoryContextOptions = {}
): MemoryContextResult {
  const maxResults = Math.max(1, opts.maxResults ?? 4);
  const perQuery = Math.max(2, opts.perQueryResults ?? 6);
  const includeRecency = opts.includeRecency !== false;
  const halfLifeDays = opts.halfLifeDays ?? 30;

  // Applicability
  const triv = isTrivial(message);
  if (triv.skip) {
    return {
      applicable: false,
      found: false,
      digest: "(No relevant prior context for this message.)",
      entries: [],
      queriesRun: [],
      skippedReason: triv.reason,
    };
  }

  // Derive queries
  const derived = deriveQueries(message);

  // Run each query, tracking which queries matched each chunk
  const merged = new Map<string, MemoryContextEntry>();
  for (const q of derived.all) {
    let results: SearchResult[] = [];
    try {
      results = searchFn(q, perQuery) || [];
    } catch {
      continue;
    }
    for (const r of results) {
      const key = `${r.path}:${r.startLine}-${r.endLine}`;
      const existing = merged.get(key);
      if (existing) {
        existing.score = Math.max(existing.score, r.score);
        if (!existing.matchedQueries.includes(q)) {
          existing.matchedQueries.push(q);
        }
      } else {
        merged.set(key, {
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          snippet: r.snippet,
          score: r.score,
          citation: r.citation,
          matchedQueries: [q],
        });
      }
    }
  }

  // Compute final score = base * (recency boost if enabled) * matchedQuery bonus
  for (const entry of merged.values()) {
    let score = entry.score;
    if (includeRecency) {
      score *= recencyBoost(entry.path, halfLifeDays);
    }
    // Progressive boost for chunks matched by multiple derived queries.
    // Multiplier = 1 + 0.20 * (extraMatches)^1.5
    // 1 query  → 1.00 (no boost)
    // 2 queries → 1.20
    // 3 queries → 1.57
    // 4 queries → 1.60 + ...
    // This rewards breadth: a chunk that satisfies multiple angles of
    // the user's intent is more likely to be genuinely relevant.
    const extraMatches = entry.matchedQueries.length - 1;
    if (extraMatches > 0) {
      score *= 1 + 0.20 * Math.pow(extraMatches, 1.5);
    }
    entry.score = score;
  }

  const sorted = [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return {
    applicable: true,
    found: sorted.length > 0,
    digest: formatDigest(sorted),
    entries: sorted,
    queriesRun: derived.all,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDigest(entries: MemoryContextEntry[]): string {
  if (entries.length === 0) {
    return "(No relevant prior context for this message.)";
  }
  const lines: string[] = ["## Relevant prior context", ""];
  for (const e of entries) {
    const snippet = trimSnippet(e.snippet, 220);
    lines.push(`- [${e.citation}] ${snippet}`);
  }
  return lines.join("\n");
}

function trimSnippet(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1).trimEnd() + "…";
}
