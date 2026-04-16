# AutoResearch — Knowledge Gap Detection & Active Learning

Inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch), this feature extends the dreaming system with an active research loop that fills knowledge gaps detected during daily use.

## How it works

```
 Day (passive)                          Night (active)
 ─────────────                          ──────────────
 memory_search("X")                     Dream cycle starts
     ↓                                      ↓
 0 results / low score                  REM phase reads gaps
     ↓                                      ↓
 GapTracker records                     ResearchEngine.runResearchLoop()
 knowledge-gaps.json                        ├── broader keyword search
                                            ├── partial-match search
                                            └── cross-reference memory
                                                ↓
                                        Confidence scoring
                                            ├── ≥ 0.7 → KEEP → Deep phase candidate
                                            └── < 0.7 → DISCARD → logged in DREAMS.md
```

## Gap detection

Every `memory_search` call goes through `trackRecall()`, which now also calls `gapTracker.recordGap()`. A gap is classified when:

| Result | Classification |
|---|---|
| 0 results | `no_results` |
| maxScore < 0.3 | `low_confidence` |
| ≤2 results, maxScore < 0.5 | `partial_match` |
| Otherwise | Not a gap |

Duplicate queries increment `occurrences` — frequently-asked gaps are researched first.

## Storage

`memory/.dreams/knowledge-gaps.json` — array of `KnowledgeGap` objects:

```json
[
  {
    "query": "navitaire change flight endpoint",
    "timestamp": "2026-04-15T...",
    "resultCount": 0,
    "maxScore": 0,
    "gapType": "no_results",
    "occurrences": 3,
    "firstSeen": "2026-04-13T...",
    "lastSeen": "2026-04-15T..."
  }
]
```

## Research loop (REM phase)

During `dream(action='run')`, if `dreaming.autoresearch.enabled` is true:

1. Load top N gaps (sorted by occurrences).
2. For each gap:
   - **Broader search**: split query into keywords, search each individually.
   - **Partial match**: search first half of the query string.
   - **Deduplicate** sources by path + snippet prefix.
3. Compute confidence: `avgScore * 0.5 + sourceCount * 0.3 + typeDiversity * 0.2`.
4. If confidence ≥ threshold → **keep** (remove from gaps, promote to Deep phase).
5. If below → **discard** (log reason in DREAMS.md).

## DREAMS.md output

```markdown
## REM Research — 2026-04-15 03:00

### Investigated 3 knowledge gaps

1. ✅ "navitaire change flight endpoint" (confidence: 0.89)
   - Sources: memory (memory/2026-04-10.md)
   - Learned: POST /api/nsk/v4/booking/flights with {journeyKey, fareKey}
   - Validation: single-source

2. ❌ "ancillary pricing connections" (confidence: 0.45) — DISCARDED
   - Reason: below confidence threshold
```

## MCP tools

- `knowledge_gaps(action='list')` — view current gaps, sorted by frequency.
- `knowledge_gaps(action='add', query='...')` — manually register a gap.
- `dream(action='run')` — triggers the full sweep including autoresearch.

## Configuration

```json
{
  "dreaming": {
    "autoresearch": {
      "enabled": false,
      "maxGapsPerNight": 5,
      "confidenceThreshold": 0.6,
      "sources": ["codebase", "memory"],
      "maxResearchTimeMinutes": 10
    }
  }
}
```

## Safety

- **Read-only** — research never modifies code or external systems.
- **Confidence gating** — only verified knowledge passes the threshold.
- **Time budget** — capped at `maxResearchTimeMinutes` per cycle.
- **Opt-in** — disabled by default.
- **Transparent** — every investigation is logged in DREAMS.md.

## References

- [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
- [Issue #2](https://github.com/crisandrews/ClawCode/issues/2)
- `lib/autoresearch.ts` — engine code
- `lib/dreaming.ts` — existing dreaming system
