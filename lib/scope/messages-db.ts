/**
 * Phase 4a-2.6 — read-only consumer of `claude-whatsapp/messages.db`.
 *
 * Upstream owns the writer side (per `db.ts` in the claude-whatsapp
 * project): WAL journal, schema below, file mode `0o600`. We open the
 * same file READ-ONLY so concurrent inserts from the live WhatsApp
 * process are not blocked. Never write, never checkpoint, never set
 * pragmas that mutate state.
 *
 *   schema (relevant subset):
 *     messages(rowid INTEGER PRIMARY KEY, id TEXT, chat_id TEXT,
 *              sender_id TEXT NULL, push_name TEXT NULL, ts INTEGER,
 *              direction TEXT IN ('in','out'), text TEXT,
 *              meta TEXT NULL, raw_message TEXT NULL)
 *
 * The reader is the foundation of the synthetic per-chat indexer
 * (`indexer.ts`, written next). It exists so OpenCLAUDE's existing
 * scope filter can answer "does chunk X belong to chat Y" without
 * relying on the daily transcript files (which mix all chats per day
 * and would leak content across chats — see Codex 4a-2.6 pre-impl
 * review F1).
 *
 * Failure modes are deliberate:
 *   - DB missing  → `null` (caller treats as "no extras to enrich")
 *   - DB corrupt  → `null` (same; doctor surfaces a separate signal)
 *   - DB busy     → single retry with 50 ms backoff, then `null`
 *   - schema drift → `null` if any required column is absent;
 *                    extra/unknown columns ignored (forward-compat)
 *
 * NEVER raises — every failure is a `null` return so the indexer
 * keeps running on the next cycle.
 */

import path from "node:path";

// `better-sqlite3` is loaded lazily so the module under test doesn't
// require the native binding when only the type surface is consumed.
type Database = any;
type Statement = any;
let DatabaseCtor: any = null;
async function loadCtor(): Promise<any> {
  if (DatabaseCtor) return DatabaseCtor;
  const mod = await import("better-sqlite3");
  DatabaseCtor = (mod as any).default ?? mod;
  return DatabaseCtor;
}

/**
 * The subset of upstream's `messages` table we actually consume.
 * Forward-compat: extra columns we don't list here are ignored.
 */
export interface MessagesDbRow {
  rowid: number;
  id: string;
  chat_id: string;
  sender_id: string | null;
  ts: number;
  direction: "in" | "out";
  text: string;
}

const REQUIRED_COLUMNS = [
  "rowid",
  "id",
  "chat_id",
  "ts",
  "direction",
  "text",
] as const;

export interface MessagesDbHandle {
  /**
   * Read rows with rowid > `afterRowid`, up to `limit`. Ordered by
   * rowid asc. Returns ONLY rows that pass validation (direction in
   * {in,out}, non-empty chat_id, valid ts).
   */
  readBatch(afterRowid: number, limit: number): MessagesDbRow[];
  /**
   * Phase 4a-2.6 v10 (Codex 10th-pass HIGH F3): like `readBatch` but
   * also surfaces the max raw rowid scanned by the underlying SELECT
   * BEFORE row-level validation. Without this, an indexer batch that
   * happens to consist entirely of invalid rows looks empty to the
   * caller and the cursor never advances past those rows — permanent
   * starvation of every later valid row.
   */
  readBatchWithMaxRowid(
    afterRowid: number,
    limit: number
  ): { rows: MessagesDbRow[]; maxRawRowid: number };
  /**
   * Phase 4a-2.6 v9-11 — paginated per-pair query.
   *
   * v9 (Codex 9th-pass HIGH F1): read EVERY row in the
   * `(chat_id, [fromTsSec, toTsSec))` window regardless of rowid.
   *
   * v10 (Codex 10th-pass HIGH F1): added rowid pagination so a
   * chat-day larger than `limit` could be drained.
   *
   * v11 (Codex 11th-pass HIGH F2 + F4): switched to `(ts, rowid)`
   * keyset cursor + `(ts ASC, rowid ASC)` ordering so the upstream
   * `idx_messages_chat_ts(chat_id, ts DESC)` index answers the query
   * without a temp B-tree sort. ALSO returns raw row count + last
   * raw cursor metadata so the caller can distinguish "page < limit
   * because some rows were dropped by validation" (don't EOF) from
   * "page < limit because we hit the actual end of the day".
   */
  readByChatAndTsRangeRaw(
    chat_id: string,
    fromTsSec: number,
    toTsSec: number,
    afterTs: number,
    afterRowid: number,
    limit: number
  ): {
    rows: MessagesDbRow[];
    /** Number of rows returned by SQL BEFORE row-level validation. */
    rawCount: number;
    /** Last raw row's `ts` (so the caller can advance keyset cursor
     *  even when every row failed validation). undefined when rawCount=0. */
    lastRawTs?: number;
    lastRawRowid?: number;
    /** True when the SQL prepare/execute itself errored. */
    error: boolean;
  };
  /** Cheap freshness probe — `PRAGMA data_version`. Same value = no change. */
  dataVersion(): number;
  /**
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F1: maximum rowid in the
   * `messages` table, or 0 when the table is empty / query errors.
   * Used to detect same-inode truncation (drop+recreate-table workflow)
   * where the file's `dev:ino` is preserved but `MAX(rowid)` regresses
   * past the indexer's stored cursor — without this probe the cursor
   * regression-rejection guard would refuse to walk back and the
   * indexer would silently skip every row of the truncated DB forever.
   *
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: reads the `id` of the
   * row at a specific rowid for cursor-row tampering detection.
   * Returns null when no row exists at that rowid. SQLite's
   * INTEGER PRIMARY KEY without AUTOINCREMENT reuses the deleted-max
   * rowid for the next INSERT, so we can't trust `WHERE rowid > cursor`
   * alone — we have to verify the row at `cursor` is still the same
   * row we last saw.
   */
  maxRowid(): number;
  rowIdAtRowid(rowid: number): string | null;
  close(): void;
}

/**
 * Phase 4a-2.6 v10 (Codex 10th-pass HIGH F2): bound `ts` at the END
 * of year 9999 UTC (`Date.UTC(9999, 11, 31, 23, 59, 59) / 1000` =
 * `253_402_300_799`). v9 used 8.64e12 which let the indexer accept ts
 * values whose `toISOString()` produces extended-year strings
 * (`+010000-...`); `unixSecondsRangeForIsoDate` then rejected the
 * resulting non-`YYYY-MM-DD` date and `rebuildPair` returned false,
 * holding the cursor forever for that pair. Lowering the cap to year
 * 9999 means every accepted ts produces a valid 4-digit-year date so
 * the round-trip succeeds.
 */
const MAX_VALID_TS_SEC = 253_402_300_799;
function isValidTsSec(ts: unknown): ts is number {
  return (
    typeof ts === "number" &&
    Number.isFinite(ts) &&
    Number.isInteger(ts) &&
    ts >= 0 &&
    ts <= MAX_VALID_TS_SEC
  );
}

/**
 * Open the messages.db located under the channel directory. Returns
 * `null` for any failure mode (missing, corrupt, busy after retry,
 * schema drift). Never throws.
 */
export async function openMessagesDb(
  channelDir: string
): Promise<MessagesDbHandle | null> {
  const dbPath = path.join(channelDir, "messages.db");
  let DbCtor: any;
  try {
    DbCtor = await loadCtor();
  } catch {
    return null;
  }

  let db: Database;
  try {
    db = new DbCtor(dbPath, {
      readonly: true,
      fileMustExist: true,
      // Wait briefly on busy lock; SQLITE_BUSY otherwise.
      timeout: 50,
    });
  } catch {
    // Missing file, lock contention beyond timeout, or unreadable.
    // Single retry with backoff.
    try {
      await new Promise((r) => setTimeout(r, 50));
      db = new DbCtor(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 50,
      });
    } catch {
      return null;
    }
  }

  // Defense in depth — better-sqlite3 already enforces this when the
  // ctor option is set, but make it explicit so a future flag flip
  // can't silently turn into a writer.
  try {
    if (!db.readonly) {
      db.close();
      return null;
    }
  } catch {
    return null;
  }

  // Validate schema — bail if any required column is absent. Unknown
  // extra columns are tolerated (forward-compat). Codex 11th-pass
  // MEDIUM F3: also require `rowid` to be the INTEGER PRIMARY KEY
  // (or the table's implicit rowid) so the indexer's keyset cursor
  // can rely on it being a safe integer.
  let cols: Array<{ name: string; type: string; pk: number }>;
  try {
    cols = db
      .prepare(`PRAGMA table_info(messages)`)
      .all() as Array<{ name: string; type: string; pk: number }>;
  } catch {
    db.close();
    return null;
  }
  const present = new Set(cols.map((c) => c.name));
  for (const r of REQUIRED_COLUMNS) {
    if (!present.has(r)) {
      db.close();
      return null;
    }
  }
  // If `rowid` appears explicitly in the column list (upstream's
  // schema declares `rowid INTEGER PRIMARY KEY`), it MUST be INTEGER.
  // If absent from `table_info` it's the implicit rowid which is
  // always an integer — that case is fine too.
  const rowidCol = cols.find((c) => c.name === "rowid");
  if (rowidCol && !/^integer$/i.test(rowidCol.type)) {
    db.close();
    return null;
  }

  // Prepare the statements once.
  let readStmt: Statement;
  let readByPairStmt: Statement;
  let versionStmt: Statement;
  try {
    readStmt = db.prepare(
      `SELECT rowid, id, chat_id, sender_id, ts, direction, text
       FROM messages
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`
    );
    // Phase 4a-2.6 v11 (Codex 11th-pass HIGH F4): keyset cursor on
    // `(ts, rowid)` matches the upstream index
    // `idx_messages_chat_ts(chat_id, ts DESC)` so SQLite uses the
    // index directly instead of building a temp B-tree to sort by
    // rowid. The cursor predicate `(ts > ? OR (ts = ? AND rowid > ?))`
    // walks rows strictly after the last seen `(ts, rowid)` pair.
    readByPairStmt = db.prepare(
      `SELECT rowid, id, chat_id, sender_id, ts, direction, text
       FROM messages
       WHERE chat_id = ? AND ts >= ? AND ts < ?
         AND (ts > ? OR (ts = ? AND rowid > ?))
       ORDER BY ts ASC, rowid ASC
       LIMIT ?`
    );
    versionStmt = db.prepare(`PRAGMA data_version`);
  } catch {
    db.close();
    return null;
  }

  /**
   * Apply row-level validation that's identical for every read path.
   * Rows that fail validation are dropped silently; the count of
   * dropped rows is not surfaced because every caller treats them as
   * "not present" anyway. Validation order matches the threat model:
   * direction, chat_id, ts (Codex 9th-pass HIGH F2), text.
   */
  function validateRows(
    rows: Array<Omit<MessagesDbRow, "direction"> & { direction: string }>
  ): MessagesDbRow[] {
    const out: MessagesDbRow[] = [];
    for (const r of rows) {
      if (r.direction !== "in" && r.direction !== "out") continue;
      if (!r.chat_id || typeof r.chat_id !== "string") continue;
      if (!isValidTsSec(r.ts)) continue;
      // Codex 11th-pass MEDIUM F3: rowid must be a safe integer too;
      // upstream's `INTEGER PRIMARY KEY` is checked at openMessagesDb,
      // but defense in depth catches type drift between the schema
      // probe and the actual row read (e.g. better-sqlite3 BigInt
      // mode flipping for very large values).
      if (
        typeof r.rowid !== "number" ||
        !Number.isFinite(r.rowid) ||
        !Number.isSafeInteger(r.rowid) ||
        r.rowid < 0
      ) {
        continue;
      }
      out.push({
        rowid: r.rowid,
        id: r.id,
        chat_id: r.chat_id,
        sender_id: r.sender_id ?? null,
        ts: r.ts,
        direction: r.direction,
        text: typeof r.text === "string" ? r.text : "",
      });
    }
    return out;
  }

  return {
    readBatch(afterRowid, limit) {
      try {
        const rows = readStmt.all(afterRowid, limit) as Array<
          Omit<MessagesDbRow, "direction"> & { direction: string }
        >;
        return validateRows(rows);
      } catch {
        return [];
      }
    },
    readBatchWithMaxRowid(afterRowid, limit) {
      try {
        const rows = readStmt.all(afterRowid, limit) as Array<
          Omit<MessagesDbRow, "direction"> & { direction: string }
        >;
        let maxRawRowid = afterRowid;
        // Phase 4a-2.6 v17 — Codex 17th-pass LOW F3: only consider safe
        // integer rowids when advancing the cursor. A hostile/corrupted
        // upstream can plant a rowid past MAX_SAFE_INTEGER (or worse,
        // Infinity if exposed via SQL functions); validateRows would
        // drop the row, but the cursor would still leap to that value
        // and skip every later valid lower rowid forever.
        for (const r of rows) {
          if (
            typeof r.rowid === "number" &&
            Number.isSafeInteger(r.rowid) &&
            r.rowid > maxRawRowid
          ) {
            maxRawRowid = r.rowid;
          }
        }
        return { rows: validateRows(rows), maxRawRowid };
      } catch {
        return { rows: [], maxRawRowid: afterRowid };
      }
    },
    readByChatAndTsRangeRaw(
      chat_id,
      fromTsSec,
      toTsSec,
      afterTs,
      afterRowid,
      limit
    ) {
      try {
        const raw = readByPairStmt.all(
          chat_id,
          fromTsSec,
          toTsSec,
          afterTs,
          afterTs,
          afterRowid,
          limit
        ) as Array<Omit<MessagesDbRow, "direction"> & { direction: string }>;
        const validated = validateRows(raw);
        // Codex 11th-pass HIGH F2: surface last RAW row's (ts, rowid)
        // so the caller can advance the keyset cursor across an
        // all-invalid page.
        let lastRawTs: number | undefined;
        let lastRawRowid: number | undefined;
        if (raw.length > 0) {
          const last = raw[raw.length - 1];
          if (typeof last.ts === "number") lastRawTs = last.ts;
          if (typeof last.rowid === "number") lastRawRowid = last.rowid;
        }
        return {
          rows: validated,
          rawCount: raw.length,
          lastRawTs,
          lastRawRowid,
          error: false,
        };
      } catch {
        return { rows: [], rawCount: 0, error: true };
      }
    },
    dataVersion() {
      try {
        const row = versionStmt.get() as { data_version: number };
        return row?.data_version ?? 0;
      } catch {
        return 0;
      }
    },
    maxRowid() {
      try {
        const row = db
          .prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM messages`)
          .get() as { m: number } | undefined;
        const m = row?.m ?? 0;
        // Defensive: an unsafe-int max rowid is hostile / overflow
        // territory — caller treats 0 as "no DB to compare against".
        return Number.isSafeInteger(m) && m >= 0 ? m : 0;
      } catch {
        return 0;
      }
    },
    rowIdAtRowid(rowid: number) {
      if (!Number.isSafeInteger(rowid) || rowid <= 0) return null;
      try {
        const row = db
          .prepare(`SELECT id FROM messages WHERE rowid = ? LIMIT 1`)
          .get(rowid) as { id: string | null } | undefined;
        if (!row) return null;
        return typeof row.id === "string" ? row.id : null;
      } catch {
        return null;
      }
    },
    close() {
      try {
        db.close();
      } catch {
        // best-effort
      }
    },
  };
}
