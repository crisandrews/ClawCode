/**
 * Phase 4a-2.6 — synthetic per-chat indexer over `messages.db`.
 *
 * Rationale (Codex 4a-2.6 pre-impl review F1, CRITICAL):
 *   Upstream `claude-whatsapp` writes ONE daily transcript file mixing
 *   every chat for that date. OpenCLAUDE's existing chunker breaks
 *   that file into ~700-char windows that span multiple chats. We
 *   CANNOT safely tag a daily-transcript chunk with a single chat_id;
 *   doing so would leak cross-chat content to a non-owner allowed
 *   only their own chat.
 *
 *   Instead, this indexer reads `messages.db` directly (read-only),
 *   groups rows by `(chat_id, date)`, and writes one synthetic chunk
 *   per pair via `MemoryDB.upsertSyntheticChunk`. Each chunk's
 *   content is rendered strictly from the rows of one chat, so the
 *   per-chunk `source_chat_id` is unambiguous and `canSee` can filter
 *   correctly under partial allowlists.
 *
 *   The daily `.md` chunks remain in the index with
 *   `source_chat_id = null` (Phase 2 behavior). Owner sees them via
 *   the null-allowlist path; non-owners with a partial allowlist
 *   never see them — fail closed, no leak.
 *
 * Cycle:
 *   1. Read cursor (`scope_indexer_cursors.last_rowid`) for "whatsapp".
 *   2. Open messages.db read-only. If unavailable, return.
 *   3. Read up to BATCH_SIZE rows with rowid > cursor.
 *   4. Collect `(chat_id, date)` pairs touched by the batch.
 *   5. For each pair, query messages.db with the per-pair index over
 *      ts-range, render the chunk text in (ts, rowid) asc order, upsert
 *      via `MemoryDB.upsertSyntheticChunk`. Codex 9th-pass HIGH F1
 *      replaced the prior "read first 5000 rows then filter in memory"
 *      approach which dropped pairs at high rowids.
 *   6. Advance cursor to max rowid in the batch — but only if EVERY
 *      pair upsert succeeded (Codex 9th-pass MEDIUM F5). Holding the
 *      cursor on partial failure makes the next tick retry instead of
 *      silently dropping rows.
 *
 * Bounded by BATCH_SIZE so a 100k-row backlog doesn't block the
 * caller (search hot path). The caller fires `runMessagesDbIndexerTick`
 * after each `MemoryDB.sync()` and on watcher events; subsequent ticks
 * drain the rest.
 */

import fs from "node:fs";
import path from "node:path";

import type { MemoryDB } from "../memory-db.ts";
import {
  openMessagesDb,
  type MessagesDbHandle,
  type MessagesDbRow,
} from "./messages-db.ts";

/**
 * Phase 4a-2.6 v18 — Codex 18th-pass HIGH F3: compute an identity
 * string for the upstream messages.db file that changes when the
 * file is replaced (unlink+create) but stays stable across normal
 * writes. Returns null when the file can't be stat'd (caller
 * treats as "no identity yet").
 *
 * Uses ONLY `dev:ino`. We deliberately avoid `size` and `ctimeMs`
 * because both bump on every write — including them would force a
 * cursor reset on every INSERT, re-indexing the whole DB constantly.
 * The remaining ino-reuse edge case (a deleted-then-recreated file
 * happening to take the same inode) is covered by the secondary
 * `MAX(rowid) < cursor` heuristic in the tick body. Together they
 * close both: file replaced (ino changes) and file truncated-in-place
 * (ino stable, max(rowid) regresses).
 */
function computeMessagesDbIdentity(channelDir: string): string | null {
  try {
    const dbPath = path.join(channelDir, "messages.db");
    const st = fs.statSync(dbPath);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

const BATCH_SIZE = 1000;
const PAIR_FETCH_CAP = 5000; // hard cap on rows rendered per (chat, date)
/**
 * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: how many recent synthetic
 * chunks to walk in a reconciliation pass. Bounded so the search hot
 * path doesn't pay an O(N) cost on every tick. Walks most-recent-first
 * (by upstream mtime), so the deletes/edits operators most likely care
 * about land first. Older deletes are still picked up the next time
 * the chunk's pair is re-touched by an INSERT.
 */
const RECONCILE_LIMIT = 50;
/**
 * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: minimum gap between
 * reconciliation passes. Without this, every fire-and-forget search
 * hot-path tick on a quiet upstream would re-walk RECONCILE_LIMIT
 * synthetic chunks and re-query upstream for each. 60 s strikes the
 * balance between "operator notices the deleted message is still
 * showing up" (worst case 60 s) and "reconciliation tax on the
 * search path" (effectively zero amortized). Tests inject a smaller
 * value via `IndexerTickOptions.reconcileThrottleMs`.
 */
const RECONCILE_THROTTLE_MS = 60_000;
/**
 * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F3: how long we tolerate
 * confirmed absence of upstream `messages.db` before quarantining
 * (hard-deleting) the channel's synthetic chunks. WhatsApp Desktop
 * crashes / restarts / brief offline periods are normal; permanent
 * removal of the pair (which deletes the channel directory entirely)
 * is the threat case where we'd otherwise serve stale PII forever.
 *
 * 24 hours is a deliberate middle ground: long enough that an
 * ordinary outage doesn't blow away the user's index, short enough
 * that a deliberate "remove pair" propagates within a day. Tests
 * inject a smaller value via `IndexerTickOptions.dbAbsenceGraceMs`.
 */
const DB_ABSENCE_GRACE_MS = 24 * 60 * 60 * 1000;

export interface IndexerTickResult {
  /** Whether the indexer found a DB and ran. */
  ran: boolean;
  /** Number of new message rows consumed in this tick. */
  rowsConsumed: number;
  /** Number of (chat, date) chunks rebuilt successfully. */
  pairsRebuilt: number;
  /**
   * Phase 4a-2.6 v11 (Codex 11th-pass HIGH F1): number of (chat, date)
   * chunks whose row count hit `MAX_ROWS_PER_PAIR` and so are missing
   * tail messages. Surfaced for doctor signals.
   */
  pairsCapped: number;
  /**
   * Phase 4a-2.6 v17 (Codex 17th-pass HIGH F1): number of synthetic
   * chunks that were deleted by the reconciliation pass because
   * upstream returned zero rows for that (chat, date) — i.e. a delete
   * propagated. Zero on append-only ticks.
   */
  pairsDeleted: number;
  /**
   * Phase 4a-2.6 v17 (Codex 17th-pass HIGH F1): number of synthetic
   * chunks whose text was rewritten by the reconciliation pass
   * because upstream changed (insert/edit) without a new rowid. Zero
   * on the common path where new rowids drive the rebuild.
   */
  pairsReconciled: number;
  /** New cursor after this tick (== prior cursor when no rows OR partial failure). */
  cursor: number;
  /** Reason the tick was a no-op when ran=false. */
  reason?: string;
}

export interface IndexerTickOptions {
  /** Channel directory containing `messages.db`. */
  channelDir: string;
  /** MemoryDB instance to write synthetic chunks into. */
  memoryDb: MemoryDB;
  /** Override BATCH_SIZE — used by tests. */
  batchSize?: number;
  /**
   * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: override the default
   * `RECONCILE_THROTTLE_MS` (60 000) so tests can drive multiple
   * reconciliation passes back-to-back without sleeping. Also
   * surfaces the knob if real-world usage wants tighter sync (e.g.
   * a daemon mode where 60 s lag is too much) at the cost of more
   * upstream queries.
   */
  reconcileThrottleMs?: number;
  /**
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F3: override the default
   * `DB_ABSENCE_GRACE_MS` (24 hours). When upstream `messages.db`
   * has been confirmed-absent (ENOENT) for longer than this, the
   * channel's synthetic chunks are hard-deleted to avoid serving
   * stale PII indefinitely.
   */
  dbAbsenceGraceMs?: number;
}

/**
 * One bounded indexer tick. Idempotent; re-running on the same DB
 * with no new rows is a no-op (returns rowsConsumed=0).
 */
export async function runMessagesDbIndexerTick(
  opts: IndexerTickOptions
): Promise<IndexerTickResult> {
  const channel = "whatsapp";
  const batchSize = opts.batchSize ?? BATCH_SIZE;

  // Phase 4a-2.6 v18 — Codex 18th-pass HIGH F3: detect upstream DB
  // replacement (different inode than what we last saw). Pre-v18 a
  // user who removed and recreated their WhatsApp pairing would end
  // up with new rowids starting at 1 while the cursor sat at the
  // old DB's max rowid; the v17 regression-rejection guard then
  // refused to walk back, silently stalling the indexer forever.
  // Reset cursor + last_reconcile_ms when the identity changes.
  // First-tick (stored identity null) is NOT a reset — we just
  // record the current identity and proceed.
  const currentIdentity = computeMessagesDbIdentity(opts.channelDir);
  const storedIdentity = opts.memoryDb.getIndexerDbIdentity(channel);
  if (
    currentIdentity !== null &&
    storedIdentity !== null &&
    currentIdentity !== storedIdentity
  ) {
    opts.memoryDb.resetIndexerCursorState(channel);
  }

  let cursor = opts.memoryDb.getIndexerCursor(channel);

  const handle = await openMessagesDb(opts.channelDir);
  if (!handle) {
    // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F3: PII quarantine on
    // confirmed absence. When `openMessagesDb` returns null we
    // distinguish "missing file" (likely-permanent removal of the
    // pair) from "transient lock / corrupt" (likely-temporary). For
    // the missing case, after a grace window of consecutive null
    // opens we hard-delete the channel's synthetic chunks so we
    // don't serve stale PII forever.
    const dbPath = path.join(opts.channelDir, "messages.db");
    let isMissing = false;
    try {
      fs.statSync(dbPath);
    } catch (e: any) {
      if (e?.code === "ENOENT") isMissing = true;
    }
    let quarantined = 0;
    if (isMissing) {
      let lastOpen = opts.memoryDb.getIndexerLastOpenMs(channel);
      // Phase 4a-2.6 v20 — Codex 20th-pass HIGH F1: backfill the
      // last-open timestamp for v18→v19 upgrades. The column was
      // added nullable in v19 with no backfill; an install that has
      // existing synthetic chunks but never observed `last_open_ms`
      // would skip quarantine forever. Existing chunks for the
      // channel are proof we DID have a working DB before the
      // upgrade, so seed `last_open_ms` to a value that puts us
      // immediately past the grace window. Future ticks where the
      // DB is present will overwrite this with `Date.now()` again.
      if (
        lastOpen === null &&
        opts.memoryDb.countSyntheticChunksForChannel(channel) > 0
      ) {
        const graceMsForSeed =
          typeof opts.dbAbsenceGraceMs === "number"
            ? Math.max(0, opts.dbAbsenceGraceMs)
            : DB_ABSENCE_GRACE_MS;
        // Seed strictly past `now - graceMs` so the comparison below
        // fires on this same tick.
        const seed = Math.max(0, Date.now() - graceMsForSeed - 1);
        opts.memoryDb.setIndexerLastOpenMs(channel, seed);
        lastOpen = seed;
      }
      const graceMs =
        typeof opts.dbAbsenceGraceMs === "number"
          ? Math.max(0, opts.dbAbsenceGraceMs)
          : DB_ABSENCE_GRACE_MS;
      // Only quarantine if we previously had a working DB AND the
      // grace window has expired since our last successful open.
      // First-ever absence (last_open_ms null after backfill check)
      // is a no-op — we never saw the DB so there's nothing to
      // quarantine anyway.
      if (lastOpen !== null && Date.now() - lastOpen > graceMs) {
        quarantined =
          opts.memoryDb.purgeAllSyntheticChunksForChannel(channel);
        // After a quarantine, reset cursor state so the next time the
        // DB does come back we start fresh rather than racing the old
        // cursor against a brand-new file.
        opts.memoryDb.resetIndexerCursorState(channel);
      }
    }
    return {
      ran: false,
      rowsConsumed: 0,
      pairsRebuilt: 0,
      pairsCapped: 0,
      pairsDeleted: quarantined,
      pairsReconciled: 0,
      cursor,
      reason: isMissing
        ? "messages.db absent"
        : "messages.db unavailable (locked/corrupt)",
    };
  }
  // Mark this as a successful open so the quarantine grace window
  // resets every time we get past `openMessagesDb`.
  opts.memoryDb.setIndexerLastOpenMs(channel, Date.now());

  try {
    // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F1: same-inode
    // truncation. If upstream dropped+recreated the `messages`
    // table without unlinking the file (e.g. via `DELETE FROM
    // messages` + `VACUUM`, or a TRUNCATE-equivalent in another
    // tool), the dev:ino identity stays stable but `MAX(rowid)`
    // regresses below our stored cursor. The v17 cursor
    // regression-rejection guard then refuses to walk back, and the
    // indexer silently skips every new row forever. Detect by
    // probing MAX(rowid); if the cursor is past it, reset and
    // re-read the cursor for use in the rest of the tick.
    const upstreamMax = handle.maxRowid();
    if (cursor > 0 && upstreamMax > 0 && cursor > upstreamMax) {
      opts.memoryDb.resetIndexerCursorState(channel);
      cursor = opts.memoryDb.getIndexerCursor(channel);
    }

    // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: cursor row
    // tampering detection (rowid reuse). SQLite `INTEGER PRIMARY
    // KEY` without `AUTOINCREMENT` reuses the deleted-max rowid for
    // the next INSERT. If our cursor is at rowid 100 and upstream
    // deletes row 100 then inserts a new message, the new message
    // gets rowid 100 — and our `WHERE rowid > 100` predicate
    // silently skips it forever. We verify the row at `cursor`
    // still has the same `id` we last saw; if it doesn't (or the
    // row is gone but rowid <= maxRowid), walk back to `cursor - 1`
    // for this tick's scan so the SELECT picks up the replaced row.
    if (cursor > 0 && cursor <= upstreamMax) {
      const observedId = handle.rowIdAtRowid(cursor);
      const storedId = opts.memoryDb.getIndexerCursorRowId(channel);
      // Phase 4a-2.6 v20 — Codex 20th-pass HIGH F2: bootstrap the
      // cursor_row_id for v18→v19 upgrades. The column was added
      // nullable in v19 with no backfill, so a v18 row entering v19
      // has `storedId === null`.
      //
      // Phase 4a-2.6 v21 — Codex 21st-pass HIGH F1: unconditional
      // walk-back when storedId is null AND we have a non-zero
      // cursor inside the upstream rowid range. v20 trusted
      // `observedId` when it was non-null and only walked back when
      // observed was also null — but if rowid reuse happened
      // BEFORE the v18→v19 upgrade, observed would be the new
      // (replacement) id. v20 happily stored it and the cursor
      // skipped the replacement row forever. v21 always walks back
      // once on a null-stored cursor; the upcoming SELECT re-reads
      // rowid `cursor` (whatever lives there now) and the
      // end-of-tick success branch stamps the new id.
      if (storedId === null) {
        cursor = Math.max(0, cursor - 1);
        opts.memoryDb.resetIndexerCursorState(channel);
        if (cursor > 0) opts.memoryDb.setIndexerCursor(channel, cursor);
      } else if (observedId !== storedId) {
        // Walk back so the SELECT re-reads the row at `cursor`.
        cursor = Math.max(0, cursor - 1);
        // Persist via the regression-bypassing path: reset+reapply.
        opts.memoryDb.resetIndexerCursorState(channel);
        if (cursor > 0) opts.memoryDb.setIndexerCursor(channel, cursor);
      }
    }

    // Codex 10th-pass HIGH F3: read raw max rowid alongside the
    // validated rows so an all-invalid batch still advances cursor.
    const { rows: batch, maxRawRowid } = handle.readBatchWithMaxRowid(
      cursor,
      batchSize
    );

    // Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: throttle gate. Run
    // the reconciliation pass at most once per `throttleMs`. PRAGMA
    // data_version isn't durable across the open-close lifecycle of
    // `openMessagesDb` (each fresh connection's first read returns
    // its own baseline), so we use wall-clock throttling instead.
    const throttleMs =
      typeof opts.reconcileThrottleMs === "number"
        ? Math.max(0, opts.reconcileThrottleMs)
        : RECONCILE_THROTTLE_MS;
    const lastReconcileMs =
      opts.memoryDb.getIndexerLastReconcileMs(channel) ?? 0;
    const now = Date.now();
    const reconcileDue = now - lastReconcileMs >= throttleMs;

    // Phase 4a-2.6 v18 — Codex 18th-pass HIGH F1: shared reconcile
    // helper. Pre-v18 reconciliation only fired in the true EOF
    // branch (`batch.length === 0 && maxRawRowid === cursor`), so a
    // workload with even 1 message/min would never reach EOF and
    // upstream deletes/edits would accumulate stale-PII forever.
    // v18 runs reconciliation on every code path: EOF, all-invalid
    // batch, and the rowid-driven rebuild success path. The throttle
    // gate keeps cost bounded.
    function maybeReconcile(): { reconciled: number; deleted: number } {
      if (!reconcileDue) return { reconciled: 0, deleted: 0 };
      const r = reconcileRecentChunks(handle, opts.memoryDb, channel);
      opts.memoryDb.setIndexerLastReconcileMs(channel, now);
      return r;
    }

    if (batch.length === 0 && maxRawRowid === cursor) {
      // Nothing read at all — true empty / EOF.
      const { reconciled, deleted } = maybeReconcile();
      if (currentIdentity !== null) {
        opts.memoryDb.setIndexerDbIdentity(channel, currentIdentity);
      }
      return {
        ran: true,
        rowsConsumed: 0,
        pairsRebuilt: 0,
        pairsCapped: 0,
        pairsDeleted: deleted,
        pairsReconciled: reconciled,
        cursor,
      };
    }
    if (batch.length === 0 && maxRawRowid > cursor) {
      // The window contained only invalid rows; advance the cursor so
      // we don't loop on them forever, but do not synthesize chunks.
      opts.memoryDb.setIndexerCursor(channel, maxRawRowid);
      // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: ask the handle
      // for the id at maxRawRowid (validateRows might have dropped
      // it, but the raw row still exists). Persist whatever we get
      // (may be null if the rowid is invalid/missing).
      opts.memoryDb.setIndexerCursorRowId(
        channel,
        handle.rowIdAtRowid(maxRawRowid)
      );
      const { reconciled, deleted } = maybeReconcile();
      if (currentIdentity !== null) {
        opts.memoryDb.setIndexerDbIdentity(channel, currentIdentity);
      }
      return {
        ran: true,
        rowsConsumed: 0,
        pairsRebuilt: 0,
        pairsCapped: 0,
        pairsDeleted: deleted,
        pairsReconciled: reconciled,
        cursor: maxRawRowid,
      };
    }

    // Step 4: collect (chat_id, date) pairs touched. Codex 10th-pass
    // MEDIUM F4: nested Map keyed on `chat_id` then `date`, so a
    // chat_id that contains the prior delimiter (`|`) can't corrupt
    // the date. Even though `validateRows` rejects empty chat_id, it
    // doesn't restrict the character set.
    const pairs: Map<string, Set<string>> = new Map();
    for (const row of batch) {
      const date = isoDateFromUnixSeconds(row.ts);
      let dates = pairs.get(row.chat_id);
      if (!dates) {
        dates = new Set();
        pairs.set(row.chat_id, dates);
      }
      dates.add(date);
    }

    // Step 5: rebuild each pair. Codex 9th-pass MEDIUM F5 — track
    // per-pair success; on any failure, hold the cursor so the next
    // tick retries. Codex 11th-pass HIGH F1: capped pairs (day with
    // > MAX_ROWS_PER_PAIR rows) count as written (cursor advances)
    // but get reported in `pairsCapped` so doctor surfaces the loss.
    let pairsRebuilt = 0;
    let pairsCapped = 0;
    let anyFailed = false;
    for (const [chat_id, dates] of pairs) {
      for (const date of dates) {
        const result = rebuildPair(handle, opts.memoryDb, chat_id, date);
        if (result === "ok") pairsRebuilt++;
        else if (result === "capped") {
          pairsRebuilt++;
          pairsCapped++;
        } else if (result === "absent") {
          // Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: rare race
          // where the rows we saw in `batch` were deleted upstream
          // between the batch read and the per-pair fetch. The pair
          // was processed (rebuildPair already deleted any stale
          // synthetic chunk); count as ok so the cursor still
          // advances past `maxRawRowid` instead of looping.
        } else anyFailed = true;
      }
    }

    // Step 6: advance cursor only when every pair landed durably.
    // Codex 13th-pass MEDIUM v12-F2: cursor advance + metric bump
    // run in a single transaction so a process crash between the two
    // can't leave a "cursor moved past truncated rows but the
    // truncation wasn't recorded" inconsistency.
    if (!anyFailed) {
      opts.memoryDb.advanceIndexerCursorAtomic(channel, maxRawRowid, [
        { metric: "pairs_capped", amount: pairsCapped },
      ]);
    } else if (pairsCapped > 0) {
      // anyFailed → cursor stays put. Still record any successful
      // capped-pair writes so doctor sees them; the failed pair will
      // re-run next tick and produce its own metric bump.
      opts.memoryDb.bumpIndexerMetric("pairs_capped", pairsCapped);
    }

    // Phase 4a-2.6 v18 — Codex 18th-pass HIGH F1: reconcile after the
    // rowid-driven rebuild path too, so steady insert workloads
    // still get delete/edit detection.
    const { reconciled, deleted } = maybeReconcile();

    // Phase 4a-2.6 v18 — Codex 18th-pass HIGH F3: persist current
    // upstream DB identity so the next tick can detect a swap.
    if (currentIdentity !== null) {
      opts.memoryDb.setIndexerDbIdentity(channel, currentIdentity);
    }

    // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: persist the `id`
    // of the row the cursor now points at, so the next tick can
    // detect rowid reuse. Only on the success branch (where we
    // actually advanced).
    if (!anyFailed && batch.length > 0) {
      const lastRow = batch[batch.length - 1];
      // batch is ordered by rowid asc per readBatchWithMaxRowid's
      // `ORDER BY rowid ASC`, so the last entry is the one at
      // maxRawRowid (or close to it after row-level validation
      // dropped some). We use its `id` if it's at maxRawRowid;
      // otherwise we ask the handle for the id at maxRawRowid
      // because validateRows may have dropped the actual max row.
      let cursorRowId: string | null = null;
      if (lastRow.rowid === maxRawRowid) {
        cursorRowId = lastRow.id;
      } else {
        cursorRowId = handle.rowIdAtRowid(maxRawRowid);
      }
      opts.memoryDb.setIndexerCursorRowId(channel, cursorRowId);
    }

    return {
      ran: true,
      rowsConsumed: batch.length,
      pairsRebuilt,
      pairsCapped,
      pairsDeleted: deleted,
      pairsReconciled: reconciled,
      cursor: anyFailed ? cursor : maxRawRowid,
    };
  } finally {
    handle.close();
  }
}

/**
 * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: reconcile recent
 * synthetic chunks against current upstream state. Walks up to
 * `RECONCILE_LIMIT` most-recent synthetic paths for the channel,
 * reruns `rebuildPair` for each (chat, date), and counts the deletes
 * vs rewrites. Skips chunks whose path can't be parsed (defensive —
 * a non-conforming path under the synthetic prefix stays untouched).
 */
function reconcileRecentChunks(
  handle: MessagesDbHandle,
  memoryDb: MemoryDB,
  channel: string
): { reconciled: number; deleted: number } {
  const paths = memoryDb.listSyntheticChunkPathsForChannel(
    channel,
    RECONCILE_LIMIT
  );
  let reconciled = 0;
  let deleted = 0;
  const now = Date.now();
  for (const p of paths) {
    const decoded = decodeSyntheticPath(p);
    if (!decoded) {
      // Defensive: a non-conforming path under the synthetic prefix
      // can't be reconciled, but we still mark it so it doesn't keep
      // showing up at the front of the unchecked queue every pass.
      memoryDb.markSyntheticChunkReconciled(p, now);
      continue;
    }
    // Capture pre-rebuild text so we can tell whether reconciliation
    // actually changed anything (rebuildPair always upserts — counting
    // every walk as "reconciled" would over-report).
    const before = memoryDb.readSyntheticChunkText(p);
    const result = rebuildPair(handle, memoryDb, decoded.chat_id, decoded.date);
    if (result === "absent") {
      deleted++;
      // The path is gone from the rotation table (deleteSyntheticChunk
      // clears it in v18 F2). No mark needed.
    } else if (result === "ok" || result === "capped") {
      const after = memoryDb.readSyntheticChunkText(p);
      if (after !== before) reconciled++;
      // Phase 4a-2.6 v18 — Codex 18th-pass HIGH F2: stamp the path so
      // the next reconciliation pass picks a different one. Without
      // this every pass would re-walk the same most-recent set
      // forever.
      memoryDb.markSyntheticChunkReconciled(p, now);
    }
    // "failed" → leave the chunk in place AND don't stamp it; next
    // pass will retry it (it's still in the unchecked / oldest-
    // checked queue).
  }
  return { reconciled, deleted };
}

/**
 * Inverse of the synthetic path scheme used by `rebuildPair`.
 * Format: `extra:claude-whatsapp/messages-db/<encoded-chat>/<YYYY-MM-DD>`.
 */
function decodeSyntheticPath(
  p: string
): { chat_id: string; date: string } | null {
  const m = p.match(
    /^extra:claude-whatsapp\/messages-db\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/
  );
  if (!m) return null;
  try {
    return { chat_id: decodeURIComponent(m[1]), date: m[2] };
  } catch {
    return null;
  }
}

/**
 * Pull every row matching `(chat_id, date)` from messages.db, render,
 * and upsert.
 *
 * Codex 10th-pass HIGH F1: paginates by rowid within the day so a
 * chat-day with > PAIR_FETCH_CAP rows is drained completely.
 *
 * Codex 11th-pass HIGH F1 / F2 / F4: (a) `MAX_ROWS_PER_PAIR` raised
 * to 500k so realistic public-group viral days don't lose messages;
 * (b) pagination uses `readByChatAndTsRangeRaw` which surfaces the
 * raw row count so a page that lost rows to row-level validation
 * doesn't fool us into thinking we hit EOF; (c) ordering switched to
 * `(ts ASC, rowid ASC)` keyset so the existing upstream index
 * `idx_messages_chat_ts(chat_id, ts DESC)` answers the query without
 * a temp B-tree sort.
 *
 * The 500k cap is essentially "did upstream go insane" guard; we
 * emit it via `pairsCapped` so the doctor surfaces the loss instead
 * of silently truncating. A future enhancement would split a single
 * day into multiple synthetic chunks, but the cap is large enough
 * that hitting it is genuinely pathological.
 */
type RebuildResult = "ok" | "capped" | "absent" | "failed";
/**
 * Codex 12th-pass MEDIUM v11-F1: cap lowered to 100k. v11 used 500k
 * which on a viral WhatsApp day at ~200 B/row puts ~100 MB of
 * transient string in the indexer + duplicate string in the SQLite
 * insert + duplicate string in FTS. 100k stays comfortably under
 * realistic public-group day sizes (the largest groups topping out
 * at ~30k msgs/day) AND keeps transient heap under ~25 MB even at
 * the bound. Pairs that hit it still emit `pairsCapped` so doctor
 * surfaces the truncation. Splitting a single day across multiple
 * synthetic chunks is queued as future work — see
 * docs/channel-scope-compat.md "Phase 4a-2.6 — Known limitations".
 */
const MAX_ROWS_PER_PAIR = 100_000;
function rebuildPair(
  handle: MessagesDbHandle,
  memoryDb: MemoryDB,
  chat_id: string,
  date: string
): RebuildResult {
  const range = unixSecondsRangeForIsoDate(date);
  if (!range) return "failed";

  // Drain the day with (ts, rowid) keyset pagination up to MAX_ROWS_PER_PAIR.
  const collected: MessagesDbRow[] = [];
  let afterTs = -1;
  let afterRowid = -1;
  let capped = false;
  while (collected.length < MAX_ROWS_PER_PAIR) {
    const remainingCap = MAX_ROWS_PER_PAIR - collected.length;
    const pageLimit = Math.min(PAIR_FETCH_CAP, remainingCap);
    const page = handle.readByChatAndTsRangeRaw(
      chat_id,
      range.fromSec,
      range.toSec,
      afterTs,
      afterRowid,
      pageLimit
    );
    if (page.error) return "failed";
    if (page.rawCount === 0) break;
    collected.push(...page.rows);
    if (page.rows.length > 0) {
      const last = page.rows[page.rows.length - 1];
      afterTs = last.ts;
      afterRowid = last.rowid;
    } else if (page.lastRawTs !== undefined && page.lastRawRowid !== undefined) {
      // The whole page failed validation but we still got raw cursor
      // metadata — advance keyset cursor so we don't loop on bad rows.
      afterTs = page.lastRawTs;
      afterRowid = page.lastRawRowid;
    }
    if (page.rawCount < pageLimit) break;
    if (collected.length >= MAX_ROWS_PER_PAIR) {
      capped = true;
      break;
    }
  }
  // Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: distinguish "upstream
  // genuinely has no rows for this pair" from "we hit a SQL error".
  // The empty-but-clean case is the deleted-pair signal: caller (the
  // reconciliation pass) deletes the stale synthetic chunk so a
  // search no longer surfaces text for messages that no longer exist
  // upstream.
  //
  // Phase 4a-2.6 v18 — Codex 18th-pass MEDIUM F4: propagate
  // deleteSyntheticChunk failure. Pre-v18 we returned "absent"
  // unconditionally — a transient SQLite write-side error during the
  // delete txn would have left stale text in `chunks`/`chunks_fts`
  // while the caller counted the pair as cleaned. Now we surface
  // "failed" so the pair retries on the next throttle window.
  const logicalPath = `extra:claude-whatsapp/messages-db/${encodeChatId(
    chat_id
  )}/${date}`;
  if (collected.length === 0) {
    const ok = memoryDb.deleteSyntheticChunk(logicalPath);
    return ok ? "absent" : "failed";
  }

  collected.sort((a, b) => a.ts - b.ts || a.rowid - b.rowid);
  const text = collected.map((r) => renderRow(r)).join("\n");
  const upstreamMaxTs = collected[collected.length - 1].ts;

  const ok = memoryDb.upsertSyntheticChunk({
    path: logicalPath,
    sourceChannel: "whatsapp",
    sourceChatId: chat_id,
    text,
    upstreamMaxTs,
  });
  if (!ok) return "failed";
  // Phase 4a-2.6 v19 — Codex 19th-pass MEDIUM F4: stamp the rotation
  // marker for rowid-driven rebuilds too. Without this, sustained
  // ingestion of >50 new (chat, date) pairs per throttle window
  // would push freshly-built chunks to the front of the unchecked
  // queue every pass — older marked chunks needing stale-PII
  // reconciliation would be perpetually deferred.
  memoryDb.markSyntheticChunkReconciled(logicalPath);
  return capped ? "capped" : "ok";
}

/** UTC YYYY-MM-DD from upstream's `ts` (unix seconds). */
function isoDateFromUnixSeconds(ts: number): string {
  // Reader-side validation already rejects bad ts (Codex 9th-pass
  // HIGH F2 in messages-db.ts), so `new Date(ts * 1000).toISOString()`
  // is safe here.
  const d = new Date(ts * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Inverse of `isoDateFromUnixSeconds` — returns `[fromSec, toSec)`
 * spanning that UTC day. Defensive against a malformed input even
 * though we generate it ourselves from validated rows.
 */
function unixSecondsRangeForIsoDate(
  date: string
): { fromSec: number; toSec: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const fromMs = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(fromMs)) return null;
  const fromSec = Math.floor(fromMs / 1000);
  return { fromSec, toSec: fromSec + 86_400 };
}

/**
 * Render a single message row to a deterministic line. Mirrors
 * upstream's `.md` style at the row level so search snippets look
 * familiar to operators inspecting OpenCLAUDE memory.
 */
function renderRow(r: { ts: number; direction: "in" | "out"; sender_id: string | null; text: string }): string {
  const who = r.direction === "in" ? r.sender_id ?? "incoming" : "outgoing";
  return `[${new Date(r.ts * 1000).toISOString()}] ${who}: ${r.text}`;
}

/**
 * Encode a chat_id for use as a single path component.
 *
 * Codex 9th-pass MEDIUM F3 closed the collision between `a/b` and
 * literal `a%2Fb` by escaping `%` BEFORE `/`. This keeps JIDs
 * readable in paths (e.g. `alice@s.whatsapp.net` is unchanged) but
 * makes the encoding injective:
 *   - `a/b`         → `a%2Fb`
 *   - `a%2Fb`       → `a%252Fb`
 *   - `a@b`         → `a@b` (unchanged)
 *
 * We avoid full `encodeURIComponent` because it also escapes `@`,
 * which would render every JID-shaped path unreadable for an operator
 * inspecting the SQLite file directly. The threat model is path-
 * traversal / cross-chat collision, not URL-safety; `@`, `.`, `-`, `_`
 * are all safe path characters on every supported OS.
 *
 * Control characters and the path separator `/` and `\` are the only
 * filename-unsafe characters that JIDs could realistically contain
 * (they don't, in upstream's vocabulary, but this is defense in depth
 * against future formats / hostile rows).
 */
function encodeChatId(chatId: string): string {
  let out = "";
  for (let i = 0; i < chatId.length; i++) {
    const c = chatId.charCodeAt(i);
    const ch = chatId[i];
    if (
      c < 0x20 ||
      c === 0x7f /* DEL */ ||
      ch === "%" ||
      ch === "/" ||
      ch === "\\"
    ) {
      out += "%" + c.toString(16).padStart(2, "0").toUpperCase();
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Inverse of `encodeChatId`. Used when a downstream consumer needs to
 * recover the original chat id from a synthetic chunk path.
 */
export function decodeChatIdFromSyntheticPath(p: string): string | null {
  // Expect `extra:claude-whatsapp/messages-db/<encoded-chat>/<date>`.
  const m = p.match(/^extra:claude-whatsapp\/messages-db\/([^/]+)\/[^/]+$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
