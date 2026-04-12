# Active Memory — `memory_context`

`memory_context` is a thin layer on top of the memory search system that the agent calls at the **start of every substantive turn**. Given the user's message, it derives complementary queries, hits the existing search backend (QMD or builtin), dedupes across the queries, applies a recency boost, and returns a pre-formatted markdown digest ready to drop into context.

It does not replace `memory_search` — it decides when and how to call it automatically, so the agent doesn't forget to check memory.

## When the agent should call it

- **Yes:** any user message that could benefit from prior context (questions, statements about people, places, tasks, decisions).
- **No, the tool skips itself:** slash commands (`/status`, `/help`, `/agent:*`), greetings (`hola`, `thanks`), acknowledgements, messages shorter than 3 words without a `?`.

Calling defensively is safe — on a trivial message the tool returns in O(ms) with `applicable: false` and a neutral digest.

## Relationship to backends

`memory_context` is a wrapper. It calls the same `searchMemory` path that `memory_search` uses:

| Backend | Behavior |
|---|---|
| `memory.backend: "builtin"` (FTS5 + BM25) | Keyword derivation pays off — the 2–3 derived queries compensate for the lack of semantics |
| `memory.backend: "qmd"` (semantic) | Semantic match handles most of the lift; derived queries add marginal recall from different angles |

Either backend works out of the box. No separate config is needed — `memory.backend` controls the search, `memoryContext` only tunes the wrapper.

## Query derivation

From a single input message, up to three queries are produced:

1. **Original** — the message trimmed to 500 chars
2. **Keywords** — top 5 keywords after stop-word filtering (EN + ES), joined by space. Only added if distinct from the original.
3. **Persona** — proper nouns / names detected in the message, joined by space. Only added if any were found.

Example: `"¿le gusta el jengibre a JC?"` →
- Original: `¿le gusta el jengibre a JC?`
- Keywords: `gusta jengibre`
- Persona: `JC`

## Scoring

For each chunk returned across queries:

1. `score` starts as the max per-query score (avoids double-counting overlap)
2. If `includeRecency: true` (default), multiply by a 30-day-half-life recency factor — only for dated paths like `memory/2026-04-09.md`. Non-dated files (`MEMORY.md`) are left as-is.
3. If a chunk matched ≥2 derived queries, multiply by 1.15 — weak signal of relevance
4. Sort, cap at `maxResults`

The recency boost is additive with any existing builtin temporal decay — the backend has already down-weighted old chunks; this adds a small tiebreaker when multiple chunks are close.

## Config

```json
{
  "memoryContext": {
    "enabled": true,
    "maxResults": 4,
    "includeRecency": true,
    "halfLifeDays": 30
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master off-switch. When `false`, the MCP tool short-circuits with a message. |
| `maxResults` | `4` | Max chunks in the digest. Keep small to save context budget. |
| `includeRecency` | `true` | Apply the 30-day half-life multiplier. |
| `halfLifeDays` | `30` | Override the half-life. |

## MCP tool

| Tool | Purpose |
|---|---|
| `memory_context({ message, format? })` | Returns a markdown digest (default) or JSON with entries + queries ran |

JSON format is useful for tests and for tools that want to render their own UI.

## Digest format

```
## Relevant prior context

- [memory/2026-04-09.md#L3-L5] JC's dog Cookie loves carrots
- [MEMORY.md#L22-L24] Color preference: blue
```

When nothing meaningful is found, the digest is just `(No relevant prior context for this message.)` — safe to ignore.

## When to prefer `memory_search` directly

The active-memory reflex is designed for catch-all recall. Use `memory_search` directly when:

- You know the exact query (`"what did JC order on the 5th"`)
- You want many results past the digest cap
- You're doing targeted retrieval for a tool's internal use, not agent context

## Implementation

| File | Role |
|---|---|
| `lib/memory-context.ts` | `getMemoryContext`, `deriveQueries`, `formatDigest`, applicability heuristics |
| `lib/config.ts` | `memoryContext` config section |
| `server.ts` | `memory_context` MCP tool |
| `templates/CLAUDE.md` | Turn-start reflex instruction |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every turn returns "No relevant prior context" even when there's memory | Memory index not built yet | Run `memory_search` once (or `/agent:doctor`) to trigger indexing |
| Digest is missing a chunk you expected | Chunk didn't reach the top-4 after recency boost | Lower `maxResults` skew — or call `memory_search` directly with a precise query |
| Tool runs but backend error | QMD unavailable and builtin init failed | `/agent:doctor` should surface SQLite issues; delete `memory/.memory.sqlite` to rebuild |
| Recency boost penalizes a timeless fact in `memory/2026-01-01.md` | Old dated file with still-relevant content | Move it to `MEMORY.md` (not date-keyed) so the recency multiplier doesn't apply |
