/**
 * Memory database — SQLite with FTS5
 * Mirrors OpenClaw's memory-schema.ts and manager.ts
 *
 * Schema:
 * - files: track file metadata (hash, mtime, size)
 * - chunks: store text chunks with line ranges
 * - chunks_fts: FTS5 virtual table for full-text search
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { chunkMarkdown } from "./chunker.ts";
import { buildFtsQuery, extractKeywords } from "./keywords.ts";
import { applyMMR } from "./mmr.ts";
import {
  deriveProvenance,
  enrichProvenanceWithDbRow,
  resolveContainedPath,
} from "./scope/provenance.ts";
import { issueScopeToken } from "./scope/tokens.ts";
import { parseScopedMemoryPath } from "./scope/scoped-paths.ts";
import { getDecayMultiplier } from "./temporal-decay.ts";
import type { SearchResult } from "./types.ts";

const MAX_SNIPPET_CHARS = 700;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.1;

/**
 * Phase 4a-2.6 — synthetic chunk path scheme.
 * `extra:claude-whatsapp/messages-db/<chat_id>/<YYYY-MM-DD>` is the
 * canonical shape produced by `lib/scope/messages-db-indexer.ts`. The
 * exact prefix is the marker; substring matching (Codex 9th-pass
 * MEDIUM F4) was unsafe because a user-configured `extraPath` whose
 * directory tree happens to include `messages-db/` would inadvertently
 * be treated as synthetic — silently skipped from on-disk cleanup
 * even after the source file is removed, and route through the chunks
 * table on read. Exact prefix matching closes that.
 */
const SYNTHETIC_CHUNK_PATH_PREFIX = "extra:claude-whatsapp/messages-db/";
export function isSyntheticChunkPath(p: string): boolean {
  return p.startsWith(SYNTHETIC_CHUNK_PATH_PREFIX);
}

export interface MemoryDBOptions {
  /** Suppress noisy boot messages — used by tests. */
  quietBoot?: boolean;
  /**
   * Phase 4a-2.6 v13 (Codex 13th-pass LOW v12-F4): construct a
   * read-only handle. Skips `fs.watch` registration AND the
   * permission-tightening chmod side effects. Used by `doctor.ts:
   * checkScopeIndexerHealth` so a diagnostic run doesn't allocate
   * watchers or rewrite mode bits on every invocation.
   */
  headless?: boolean;
}

export class MemoryDB {
  private db: Database.Database;
  private pluginRoot: string;
  private memoryDir: string;
  private extraPaths: string[];
  private dirty = true;
  private watchers: fs.FSWatcher[] = [];
  private headless: boolean;

  constructor(
    pluginRoot: string,
    extraPaths: string[] = [],
    opts: MemoryDBOptions = {}
  ) {
    this.headless = opts.headless === true;
    this.pluginRoot = pluginRoot;
    this.memoryDir = path.join(pluginRoot, "memory");
    this.extraPaths = extraPaths.map((p) => {
      // Expand ~ to home
      if (p.startsWith("~/")) return path.join(process.env.HOME || "", p.slice(2));
      return path.resolve(p);
    });

    // Ensure memory directory exists. Phase 4a-2.6 — Codex pre-impl
    // review F5: harden mode bits since the DB now stores chat_id
    // JIDs (PII) once the messages.db indexer runs. Best-effort —
    // some FSes (e.g. msys/cygwin, FAT mounts) reject chmod; we don't
    // fail open or closed on it, just attempt.
    //
    // Codex 13th-pass LOW v12-F4: skip the chmod when `headless`
    // (doctor's read-only metrics path). Doctor doesn't write any
    // sensitive data and shouldn't be rewriting mode bits on every
    // diagnostic run, especially on shared filesystems where chmod
    // can audit-log.
    if (!this.headless) {
      try {
        fs.mkdirSync(this.memoryDir, { recursive: true, mode: 0o700 });
        try {
          fs.chmodSync(this.memoryDir, 0o700);
        } catch {
          /* best-effort */
        }
      } catch {
        // Directory creation failed — will error on DB open
      }
    } else {
      try {
        fs.mkdirSync(this.memoryDir, { recursive: true });
      } catch {
        // unchanged
      }
    }

    const dbPath = path.join(this.memoryDir, ".memory.sqlite");

    try {
      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      if (!this.headless) {
        // Tighten perms on the sqlite + WAL/SHM siblings as soon as
        // they exist. WAL file is created by the journal_mode pragma
        // above; on first open SHM may not exist yet — chmod ENOENT
        // is fine. Codex 13th-pass LOW v12-F4: skip in headless mode.
        for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try {
            fs.chmodSync(f, 0o600);
          } catch {
            /* best-effort */
          }
        }
      }
      this.initSchema();
      this.migrateScopeColumns(dbPath);
    } catch (err) {
      // If DB fails (corrupt, permissions, etc.), create in-memory fallback
      this.db = new Database(":memory:");
      this.db.pragma("journal_mode = WAL");
      this.initSchema();
      this.migrateScopeColumns(null);
    }

    if (!this.headless) {
      this.startWatcher();
    }
  }

  /**
   * Watch memoryDir + extraPaths for .md changes; mark the index dirty so
   * the next search re-syncs. Without this, files added mid-session (e.g.
   * imported daily logs, new WhatsApp / Telegram conversation logs under
   * extraPaths) stay invisible to memory_search until restart or
   * /agent:doctor --fix. Platform note: fs.watch's `recursive: true` is
   * supported on macOS and Windows but ignored on Linux — so on Linux,
   * deep subdirectories under extraPaths get only top-level coverage.
   * Best-effort: each watcher is wrapped in try/catch (NFS, watcher
   * limits, missing path); if it fails the existing dirty=true on
   * construction + manual /agent:doctor --fix still cover the user.
   */
  private scopedWatcherInstalled = false;
  private startWatcher(): void {
    const onChange = (_event: string, filename: string | Buffer | null) => {
      const name = typeof filename === "string" ? filename : filename?.toString();
      if (!name) return;
      // Codex post-impl-round2 HIGH #3: install the recursive
      // `.scoped/` watcher lazily when the directory first appears
      // mid-session. Without this, a workspace whose first dream
      // cycle creates `memory/.scoped/` after MemoryDB construction
      // never gets a child watcher and search-side reindex of
      // newly-promoted scoped memories waits for the next process
      // restart.
      if (!this.scopedWatcherInstalled) {
        this.maybeInstallScopedWatcher(onChange);
      }
      if (!name.endsWith(".md")) return;
      // Phase 4a-3: dual-lane mirrors live under `.scoped/<channel>/`.
      // The original "no hidden" rule was correct for `.dreams/`
      // sidecars, but `.scoped/` files MUST trigger reindex so search
      // sees newly-promoted scoped memories without a process restart.
      // Codex Phase 4a-3 post-impl HIGH #3.
      if (name.startsWith(".") && !name.startsWith(".scoped/")) return;
      this.markDirty();
    };

    // memoryDir is flat by convention — top-level watch is enough,
    // BUT we also need to watch `.scoped/<channel>/` recursively for
    // Phase 4a-3. The recursive child watch is installed eagerly when
    // the dir already exists OR lazily inside onChange when it
    // appears.
    try {
      this.watchers.push(
        fs.watch(this.memoryDir, { persistent: false }, onChange)
      );
    } catch {
      // Watcher unavailable — fall through to existing behavior
    }
    this.maybeInstallScopedWatcher(onChange);

    // extraPaths are walked recursively in listMemoryFiles, so we ask for
    // recursive watching too (effective on Mac/Windows; degrades to
    // top-level on Linux)
    for (const extraPath of this.extraPaths) {
      try {
        this.watchers.push(
          fs.watch(
            extraPath,
            { persistent: false, recursive: true },
            onChange
          )
        );
      } catch {
        // Path missing or watcher unavailable — skip silently
      }
    }
  }

  private maybeInstallScopedWatcher(
    onChange: (event: string, filename: string | Buffer | null) => void
  ): void {
    if (this.scopedWatcherInstalled) return;
    const scopedDir = path.join(this.memoryDir, ".scoped");
    if (!fs.existsSync(scopedDir)) return;
    try {
      const w = fs.watch(
        scopedDir,
        { persistent: false, recursive: true },
        onChange
      );
      // Codex post-impl-round3 MEDIUM #3: clear the install flag if
      // the watcher closes (e.g. user `rm -rf memory/.scoped`).
      // Without this, the parent watcher's lazy install gate stays
      // permanently set even if `.scoped/` later reappears, leaving
      // the new tree unwatched until process restart.
      const reset = () => {
        this.scopedWatcherInstalled = false;
      };
      w.on("close", reset);
      w.on("error", reset);
      this.watchers.push(w);
      this.scopedWatcherInstalled = true;
    } catch {
      // Watcher unavailable on this platform — fall back to
      // process-restart for `.scoped/` reindex. Behavior matches
      // Linux limitations on `recursive: true`.
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        hash TEXT NOT NULL,
        source_channel TEXT,
        source_chat_id TEXT,
        FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
      );
    `);
    // Note: CREATE INDEX on (source_channel, source_chat_id) is done
    // inside migrateScopeColumns after ALTER TABLE, because legacy
    // DBs reach initSchema() before the columns are present and would
    // throw "no such column" if we tried it here.

    // FTS5 virtual table — separate creation (can't use IF NOT EXISTS)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5 (
          text,
          id UNINDEXED,
          path UNINDEXED,
          start_line UNINDEXED,
          end_line UNINDEXED
        );
      `);
    } catch {
      // Already exists — OK
    }
  }

  /**
   * Phase 2 — schema migration for scope columns.
   *
   * Adds `source_channel` and `source_chat_id` to existing chunks
   * tables that were created before Phase 2, then backfills via
   * path-pattern provenance derivation in batched 1k-row transactions
   * so the migration never holds a single huge write lock.
   *
   * Steps:
   *  1. Detect missing columns via PRAGMA table_info(chunks).
   *  2. If any are missing AND chunks contain rows, snapshot the DB
   *     once to `<db>.bak.<ts>` (file copy, not a SQL backup) so the
   *     user has a rollback if something goes wrong mid-migration.
   *  3. ALTER TABLE to add the columns.
   *  4. Drop a marker file `<workspace>/memory/.scope-migration-in-progress`
   *     so a crashed migration can be detected on next launch.
   *  5. Loop in 1k-row batches: SELECT chunks WHERE source_channel IS NULL
   *     LIMIT 1000, derive provenance, UPDATE inside a transaction.
   *  6. Remove the marker file when done.
   *
   * Idempotent: re-running on an already-migrated DB is a single
   * PRAGMA + zero-row SELECT and exits in milliseconds.
   *
   * Phase 2 invariant: this never deletes data and never reads file
   * contents — provenance is derived from `chunks.path` alone.
   */
  private migrateScopeColumns(dbPath: string | null): void {
    let columns: Array<{ name: string }> = [];
    try {
      columns = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{
        name: string;
      }>;
    } catch {
      return;
    }
    const hasChannel = columns.some((c) => c.name === "source_channel");
    const hasChatId = columns.some((c) => c.name === "source_chat_id");
    const needsAlter = !hasChannel || !hasChatId;

    let needsBackfill = false;
    try {
      const remaining = this.db
        .prepare(
          needsAlter
            ? "SELECT COUNT(*) as n FROM chunks"
            : "SELECT COUNT(*) as n FROM chunks WHERE source_channel IS NULL"
        )
        .get() as { n: number };
      needsBackfill = remaining.n > 0;
    } catch {
      needsBackfill = false;
    }

    if (!needsAlter && !needsBackfill) return;

    // 1. One-shot backup before structural change. WAL-safe: we
    //    PRAGMA wal_checkpoint(TRUNCATE) first so any committed pages
    //    held in the .memory.sqlite-wal sidecar are flushed into the
    //    main file. A naked fs.copyFileSync without the checkpoint
    //    would risk an inconsistent backup that's missing recent
    //    commits — Codex P0 finding for Phase 2.
    if (needsAlter && dbPath) {
      const backupPath = `${dbPath}.bak.${Date.now()}`;
      try {
        try {
          this.db.pragma("wal_checkpoint(TRUNCATE)");
        } catch {
          // Checkpoint can fail under heavy contention; the file copy
          // below is still better than no backup, just possibly
          // missing the very last commits. The migration is still
          // safe because the main DB is what gets ALTERed.
        }
        fs.copyFileSync(dbPath, backupPath);
      } catch {
        // Backup failure is non-fatal — migration still proceeds.
      }
    }

    // 2. ALTER TABLE — wrapped per-column in case the user hand-edited
    //    one column already. SQLite ALTER ADD is fast (no rewrite).
    if (!hasChannel) {
      try {
        this.db.exec("ALTER TABLE chunks ADD COLUMN source_channel TEXT");
      } catch {
        // Already added concurrently — ignore.
      }
    }
    if (!hasChatId) {
      try {
        this.db.exec("ALTER TABLE chunks ADD COLUMN source_chat_id TEXT");
      } catch {
        // Already added concurrently — ignore.
      }
    }
    try {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_channel, source_chat_id)"
      );
    } catch {
      // Index creation race — ignore.
    }

    // 3. Marker file for crash detection.
    const markerPath = path.join(this.memoryDir, ".scope-migration-in-progress");
    try {
      fs.writeFileSync(markerPath, String(Date.now()));
    } catch {
      // Best-effort.
    }

    // 4. Batched backfill loop. Each batch is its own transaction so
    //    a kill mid-migration leaves a coherent partial state.
    const BATCH = 1000;
    const select = this.db.prepare(
      "SELECT id, path FROM chunks WHERE source_channel IS NULL LIMIT ?"
    );
    const update = this.db.prepare(
      "UPDATE chunks SET source_channel = ?, source_chat_id = ? WHERE id = ?"
    );

    const computeStored = (
      relPath: string
    ): { channel: string; chatId: string | null } => {
      const prov = deriveProvenance(relPath);
      // Phase 2: store the channel name when known, or the literal
      // string "_local" / "_legacy" so a NULL value unambiguously
      // means "still pending migration".
      if (prov.class.kind === "channel") {
        return {
          channel: prov.class.sourceChannel,
          chatId: prov.class.sourceChatId,
        };
      }
      if (prov.class.kind === "local") {
        return { channel: "_local", chatId: null };
      }
      return { channel: "_legacy", chatId: null };
    };

    while (true) {
      const rows = select.all(BATCH) as Array<{ id: string; path: string }>;
      if (rows.length === 0) break;
      const tx = this.db.transaction((batch: typeof rows) => {
        for (const row of batch) {
          const { channel, chatId } = computeStored(row.path);
          update.run(channel, chatId, row.id);
        }
      });
      try {
        tx(rows);
      } catch {
        // Codex P1 1c — fall back to per-row updates so good rows in a
        // poisoned batch still progress instead of staying NULL forever.
        for (const row of rows) {
          try {
            const { channel, chatId } = computeStored(row.path);
            update.run(channel, chatId, row.id);
          } catch {
            // The single row genuinely can't be updated — mark it as
            // legacy so the WHERE source_channel IS NULL loop can
            // make forward progress on the next call.
            try {
              update.run("_legacy", null, row.id);
            } catch {
              // Truly stuck — skip; next launch will see it again.
            }
          }
        }
      }
      if (rows.length < BATCH) break;
    }

    try {
      fs.unlinkSync(markerPath);
    } catch {
      // Marker may have been removed concurrently or never created.
    }
  }

  /**
   * List all memory files to index.
   * Searches: memory/*.md + MEMORY.md at root + configured extraPaths.
   * Only *.md files are indexed. .jsonl, .json, binary files are skipped.
   */
  private listMemoryFiles(): Array<{ relPath: string; fullPath: string }> {
    const files: Array<{ relPath: string; fullPath: string }> = [];
    const seen = new Set<string>();

    const addFile = (fullPath: string, relPath: string) => {
      // Dedupe by absolute path
      const abs = path.resolve(fullPath);
      if (seen.has(abs)) return;
      seen.add(abs);
      files.push({ relPath, fullPath });
    };

    // Root MEMORY.md
    const rootMemory = path.join(this.pluginRoot, "MEMORY.md");
    if (fs.existsSync(rootMemory)) {
      addFile(rootMemory, "MEMORY.md");
    }

    // memory/MEMORY.md
    const memMemory = path.join(this.memoryDir, "MEMORY.md");
    if (fs.existsSync(memMemory)) {
      addFile(memMemory, "memory/MEMORY.md");
    }

    // All .md files in memory/ (excluding .dreams/ and hidden files)
    try {
      const entries = fs.readdirSync(this.memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.name === "MEMORY.md") continue; // Already added
        const fullPath = path.join(this.memoryDir, entry.name);
        if (entry.isFile() && entry.name.endsWith(".md")) {
          addFile(fullPath, `memory/${entry.name}`);
        }
      }
    } catch {
      // memory/ doesn't exist yet
    }

    // memory/.scoped/<channel>/MEMORY.<encoded-chat-id>.md — Phase 4a-3
    // dual-lane mirrors. Indexed explicitly because the generic loop
    // above skips dot-prefixed directories; without this the per-
    // channel scoped files never enter chunks/chunks_fts and search
    // sees nothing on the next dream cycle. Codex Phase 4a-3 post-
    // impl HIGH #3 + post-impl-round2 HIGH #9: walker validates each
    // candidate path via `parseScopedMemoryPath` so unknown channels
    // and malformed basenames are skipped instead of being indexed
    // as `_local` content (which would let an attacker with local
    // write access inject arbitrary text into the local memory
    // index).
    const scopedRoot = path.join(this.memoryDir, ".scoped");
    if (fs.existsSync(scopedRoot)) {
      try {
        const channels = fs.readdirSync(scopedRoot, { withFileTypes: true });
        let unknownSkipped = 0;
        for (const ch of channels) {
          if (!ch.isDirectory()) continue;
          if (!/^[a-z0-9_-]+$/.test(ch.name)) continue; // cheap pre-filter
          const channelDir = path.join(scopedRoot, ch.name);
          let files2: fs.Dirent[];
          try {
            files2 = fs.readdirSync(channelDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const f of files2) {
            if (!f.isFile()) continue;
            if (!/^MEMORY\..+\.md$/.test(f.name)) continue;
            const relPath = `memory/.scoped/${ch.name}/${f.name}`;
            if (parseScopedMemoryPath(relPath) === null) {
              // Codex post-impl-round3 LOW #10: surface a counter so
              // doctor / agent_status can flag a `.scoped/<unknown>/`
              // tree the user planted by mistake (or an attacker
              // tried to plant). Silent skip alone leaves the file
              // rotting unnoticed.
              unknownSkipped++;
              continue;
            }
            const fullPath = path.join(channelDir, f.name);
            addFile(fullPath, relPath);
          }
        }
        if (unknownSkipped > 0) {
          this.bumpIndexerMetric(
            "scoped_unknown_channel_skipped",
            unknownSkipped
          );
        }
      } catch {}
    }

    // extraPaths — walk recursively, .md only
    for (const extraPath of this.extraPaths) {
      this.walkExtraPath(extraPath, addFile);
    }

    return files;
  }

  /**
   * Recursively walk an extra path, collecting .md files only.
   * Skips .jsonl (duplicates of .md in some plugins like claude-whatsapp),
   * binary files, and hidden directories.
   */
  private walkExtraPath(
    rootPath: string,
    addFile: (fullPath: string, relPath: string) => void,
    currentDir?: string
  ): void {
    const dir = currentDir || rootPath;
    try {
      if (!fs.existsSync(dir)) return;
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) {
        // Single file — add if .md
        if (dir.endsWith(".md")) {
          addFile(dir, `extra:${path.basename(dir)}`);
        }
        return;
      }

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue; // skip hidden
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          this.walkExtraPath(rootPath, addFile, fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          // Build relative path: extra:<rootBasename>/<relative-path>
          const rootBase = path.basename(rootPath);
          const rel = path.relative(rootPath, fullPath);
          addFile(fullPath, `extra:${rootBase}/${rel}`);
        }
      }
    } catch {
      // Permission denied or other — skip silently
    }
  }

  /**
   * Sync memory files to the database.
   * Only re-indexes files whose hash has changed.
   * Mirrors OpenClaw's syncMemoryFiles().
   */
  sync(): {
    indexed: number;
    removed: number;
    unchanged: number;
    /**
     * Codex 11th-pass LOW F5: count of on-disk files whose logical
     * path collided with the reserved synthetic-chunk prefix. These
     * files are silently skipped (the reserved prefix is owned by
     * the messages.db indexer); doctor surfaces the count so a user
     * who legitimately wants `extra:claude-whatsapp/messages-db/...`
     * as their own extraPath can see they're being skipped and
     * rename their tree.
     */
    reservedPrefixSkipped: number;
  } {
    const memoryFiles = this.listMemoryFiles();
    const currentPaths = new Set(memoryFiles.map((f) => f.relPath));
    let indexed = 0;
    let removed = 0;
    let unchanged = 0;
    let reservedPrefixSkipped = 0;

    const getFile = this.db.prepare("SELECT hash FROM files WHERE path = ?");
    const upsertFile = this.db.prepare(
      "INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)"
    );
    const deleteFile = this.db.prepare("DELETE FROM files WHERE path = ?");
    const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE path = ?");
    const deleteFts = this.db.prepare("DELETE FROM chunks_fts WHERE path = ?");
    const insertChunk = this.db.prepare(
      "INSERT OR REPLACE INTO chunks (id, path, start_line, end_line, text, hash, source_channel, source_chat_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertFts = this.db.prepare(
      "INSERT INTO chunks_fts (text, id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?)"
    );

    const transaction = this.db.transaction(() => {
      // Index new/changed files
      for (const { relPath, fullPath } of memoryFiles) {
        // Codex 10th-pass MEDIUM F5 + 11th-pass LOW F5: a real on-disk
        // file under a configured extraPath whose logical path collides
        // with the synthetic-chunk reserved prefix would, if indexed,
        // be skipped from the cleanup sweep AND routed through the
        // chunks table on read instead of the filesystem. Reject such
        // files here (don't index them at all) so the reserved prefix
        // stays exclusively owned by the synthetic indexer; count them
        // so doctor can surface the collision to a user who would
        // otherwise see a silent lockout.
        if (isSyntheticChunkPath(relPath)) {
          reservedPrefixSkipped++;
          continue;
        }
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, "utf-8");
          const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

          const existing = getFile.get(relPath) as { hash: string } | undefined;
          if (existing?.hash === hash) {
            unchanged++;
            continue;
          }

          // Re-index this file
          deleteChunks.run(relPath);
          deleteFts.run(relPath);
          upsertFile.run(relPath, hash, Math.floor(stat.mtimeMs), stat.size);

          const chunks = chunkMarkdown(content, relPath);
          // Phase 2 — derive provenance per file (deterministic from
          // path), reuse for every chunk in the file. Channel chunks
          // store the channel name; local chunks store "_local";
          // legacy/ambiguous store "_legacy". `source_chat_id` stays
          // null in Phase 2 (no DB row mapping yet — Phase 3+).
          const fileProv = deriveProvenance(relPath);
          let storedChannel: string;
          if (fileProv.class.kind === "channel") {
            storedChannel = fileProv.class.sourceChannel;
          } else if (fileProv.class.kind === "local") {
            storedChannel = "_local";
          } else {
            storedChannel = "_legacy";
          }
          const storedChatId: string | null =
            fileProv.class.kind === "channel"
              ? fileProv.class.sourceChatId
              : null;
          for (const chunk of chunks) {
            insertChunk.run(
              chunk.id,
              chunk.path,
              chunk.startLine,
              chunk.endLine,
              chunk.text,
              chunk.hash,
              storedChannel,
              storedChatId
            );
            insertFts.run(
              chunk.text,
              chunk.id,
              chunk.path,
              chunk.startLine,
              chunk.endLine
            );
          }
          indexed++;
        } catch {
          // Skip unreadable files
        }
      }

      // Remove stale files
      const allPaths = this.db
        .prepare("SELECT path FROM files")
        .all() as Array<{ path: string }>;
      for (const { path: dbPath } of allPaths) {
        // Phase 4a-2.6 — synthetic per-chat chunks have no on-disk
        // file. Skip them in this cleanup sweep; their lifecycle is
        // owned by `runMessagesDbIndexerTick` (upsert when (chat,
        // date) gets new rows; never deleted unless the upstream
        // messages.db forgets the rows, which we don't observe).
        if (isSyntheticChunkPath(dbPath)) continue;
        if (!currentPaths.has(dbPath)) {
          deleteChunks.run(dbPath);
          deleteFts.run(dbPath);
          deleteFile.run(dbPath);
          removed++;
        }
      }
    });

    try {
      transaction();
    } catch {
      // Transaction failed — DB may be locked or corrupt. Mark dirty for retry.
      return {
        indexed: 0,
        removed: 0,
        unchanged: 0,
        reservedPrefixSkipped: 0,
      };
    }
    this.dirty = false;
    // Codex 12th-pass LOW v11-F3: persist reserved-prefix collisions
    // so doctor can surface them.
    if (reservedPrefixSkipped > 0) {
      this.bumpIndexerMetric("reserved_prefix_skipped", reservedPrefixSkipped);
    }
    return { indexed, removed, unchanged, reservedPrefixSkipped };
  }

  /**
   * Mark database as dirty (needs re-sync before next search).
   */
  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Phase 4a-2.6 — upsert a synthetic chunk produced by the
   * messages.db indexer. Synthetic chunks have no on-disk file: their
   * content is rendered from upstream message rows. The path scheme
   * is `extra:claude-whatsapp/messages-db/<chat_id>/<YYYY-MM-DD>` so
   * the existing path-pattern provenance derivation lights up without
   * special cases (it returns `sourceChannel = "whatsapp"` from the
   * `claude-whatsapp` marker).
   *
   * Idempotent: replaces any prior chunks at the same path. The
   * `files` table gets a synthetic entry too so the FK on `chunks`
   * holds; mtime is upstream's max(ts) for that (chat,date), not
   * `Date.now()`, to make the chunk content-addressable across
   * re-runs.
   */
  upsertSyntheticChunk(args: {
    /** Logical path: `extra:claude-whatsapp/messages-db/<chat_id>/<date>` */
    path: string;
    /** Channel, currently always "whatsapp". */
    sourceChannel: string;
    /** Per-row chat id (full JID). */
    sourceChatId: string;
    /** Rendered chunk text — concatenated message rows for that (chat, date). */
    text: string;
    /** Upstream max(ts) seconds; coerced to ms for `files.mtime`. */
    upstreamMaxTs: number;
  }): boolean {
    const { path: relPath, sourceChannel, sourceChatId, text, upstreamMaxTs } =
      args;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const size = Buffer.byteLength(text, "utf-8");
    // Codex 15th-pass LOW v14-F2 + 16th-pass v15-F1: numeric guard at
    // the boundary. `Number.isFinite` rejects Infinity/NaN. The cap
    // at `MAX_VALID_TS_SEC` (last second of year 9999) closes the
    // post-guard multiplication overflow path Codex 16 flagged: a
    // large-but-finite `upstreamMaxTs` would have produced `safeTs *
    // 1000 === Infinity`, which then binds into `files.mtime` as
    // REAL. Mirrors the reader-side cap in `lib/scope/messages-db.ts`.
    const MAX_VALID_TS_SEC = 253_402_300_799;
    const safeTs =
      Number.isFinite(upstreamMaxTs) && upstreamMaxTs > 0
        ? Math.min(MAX_VALID_TS_SEC, Math.floor(upstreamMaxTs))
        : 0;
    const mtimeMs = safeTs * 1000;

    const lines = text.length > 0 ? text.split("\n").length : 0;
    // Single chunk per (chat,date) — start_line/end_line span the
    // whole rendered text. id is deterministic so re-renders update
    // in place rather than accumulating.
    const chunkId = `synthetic:${sourceChannel}:${sourceChatId}:${
      relPath.split("/").pop() ?? "unknown"
    }`;

    const txn = this.db.transaction(() => {
      // Files row (FK target)
      this.db
        .prepare(
          `INSERT OR REPLACE INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)`
        )
        .run(relPath, hash, mtimeMs, size);

      // Drop any prior chunks for this path before re-inserting.
      this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(relPath);
      this.db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(relPath);

      this.db
        .prepare(
          `INSERT INTO chunks
             (id, path, start_line, end_line, text, hash, source_channel, source_chat_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(chunkId, relPath, 1, Math.max(1, lines), text, hash, sourceChannel, sourceChatId);

      this.db
        .prepare(
          `INSERT INTO chunks_fts (text, id, path, start_line, end_line) VALUES (?, ?, ?, ?, ?)`
        )
        .run(text, chunkId, relPath, 1, Math.max(1, lines));
    });

    // Codex 9th-pass MEDIUM F5: propagate success so the indexer can
    // hold its cursor on partial failure rather than silently dropping
    // the rows that fed this pair.
    try {
      txn();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Phase 4a-2.6 — reads back the rendered text for a synthetic
   * chunk path. Used by `readFile` (`memory_get`) so the agent can
   * page through a chat-day after a search hit. There's no underlying
   * disk file; the chunks table IS the source of truth.
   */
  readSyntheticChunkText(relPath: string): string | null {
    try {
      const row = this.db
        .prepare(`SELECT text FROM chunks WHERE path = ? LIMIT 1`)
        .get(relPath) as { text: string } | undefined;
      return row?.text ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Phase 4a-2.6 — read/write helpers for the indexer's per-channel
   * rowid cursor. Separate from `chunks`/`files` so a future
   * different-channel indexer can also persist without colliding.
   * Idempotent table creation lives here so callers don't need to
   * coordinate ordering with `initSchema`.
   */
  getIndexerCursor(channel: string): number {
    this.ensureIndexerCursorTable();
    try {
      const row = this.db
        .prepare(`SELECT last_rowid FROM scope_indexer_cursors WHERE channel = ?`)
        .get(channel) as { last_rowid: number } | undefined;
      return row?.last_rowid ?? 0;
    } catch {
      return 0;
    }
  }

  setIndexerCursor(channel: string, lastRowid: number): void {
    this.ensureIndexerCursorTable();
    // Codex 15th-pass LOW v14-F1: better-sqlite3 binds JS numbers as
    // `sqlite3_bind_double`, so `Infinity`/`NaN` would be stored as
    // REAL under INTEGER affinity. The cursor would then read back as
    // Infinity and the indexer's `rowid > cursor` predicate would
    // skip every later row — silent data loss. Normalize at the
    // boundary; sibling guards live in `bumpIndexerMetric` (v14-F2)
    // and `advanceIndexerCursorAtomic` (v14-F2).
    //
    // Codex 17th-pass LOW F3: cap at MAX_SAFE_INTEGER (SQLite INTEGER
    // is 64-bit but JS doubles lose integer precision past 2^53), and
    // reject regressions — a hostile/buggy upstream that planted a
    // huge raw rowid (now filtered in `readBatchWithMaxRowid`) or any
    // explicit `setIndexerCursor` call with a smaller value must not
    // walk the cursor backward, otherwise we'd silently re-process
    // rows already indexed (duplicate synthetic chunks).
    const safeRowid =
      Number.isFinite(lastRowid) && lastRowid > 0
        ? Math.min(Math.floor(lastRowid), Number.MAX_SAFE_INTEGER)
        : 0;
    const current = this.getIndexerCursor(channel);
    if (safeRowid < current) return;
    try {
      this.db
        .prepare(
          `INSERT INTO scope_indexer_cursors (channel, last_rowid, updated_ms)
           VALUES (?, ?, ?)
           ON CONFLICT (channel) DO UPDATE SET last_rowid = excluded.last_rowid,
                                                updated_ms = excluded.updated_ms`
        )
        .run(channel, safeRowid, Date.now());
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v13 (Codex 13th-pass MEDIUM v12-F2): atomic cursor
   * advance + metric bumps. v12 advanced the cursor and bumped the
   * `pairs_capped` metric in two separate `try` blocks; a process
   * crash between them left the truncation un-recorded while the
   * cursor moved past those rows. This combined transaction keeps
   * cursor + metric coherent — either both land or neither does.
   */
  advanceIndexerCursorAtomic(
    channel: string,
    lastRowid: number,
    metricBumps: Array<{
      metric: "pairs_capped" | "reserved_prefix_skipped";
      amount: number;
    }>
  ): void {
    this.ensureIndexerCursorTable();
    this.ensureIndexerMetricsTable();
    const upsertCursor = this.db.prepare(
      `INSERT INTO scope_indexer_cursors (channel, last_rowid, updated_ms)
       VALUES (?, ?, ?)
       ON CONFLICT (channel) DO UPDATE SET last_rowid = excluded.last_rowid,
                                            updated_ms = excluded.updated_ms`
    );
    const upsertMetric = this.db.prepare(
      `INSERT INTO scope_indexer_metrics (metric, value, updated_ms)
       VALUES (?, ?, ?)
       ON CONFLICT (metric) DO UPDATE SET value = scope_indexer_metrics.value + excluded.value,
                                            updated_ms = excluded.updated_ms`
    );
    const now = Date.now();
    // Codex 15th-pass LOW v14-F1: same guard as `setIndexerCursor`
    // applied here too — `lastRowid = Infinity` would otherwise be
    // bound as `sqlite3_bind_double` and read back as Infinity,
    // breaking the indexer's `rowid > cursor` predicate.
    // Codex 17th-pass LOW F3: cap at MAX_SAFE_INTEGER and reject
    // regression. Reading `current` before the txn is fine because
    // SQLite serializes writes per-connection — no concurrent
    // `setIndexerCursor` can race in between.
    const safeRowid =
      Number.isFinite(lastRowid) && lastRowid > 0
        ? Math.min(Math.floor(lastRowid), Number.MAX_SAFE_INTEGER)
        : 0;
    const current = this.getIndexerCursor(channel);
    const cursorTarget = safeRowid < current ? current : safeRowid;
    const txn = this.db.transaction(() => {
      upsertCursor.run(channel, cursorTarget, now);
      for (const { metric, amount } of metricBumps) {
        // Codex 14th-pass LOW v13-F2: same guard as bumpIndexerMetric.
        // Without `Number.isFinite`, `Infinity`/`NaN` would propagate
        // into SQLite as REAL under INTEGER affinity (or trigger a
        // NOT NULL failure that gets silently caught at the txn level
        // — losing the cursor advance too).
        if (Number.isFinite(amount) && amount > 0) {
          upsertMetric.run(metric, Math.floor(amount), now);
        }
      }
    });
    try {
      txn();
    } catch {
      // best-effort: indexer retries on next cycle
    }
  }

  /**
   * Phase 4a-2.6 v12 (Codex 12th-pass LOW v11-F3): cumulative metrics
   * the indexer/sync emit so doctor can surface "X chat-days were
   * truncated by the per-pair cap" or "Y on-disk files collided with
   * the synthetic-prefix and were skipped". Reset isn't supported
   * by design — they're append-only counters until the user clears
   * `.memory.sqlite` themselves.
   */
  bumpIndexerMetric(
    metric:
      | "pairs_capped"
      | "reserved_prefix_skipped"
      | "scoped_unknown_channel_skipped",
    amount: number
  ): void {
    // Codex 14th-pass LOW v13-F2: reject non-finite / NaN / negative
    // / zero amounts at the door so they can never reach SQLite
    // (where REAL-affinity coercion stores `Infinity` and NOT NULL
    // failures silently swallow under the `catch`).
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.ensureIndexerMetricsTable();
    try {
      this.db
        .prepare(
          `INSERT INTO scope_indexer_metrics (metric, value, updated_ms)
           VALUES (?, ?, ?)
           ON CONFLICT (metric) DO UPDATE SET value = scope_indexer_metrics.value + excluded.value,
                                                updated_ms = excluded.updated_ms`
        )
        .run(metric, Math.floor(amount), Date.now());
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v12: read a cumulative metric. Returns 0 if the
   * table doesn't exist yet OR the metric was never bumped. Used by
   * doctor.
   */
  getIndexerMetric(
    metric:
      | "pairs_capped"
      | "reserved_prefix_skipped"
      | "scoped_unknown_channel_skipped"
  ): number {
    this.ensureIndexerMetricsTable();
    try {
      const row = this.db
        .prepare(`SELECT value FROM scope_indexer_metrics WHERE metric = ?`)
        .get(metric) as { value: number } | undefined;
      return row?.value ?? 0;
    } catch {
      return 0;
    }
  }

  private ensureIndexerMetricsTable(): void {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS scope_indexer_metrics (
           metric TEXT PRIMARY KEY,
           value INTEGER NOT NULL DEFAULT 0,
           updated_ms INTEGER NOT NULL
         )`
      );
    } catch {
      // best-effort
    }
  }

  private ensureIndexerCursorTable(): void {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS scope_indexer_cursors (
           channel TEXT PRIMARY KEY,
           last_rowid INTEGER NOT NULL,
           updated_ms INTEGER NOT NULL
         )`
      );
      // Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: persist a throttle
      // timestamp per channel so the reconciliation pass (which walks
      // recent synthetic chunks to detect upstream delete/edit-only
      // writes that the rowid-append-only scan would miss) doesn't
      // run on every fire-and-forget tick. Idempotent ALTER — silently
      // fails when the column exists. Cross-connection PRAGMA
      // data_version isn't usable here because it resets per
      // connection and the indexer opens a fresh handle each tick.
      try {
        this.db.exec(
          `ALTER TABLE scope_indexer_cursors ADD COLUMN last_reconcile_ms INTEGER`
        );
      } catch {
        // column already present
      }
      // Phase 4a-2.6 v18 — Codex 18th-pass HIGH F3: persist upstream
      // DB identity (inode + size + ctime) so a fresh `messages.db`
      // (e.g. user removed/restored their WhatsApp pair) doesn't
      // leave the cursor stuck past the new file's max rowid. The
      // regression-rejection guard from v17 explicitly refuses to
      // walk the cursor backward, so without an identity reset the
      // indexer would silently skip every row of the new DB forever.
      try {
        this.db.exec(
          `ALTER TABLE scope_indexer_cursors ADD COLUMN db_identity TEXT`
        );
      } catch {
        // column already present
      }
      // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: persist the `id`
      // column value of the row at `last_rowid` so the next tick can
      // detect rowid reuse. SQLite's `INTEGER PRIMARY KEY` without
      // `AUTOINCREMENT` reuses the deleted-max rowid for the next
      // INSERT, so a `WHERE rowid > cursor` predicate would silently
      // skip the new row. We verify the cursor row's `id` matches
      // what we last saw; if it doesn't, the row was deleted and
      // replaced and we walk back to `cursor - 1`.
      try {
        this.db.exec(
          `ALTER TABLE scope_indexer_cursors ADD COLUMN cursor_row_id TEXT`
        );
      } catch {
        // column already present
      }
      // Phase 4a-2.6 v19 — Codex 19th-pass HIGH F3: track the last
      // tick at which `openMessagesDb` succeeded for this channel.
      // Used to bound the PII grace window: when the upstream DB has
      // been confirmed-absent (ENOENT) for longer than the grace
      // window, the channel's synthetic chunks are quarantined
      // (hard-deleted) so we never serve searchable text for messages
      // the upstream user has removed.
      try {
        this.db.exec(
          `ALTER TABLE scope_indexer_cursors ADD COLUMN last_open_ms INTEGER`
        );
      } catch {
        // column already present
      }
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v18 — Codex 18th-pass HIGH F3: read/write the
   * persisted upstream DB identity for a channel. Identity is an
   * opaque caller-provided string (typically `ino:size:ctimeMs`).
   * Comparison is a straight equality check; mismatch ⇒ caller should
   * reset cursor + reconcile state.
   */
  getIndexerDbIdentity(channel: string): string | null {
    this.ensureIndexerCursorTable();
    try {
      const row = this.db
        .prepare(
          `SELECT db_identity FROM scope_indexer_cursors WHERE channel = ?`
        )
        .get(channel) as { db_identity: string | null } | undefined;
      return row?.db_identity ?? null;
    } catch {
      return null;
    }
  }

  setIndexerDbIdentity(channel: string, identity: string): void {
    this.ensureIndexerCursorTable();
    if (typeof identity !== "string" || identity.length === 0) return;
    try {
      this.db
        .prepare(
          `INSERT INTO scope_indexer_cursors (channel, last_rowid, db_identity, updated_ms)
           VALUES (?, COALESCE((SELECT last_rowid FROM scope_indexer_cursors WHERE channel = ?), 0), ?, ?)
           ON CONFLICT (channel) DO UPDATE SET db_identity = excluded.db_identity,
                                                 updated_ms = excluded.updated_ms`
        )
        .run(channel, channel, identity, Date.now());
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v18 — Codex 18th-pass HIGH F3: hard-reset the cursor
   * + last_reconcile_ms for a channel after a DB identity change.
   * Synthetic chunks from the old DB are NOT deleted here — the
   * rotation pass will reconcile them naturally (returning `absent`
   * for any pair the new DB doesn't have). Cursor goes to 0 so the
   * indexer drains the new DB from the top.
   *
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: also clears the
   * cursor row id so the next tick doesn't compare against a stale
   * identity from a different DB.
   */
  resetIndexerCursorState(channel: string): void {
    this.ensureIndexerCursorTable();
    try {
      this.db
        .prepare(
          `UPDATE scope_indexer_cursors
              SET last_rowid = 0,
                  last_reconcile_ms = 0,
                  cursor_row_id = NULL,
                  updated_ms = ?
            WHERE channel = ?`
        )
        .run(Date.now(), channel);
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F2: read/write the `id`
   * of the upstream row at `last_rowid`, used to detect rowid reuse
   * across ticks.
   */
  getIndexerCursorRowId(channel: string): string | null {
    this.ensureIndexerCursorTable();
    try {
      const row = this.db
        .prepare(
          `SELECT cursor_row_id FROM scope_indexer_cursors WHERE channel = ?`
        )
        .get(channel) as { cursor_row_id: string | null } | undefined;
      return row?.cursor_row_id ?? null;
    } catch {
      return null;
    }
  }

  setIndexerCursorRowId(channel: string, rowId: string | null): void {
    this.ensureIndexerCursorTable();
    try {
      this.db
        .prepare(
          `INSERT INTO scope_indexer_cursors (channel, last_rowid, cursor_row_id, updated_ms)
           VALUES (?, COALESCE((SELECT last_rowid FROM scope_indexer_cursors WHERE channel = ?), 0), ?, ?)
           ON CONFLICT (channel) DO UPDATE SET cursor_row_id = excluded.cursor_row_id,
                                                 updated_ms = excluded.updated_ms`
        )
        .run(channel, channel, rowId, Date.now());
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F3: read/write the wall
   * clock (ms) of the last tick where `openMessagesDb` succeeded. The
   * indexer's PII-quarantine pass uses this to decide whether the
   * upstream DB has been absent long enough to justify hard-deleting
   * the channel's synthetic chunks. Returns null when never set.
   */
  getIndexerLastOpenMs(channel: string): number | null {
    this.ensureIndexerCursorTable();
    try {
      const row = this.db
        .prepare(
          `SELECT last_open_ms FROM scope_indexer_cursors WHERE channel = ?`
        )
        .get(channel) as { last_open_ms: number | null } | undefined;
      return row?.last_open_ms ?? null;
    } catch {
      return null;
    }
  }

  setIndexerLastOpenMs(channel: string, atMs: number): void {
    this.ensureIndexerCursorTable();
    if (!Number.isFinite(atMs) || atMs < 0) return;
    const safe = Math.min(Math.floor(atMs), Number.MAX_SAFE_INTEGER);
    try {
      this.db
        .prepare(
          `INSERT INTO scope_indexer_cursors (channel, last_rowid, last_open_ms, updated_ms)
           VALUES (?, COALESCE((SELECT last_rowid FROM scope_indexer_cursors WHERE channel = ?), 0), ?, ?)
           ON CONFLICT (channel) DO UPDATE SET last_open_ms = excluded.last_open_ms,
                                                 updated_ms = excluded.updated_ms`
        )
        .run(channel, channel, safe, Date.now());
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v20 — Codex 20th-pass HIGH F1: count synthetic
   * chunks already indexed for a channel. Used by the indexer to
   * detect "had prior access" on a v18→v19 upgrade where
   * `last_open_ms` was never seeded by v18 code: existing chunks
   * imply we DID have a working DB at some point, so a
   * confirmed-absent DB still warrants quarantine.
   */
  countSyntheticChunksForChannel(channel: string): number {
    const prefix = `extra:${channel === "whatsapp" ? "claude-whatsapp" : channel}/messages-db/`;
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM files WHERE path LIKE ? || '%'`
        )
        .get(prefix) as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Phase 4a-2.6 v19 — Codex 19th-pass HIGH F3: hard-delete every
   * synthetic chunk for a channel (chunks + chunks_fts + files +
   * scope_synthetic_reconcile). Used when the upstream DB has been
   * confirmed absent (ENOENT) past the quarantine grace window so
   * we don't serve stale-PII via `memory_search` indefinitely.
   * Returns the number of paths deleted.
   */
  purgeAllSyntheticChunksForChannel(channel: string): number {
    this.ensureSyntheticReconcileTable();
    const prefix = `extra:${channel === "whatsapp" ? "claude-whatsapp" : channel}/messages-db/`;
    let count = 0;
    try {
      const rows = this.db
        .prepare(`SELECT path FROM files WHERE path LIKE ? || '%'`)
        .all(prefix) as Array<{ path: string }>;
      const txn = this.db.transaction(() => {
        for (const r of rows) {
          this.db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(r.path);
          this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(r.path);
          this.db.prepare(`DELETE FROM files WHERE path = ?`).run(r.path);
          this.db
            .prepare(`DELETE FROM scope_synthetic_reconcile WHERE path = ?`)
            .run(r.path);
          count++;
        }
      });
      txn();
    } catch {
      // best-effort — count reflects rows attempted, not guaranteed gone
    }
    return count;
  }

  /**
   * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: timestamp of the last
   * reconciliation pass for this channel. Returns null when the
   * channel has never been reconciled (or never ticked). Indexer
   * gates reconciliation on `(now - last_reconcile_ms) > throttleMs`
   * so the fire-and-forget search-hot-path tick doesn't pay the
   * RECONCILE_LIMIT × per-pair-query cost on every call.
   */
  getIndexerLastReconcileMs(channel: string): number | null {
    this.ensureIndexerCursorTable();
    try {
      const row = this.db
        .prepare(
          `SELECT last_reconcile_ms FROM scope_indexer_cursors WHERE channel = ?`
        )
        .get(channel) as { last_reconcile_ms: number | null } | undefined;
      return row?.last_reconcile_ms ?? null;
    } catch {
      return null;
    }
  }

  setIndexerLastReconcileMs(channel: string, atMs: number): void {
    this.ensureIndexerCursorTable();
    if (!Number.isFinite(atMs) || atMs < 0) return;
    const safe = Math.min(Math.floor(atMs), Number.MAX_SAFE_INTEGER);
    try {
      this.db
        .prepare(
          `INSERT INTO scope_indexer_cursors (channel, last_rowid, last_reconcile_ms, updated_ms)
           VALUES (?, COALESCE((SELECT last_rowid FROM scope_indexer_cursors WHERE channel = ?), 0), ?, ?)
           ON CONFLICT (channel) DO UPDATE SET last_reconcile_ms = excluded.last_reconcile_ms,
                                                 updated_ms = excluded.updated_ms`
        )
        .run(channel, channel, safe, Date.now());
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: list synthetic chunk
   * paths for a channel for reconciliation.
   *
   * Phase 4a-2.6 v18 — Codex 18th-pass HIGH F2: rotation. Pre-v18 we
   * always returned the 50-most-recent chunks by upstream mtime, so
   * any installation with >50 indexed (chat, date) chunks could
   * never reconcile chunks ranked 51+ by mtime. A delete or edit on
   * an older chat-day stayed visible in `memory_search` indefinitely.
   *
   * v18 picks oldest-unchecked first via a separate
   * `scope_synthetic_reconcile(path, last_checked_ms)` table joined
   * via LEFT JOIN. NULL `last_checked_ms` (never checked) ranks
   * before any value, so newly-written chunks get reconciled in
   * their first eligible pass; rotated paths get re-walked in
   * order of their last reconcile timestamp. The full set of
   * indexed (chat, date) chunks is visited over successive passes.
   */
  listSyntheticChunkPathsForChannel(
    channel: string,
    limit: number
  ): string[] {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const cap = Math.min(Math.floor(limit), 5000);
    this.ensureSyntheticReconcileTable();
    const prefix = `extra:${channel === "whatsapp" ? "claude-whatsapp" : channel}/messages-db/`;
    try {
      const rows = this.db
        .prepare(
          `SELECT files.path AS path
             FROM files
             LEFT JOIN scope_synthetic_reconcile r ON r.path = files.path
            WHERE files.path LIKE ? || '%'
            ORDER BY r.last_checked_ms IS NULL DESC,
                     r.last_checked_ms ASC,
                     files.mtime DESC
            LIMIT ?`
        )
        .all(prefix, cap) as Array<{ path: string }>;
      return rows.map((r) => r.path);
    } catch {
      return [];
    }
  }

  /**
   * Phase 4a-2.6 v18 — Codex 18th-pass HIGH F2: marker write for the
   * rotation table. Called by the indexer after reconciling a path,
   * so the next pass picks a different one. Idempotent upsert.
   */
  markSyntheticChunkReconciled(relPath: string, atMs?: number): void {
    if (!isSyntheticChunkPath(relPath)) return;
    this.ensureSyntheticReconcileTable();
    const ts =
      typeof atMs === "number" && Number.isFinite(atMs) && atMs >= 0
        ? Math.min(Math.floor(atMs), Number.MAX_SAFE_INTEGER)
        : Date.now();
    try {
      this.db
        .prepare(
          `INSERT INTO scope_synthetic_reconcile (path, last_checked_ms)
           VALUES (?, ?)
           ON CONFLICT (path) DO UPDATE SET last_checked_ms = excluded.last_checked_ms`
        )
        .run(relPath, ts);
    } catch {
      // best-effort
    }
  }

  private ensureSyntheticReconcileTable(): void {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS scope_synthetic_reconcile (
           path TEXT PRIMARY KEY,
           last_checked_ms INTEGER NOT NULL
         )`
      );
    } catch {
      // best-effort
    }
  }

  /**
   * Phase 4a-2.6 v17 — Codex 17th-pass HIGH F1: hard-delete a synthetic
   * chunk + its FTS row + the synthetic `files` entry. Used by the
   * reconciliation pass when upstream returns zero rows for a (chat,
   * date) pair previously indexed (i.e. all messages for that day
   * were deleted upstream).
   */
  deleteSyntheticChunk(relPath: string): boolean {
    if (!isSyntheticChunkPath(relPath)) return false;
    this.ensureSyntheticReconcileTable();
    const txn = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(relPath);
      this.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(relPath);
      this.db.prepare(`DELETE FROM files WHERE path = ?`).run(relPath);
      // v18 F2: clear the rotation marker so a future re-index of the
      // same (chat,date) pair starts with a NULL last_checked_ms and
      // reconciles in its first eligible pass.
      this.db
        .prepare(`DELETE FROM scope_synthetic_reconcile WHERE path = ?`)
        .run(relPath);
    });
    try {
      txn();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Search memory using FTS5 with BM25 ranking + temporal decay + MMR.
   * Mirrors OpenClaw's hybrid search (FTS component).
   */
  search(
    query: string,
    options?: {
      maxResults?: number;
      minScore?: number;
      enableDecay?: boolean;
      halfLifeDays?: number;
      enableMMR?: boolean;
      mmrLambda?: number;
      /**
       * Phase 4a-1 — optional SQL pre-filter from
       * `lib/scope/filter.ts:buildSqlPreFilter`. Empty `whereSql`
       * means no filter; non-empty injects `AND <whereSql>` into
       * the FTS5 query with bound parameters appended after the
       * MATCH parameter. Pre-filter never bypasses MMR / decay.
       */
      sqlPreFilter?: { whereSql: string; params: string[] };
      /**
       * Phase 4a-1 — over-fetch multiplier for the candidate pool
       * when scope enforcement may drop a large fraction. Caller
       * post-filters with `filterScopedResults` then trims to
       * `maxResults`. Capped at 8x by callers.
       */
      candidateOverfetch?: number;
    }
  ): SearchResult[] {
    // Sync if dirty
    if (this.dirty) {
      this.sync();
    }

    const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE;
    const enableDecay = options?.enableDecay ?? true;
    const halfLifeDays = options?.halfLifeDays ?? 30;
    const enableMMR = options?.enableMMR ?? true;
    const mmrLambda = options?.mmrLambda ?? 0.7;
    const overfetch = Math.max(1, Math.min(8, options?.candidateOverfetch ?? 1));

    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    // FTS5 search with BM25 ranking
    // Fetch more candidates than needed for MMR to work with
    const candidateMultiplier = (enableMMR ? 4 : 1) * overfetch;
    const candidateLimit = maxResults * candidateMultiplier;

    let rows: Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      rank: number;
      source_channel: string | null;
      source_chat_id: string | null;
    }>;

    const pre = options?.sqlPreFilter;
    const extraWhere = pre && pre.whereSql ? ` AND ${pre.whereSql}` : "";

    try {
      rows = this.db
        .prepare(
          `SELECT
            chunks_fts.id,
            chunks_fts.path,
            chunks_fts.start_line,
            chunks_fts.end_line,
            chunks.text,
            chunks.source_channel,
            chunks.source_chat_id,
            rank
          FROM chunks_fts
          JOIN chunks ON chunks.id = chunks_fts.id
          WHERE chunks_fts MATCH ?${extraWhere}
          ORDER BY rank
          LIMIT ?`
        )
        .all(ftsQuery, ...(pre?.params ?? []), candidateLimit) as typeof rows;
    } catch {
      // FTS query syntax error — fall back to no results
      return [];
    }

    if (rows.length === 0) return [];

    // Convert BM25 rank to [0, 1] score (rank is negative, lower = better)
    const now = new Date();
    let results: SearchResult[] = rows.map((row) => {
      // BM25 rank → score: 1 / (1 + abs(rank))
      let score = 1 / (1 + Math.abs(row.rank));

      // Apply temporal decay
      if (enableDecay) {
        score *= getDecayMultiplier(row.path, now, halfLifeDays);
      }

      // Truncate snippet
      let snippet = row.text;
      if (snippet.length > MAX_SNIPPET_CHARS) {
        snippet = snippet.slice(0, MAX_SNIPPET_CHARS - 3) + "...";
      }

      // Phase 2 — passive provenance metadata. Codex P1 5a: prefer
      // stored row values (source_channel + source_chat_id) when
      // present so Phase 3+ row-level enrichment from messages.db
      // isn't dropped on every search. Fall back to path derivation
      // when the row hasn't been backfilled yet (NULL columns).
      let provenance = deriveProvenance(row.path);
      if (
        row.source_channel &&
        row.source_channel !== "_local" &&
        row.source_channel !== "_legacy"
      ) {
        // Stored channel comes from the migration path-pattern stage
        // (or, in Phase 3+, from messages.db enrichment). Either way,
        // it's at least as authoritative as a fresh derive.
        provenance = enrichProvenanceWithDbRow(provenance, {
          chat_id: row.source_chat_id ?? undefined,
        });
      }
      const scopeToken = issueScopeToken(provenance);

      return {
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        snippet,
        score,
        citation: `${row.path}#L${row.start_line}-L${row.end_line}`,
        provenance,
        scopeToken,
      };
    });

    // Filter by minimum score
    results = results.filter((r) => r.score >= minScore);

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Apply MMR for diversity. Codex P1 fix (Phase 4a-1 review): when
    // the caller asked for over-fetch (scope-armed search), we must
    // RETAIN that slack here so the post-filter has chunks to refill
    // from after dropping denied ones. The previous trim to
    // `maxResults` defeated the over-fetch and could leave a heavily-
    // denied channel returning short. The unarmed path is unchanged
    // (overfetch defaults to 1, so finalCount === maxResults).
    const finalCount = maxResults * overfetch;
    if (enableMMR && results.length > 1) {
      results = applyMMR(results, finalCount, mmrLambda);
    } else {
      results = results.slice(0, finalCount);
    }

    return results;
  }

  /**
   * Resolve a logical path (e.g. "extra:whatsapp/2026-04-09.md") to an
   * absolute path. Returns null if the path can't be safely contained
   * in one of the configured roots.
   *
   * Phase 2 — uses `resolveContainedPath` from `lib/scope/provenance.ts`
   * for separator-safe + symlink-resolved + fail-closed containment.
   * The previous implementation's `startsWith` check could false-
   * positive on `/foo/bar` vs `/foo/barX` and didn't resolve symlinks.
   */
  private resolveLogicalPath(relPath: string): string | null {
    if (relPath.startsWith("extra:")) {
      return resolveContainedPath(relPath, this.extraPaths);
    }
    // Workspace-relative — must be contained under pluginRoot.
    return resolveContainedPath(relPath, [this.pluginRoot]);
  }

  /**
   * Read a memory file with optional line range.
   * Mirrors OpenClaw's memory_get.
   */
  readFile(
    relPath: string,
    from?: number,
    lineCount?: number
  ): { text: string; path: string } | { error: string } {
    // Phase 4a-2.6 — synthetic per-chat chunks have no on-disk file.
    // The chunks table IS the source. Detect the path scheme and
    // return the rendered text directly. The scope filter still gated
    // the search hit upstream; this is just retrieval.
    //
    // Codex 10th-pass MEDIUM F5: route via the canonical exact-prefix
    // helper instead of the v9-era substring check. Otherwise a real
    // extraPath whose directory tree includes `messages-db/` would be
    // routed through the chunks table on read while the on-disk file
    // exists — confusing AND a privacy regression because
    // `assertCanReadPath` upstream would have applied path-pattern
    // gates that don't match the extra-channel prefix expected here.
    if (isSyntheticChunkPath(relPath)) {
      const text = this.readSyntheticChunkText(relPath);
      if (text === null) {
        return { error: "Path outside workspace" };
      }
      const lines = text.split("\n");
      if (from !== undefined) {
        const start = Math.max(0, from - 1);
        const count = lineCount || 50;
        const sliced = lines.slice(start, start + count);
        return { text: sliced.join("\n"), path: relPath };
      }
      return { text, path: relPath };
    }

    // Security: resolve with extra: prefix support
    const fullPath = this.resolveLogicalPath(relPath);
    if (!fullPath) {
      return { error: "Path outside workspace" };
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");

      if (from !== undefined) {
        const start = Math.max(0, from - 1);
        const count = lineCount || 50;
        const sliced = lines.slice(start, start + count);
        return {
          text: sliced.map((l, i) => `${start + i + 1}\t${l}`).join("\n"),
          path: relPath,
        };
      }

      return {
        text: lines.map((l, i) => `${i + 1}\t${l}`).join("\n"),
        path: relPath,
      };
    } catch {
      return { error: `File not found: ${relPath}` };
    }
  }

  /**
   * Get stats about the memory database.
   */
  stats(): { files: number; chunks: number; totalSize: number } {
    const files = (
      this.db.prepare("SELECT COUNT(*) as count FROM files").get() as {
        count: number;
      }
    ).count;
    const chunks = (
      this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as {
        count: number;
      }
    ).count;
    const totalSize = (
      this.db
        .prepare("SELECT COALESCE(SUM(size), 0) as total FROM files")
        .get() as { total: number }
    ).total;
    return { files, chunks, totalSize };
  }

  close(): void {
    // Codex 13th-pass LOW v12-F4: release fs.watch handles before
    // the SQLite handle. Best-effort — node's FSWatcher.close() is
    // idempotent and never throws, but wrap anyway for paranoia.
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* best-effort */
      }
    }
    this.watchers = [];
    this.db.close();
  }
}
