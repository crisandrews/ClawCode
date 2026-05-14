export interface ChunkRecord {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

export interface FileRecord {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  citation: string;
  /**
   * Phase 2 — passive provenance metadata. Populated when chunks have
   * source_channel/source_chat_id columns; null/undefined otherwise.
   * Not read by any caller in Phase 2. Phase 4a-1 wires enforcement.
   */
  provenance?: import("./scope/provenance.ts").ChunkProvenance | null;
  /**
   * Phase 2 — opaque scope token bound to this result's provenance.
   * Validated by voice / inbox surfaces in Phase 4a-2.
   */
  scopeToken?: string;
}

export interface RecallEntry {
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
