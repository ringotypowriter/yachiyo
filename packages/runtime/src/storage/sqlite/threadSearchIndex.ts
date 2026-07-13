import { FTS_TOKENIZE } from '../ftsQuery.ts'
import type { BetterSqlite3Client } from './sqliteRuntime.ts'

// ---------------------------------------------------------------------------
// FTS5 thread/message search index
// ---------------------------------------------------------------------------

// FTS5 external-content triggers MUST pass the exact same column values
// that the 'rebuild' command stores.  FTS5 rebuild reads raw column values
// from the content table, so the triggers must also use raw values — no
// COALESCE or other transforms.  A mismatch (e.g. NULL vs '') between the
// stored FTS entry and the trigger's 'delete' payload corrupts the shadow
// tables and causes "database disk image is malformed" on the next write.
const FTS_TRIGGER_DROP_DDL = `
  DROP TRIGGER IF EXISTS threads_fts_ai;
  DROP TRIGGER IF EXISTS threads_fts_ad;
  DROP TRIGGER IF EXISTS threads_fts_au;
  DROP TRIGGER IF EXISTS messages_fts_ai;
  DROP TRIGGER IF EXISTS messages_fts_ad;
  DROP TRIGGER IF EXISTS messages_fts_au;
`

// The trigram tokenizer (FTS_TOKENIZE, shared with the CLI via ftsQuery.ts)
// gives substring matching, which is what makes CJK text searchable:
// unicode61 turned an entire run of Han characters into a single token, so
// Chinese content only matched on exact whole-run queries.
const FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
    title,
    preview,
    content='threads',
    content_rowid='rowid',
    ${FTS_TOKENIZE}
  );

  CREATE TRIGGER IF NOT EXISTS threads_fts_ai AFTER INSERT ON threads BEGIN
    INSERT INTO threads_fts(rowid, title, preview)
    VALUES (new.rowid, new.title, new.preview);
  END;

  CREATE TRIGGER IF NOT EXISTS threads_fts_ad AFTER DELETE ON threads BEGIN
    INSERT INTO threads_fts(threads_fts, rowid, title, preview)
    VALUES ('delete', old.rowid, old.title, old.preview);
  END;

  CREATE TRIGGER IF NOT EXISTS threads_fts_au AFTER UPDATE OF title, preview ON threads BEGIN
    INSERT INTO threads_fts(threads_fts, rowid, title, preview)
    VALUES ('delete', old.rowid, old.title, old.preview);
    INSERT INTO threads_fts(rowid, title, preview)
    VALUES (new.rowid, new.title, new.preview);
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    ${FTS_TOKENIZE}
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
  END;
`

/**
 * Drop all FTS tables and triggers, then recreate from scratch.
 * Used when the FTS index is detected as corrupt to avoid blocking
 * subsequent writes that maintain the search index.
 */
function resetThreadSearchIndex(client: BetterSqlite3Client): void {
  client.exec(`
    ${FTS_TRIGGER_DROP_DDL}
    DROP TABLE IF EXISTS threads_fts;
    DROP TABLE IF EXISTS messages_fts;
  `)
  client.exec(FTS_DDL)
}

function countRows(client: BetterSqlite3Client, table: string): number {
  const row = client.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number }
  return row.count ?? 0
}

// COUNT(*) on an external-content FTS5 table reads through to the content
// table, so it can never detect an empty index. The _docsize shadow table
// holds one row per actually-indexed document.
function rebuildFtsTable(
  client: BetterSqlite3Client,
  ftsTable: string,
  backingTable: string
): void {
  const backingCount = countRows(client, backingTable)
  if (countRows(client, `${ftsTable}_docsize`) === 0 && backingCount > 0) {
    const startedAt = Date.now()
    client.prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES ('rebuild')`).run()
    console.warn(
      `[fts] rebuilt ${ftsTable} from ${backingTable} (${backingCount} rows in ${Date.now() - startedAt}ms)`
    )
  }
}

function ftsRebuildPending(client: BetterSqlite3Client): boolean {
  return (
    (countRows(client, 'threads_fts_docsize') === 0 && countRows(client, 'threads') > 0) ||
    (countRows(client, 'messages_fts_docsize') === 0 && countRows(client, 'messages') > 0)
  )
}

function rebuildAllFtsTables(client: BetterSqlite3Client): void {
  try {
    rebuildFtsTable(client, 'threads_fts', 'threads')
    rebuildFtsTable(client, 'messages_fts', 'messages')
  } catch (error) {
    // Rebuild failed — the FTS shadow tables are likely corrupt. Drop
    // everything and recreate so the triggers don't block normal writes.
    console.error('[fts] search index rebuild failed; resetting the index', error)
    resetThreadSearchIndex(client)
    try {
      rebuildFtsTable(client, 'threads_fts', 'threads')
      rebuildFtsTable(client, 'messages_fts', 'messages')
    } catch (retryError) {
      // Second rebuild also failed — leave the recreated empty index so the
      // app stays functional. Search is unavailable until the next restart.
      console.error(
        '[fts] search index rebuild failed twice; search stays empty until the next restart',
        retryError
      )
      try {
        resetThreadSearchIndex(client)
      } catch {
        // Database likely closed mid-rebuild (e.g. app shutdown).
      }
    }
  }
}

/**
 * One-time repair: for completed runs whose assistantMessageId points to a
 * message with a different parentMessageId than the run's requestMessageId,
 * update the run to match. This fixes stale requestMessageIds from steered
 * runs that were persisted before the fix was shipped.
 */
export function repairRunRequestMessageIds(client: BetterSqlite3Client): void {
  client
    .prepare(
      `UPDATE runs
       SET request_message_id = (
         SELECT m.parent_message_id FROM messages m WHERE m.id = runs.assistant_message_id
       )
       WHERE assistant_message_id IS NOT NULL
         AND request_message_id IS NOT NULL
         AND request_message_id != (
           SELECT m2.parent_message_id FROM messages m2 WHERE m2.id = runs.assistant_message_id
         )`
    )
    .run()
}

/**
 * True when an existing FTS table was created with a different tokenizer
 * (pre-trigram databases). The index must then be dropped and rebuilt —
 * FTS5 cannot retokenize in place.
 */
function hasStaleTokenizer(client: BetterSqlite3Client): boolean {
  const rows = client
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('threads_fts', 'messages_fts')`
    )
    .all() as Array<{ sql?: string }>
  return rows.some((row) => typeof row.sql === 'string' && !row.sql.includes(FTS_TOKENIZE))
}

export interface EnsureThreadSearchIndexOptions {
  /**
   * When provided, a pending full-index rebuild (tokenizer migration, or an
   * empty index behind a populated table) runs through this scheduler
   * instead of blocking the caller. The runtime boot path defers it so a
   * large re-index cannot freeze startup; search returns partial results
   * until the rebuild lands.
   */
  scheduleRebuild?: (rebuild: () => void) => void
}

export function ensureThreadSearchIndex(
  client: BetterSqlite3Client,
  options: EnsureThreadSearchIndexOptions = {}
): void {
  client.exec(FTS_TRIGGER_DROP_DDL)
  if (hasStaleTokenizer(client)) {
    console.warn('[fts] tokenizer changed; dropping the search index for a full re-index')
    resetThreadSearchIndex(client)
  }
  client.exec(FTS_DDL)

  if (options.scheduleRebuild && ftsRebuildPending(client)) {
    options.scheduleRebuild(() => rebuildAllFtsTables(client))
  } else {
    rebuildAllFtsTables(client)
  }
}
