/**
 * Keyword extraction — mirrors OpenClaw's query-expansion.ts
 *
 * Extracts meaningful keywords from a query, filtering stop words
 * in English and Spanish. Used for FTS5 queries.
 *
 * Also provides bilingual synonym expansion (ES↔EN) and date-word
 * resolution ("hoy" → today's YYYY-MM-DD) for cross-language recall.
 */

const STOP_WORDS = new Set([
  // English
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "about", "what",
  "which", "who", "whom", "this", "that", "these", "those", "i", "me",
  "my", "we", "our", "you", "your", "he", "him", "his", "she", "her",
  "it", "its", "they", "them", "their",
  // Spanish
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del",
  "en", "con", "por", "para", "es", "son", "fue", "ser", "estar",
  "hay", "que", "se", "su", "al", "lo", "como", "más", "pero", "sus",
  "le", "ya", "o", "este", "si", "porque", "esta", "entre", "cuando",
  "muy", "sin", "sobre", "también", "me", "mi", "hasta", "donde",
  "dónde", "quien", "cómo", "cuándo", "cuál", "qué",
  "desde", "todo", "nos", "durante", "uno", "ni", "contra", "otros",
  "sugiere", "dime", "recuérdame", "cuéntame",
]);

// ---------------------------------------------------------------------------
// Bilingual synonym map (ES ↔ EN) — bidirectional
// Each pair maps in both directions.  Keep sorted by Spanish term.
// ---------------------------------------------------------------------------

const SYNONYM_PAIRS: [string, string][] = [
  // Animals / pets
  ["perro", "dog"],
  ["perra", "dog"],
  ["gato", "cat"],
  ["mascota", "pet"],
  // Food / health
  ["almuerzo", "lunch"],
  ["almorzar", "lunch"],
  ["almorcé", "lunch"],
  ["cena", "dinner"],
  ["desayuno", "breakfast"],
  ["comida", "food"],
  ["camarón", "shrimp"],
  ["camarones", "shrimp"],
  ["mariscos", "seafood"],
  ["marisco", "seafood"],
  ["alergia", "allergy"],
  ["alérgico", "allergic"],
  ["alergico", "allergic"],
  // People / events
  ["cumpleaños", "birthday"],
  ["nombre", "name"],
  ["llamar", "name"],
  ["llama", "name"],
  // Time
  ["ayer", "yesterday"],
  ["mañana", "tomorrow"],
  ["semana", "week"],
  ["mes", "month"],
  ["año", "year"],
  // Common project terms
  ["proyecto", "project"],
  ["reunión", "meeting"],
  ["reunion", "meeting"],
  ["tarea", "task"],
  ["pendiente", "pending"],
  ["pendientes", "pending"],
  ["nota", "note"],
  ["notas", "notes"],
  ["favorito", "favorite"],
  ["favorita", "favorite"],
  // Seafood specifics (for allergy safety)
  ["mariscos", "shrimp"],
  ["langosta", "lobster"],
  ["cangrejo", "crab"],
  ["pescado", "fish"],
];

/** Fast lookup: word → set of synonyms (other language). */
const SYNONYM_MAP = new Map<string, Set<string>>();

for (const [a, b] of SYNONYM_PAIRS) {
  if (!SYNONYM_MAP.has(a)) SYNONYM_MAP.set(a, new Set());
  SYNONYM_MAP.get(a)!.add(b);
  if (!SYNONYM_MAP.has(b)) SYNONYM_MAP.set(b, new Set());
  SYNONYM_MAP.get(b)!.add(a);
}

/**
 * Return cross-language synonyms for a keyword.
 * Returns an empty array if no synonyms exist.
 */
export function getSynonyms(word: string): string[] {
  const lower = word.toLowerCase();
  const syns = SYNONYM_MAP.get(lower);
  return syns ? [...syns] : [];
}

/**
 * Expand a list of keywords with their bilingual synonyms.
 * Returns the original keywords PLUS any cross-language synonyms, deduped.
 */
export function expandBilingual(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    for (const syn of getSynonyms(kw)) {
      expanded.add(syn);
    }
  }
  return [...expanded];
}

// ---------------------------------------------------------------------------
// Date-word expansion ("hoy" → YYYY-MM-DD, "ayer" → YYYY-MM-DD)
// ---------------------------------------------------------------------------

const DATE_WORDS: Record<string, (now: Date) => string> = {
  hoy: (now) => fmtDate(now),
  today: (now) => fmtDate(now),
  ayer: (now) => fmtDate(addDays(now, -1)),
  yesterday: (now) => fmtDate(addDays(now, -1)),
  anteayer: (now) => fmtDate(addDays(now, -2)),
};

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * If the message contains temporal words like "hoy"/"today"/"ayer", return
 * the corresponding YYYY-MM-DD strings. Useful for searching daily logs.
 */
export function expandDateWords(message: string, now?: Date): string[] {
  const ref = now ?? new Date();
  const lower = message.toLowerCase();
  const tokens = lower.split(/[^\p{L}\p{N}]+/u);
  const dates: string[] = [];
  for (const tok of tokens) {
    const fn = DATE_WORDS[tok];
    if (fn) dates.push(fn(ref));
  }
  return [...new Set(dates)];
}

/**
 * Extract keywords from a query string.
 * Filters stop words and short tokens.
 */
export function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Build an FTS5 query from keywords.
 * Returns: '"word1" OR "word2"' or null if no keywords.
 * Uses OR to allow partial matches — BM25 still ranks by relevance.
 *
 * NOTE: Changed from AND to OR to improve recall. With AND, a query like
 * "perro dog" would require BOTH words in the same chunk. With OR, either
 * word is sufficient, and BM25 naturally ranks chunks with more matches higher.
 */
export function buildFtsQuery(query: string): string | null {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return null;
  // Use OR for better recall; BM25 scoring still ranks multi-match higher
  return keywords.map((k) => `"${k}"`).join(" OR ");
}
