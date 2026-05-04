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
const FTS_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
    title,
    preview,
    content='threads',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS threads_fts_ai AFTER INSERT ON threads BEGIN
    INSERT INTO threads_fts(rowid, title, preview)
    VALUES (new.rowid, new.title, new.preview);
  END;

  CREATE TRIGGER IF NOT EXISTS threads_fts_ad AFTER DELETE ON threads BEGIN
    INSERT INTO threads_fts(threads_fts, rowid, title, preview)
    VALUES ('delete', old.rowid, old.title, old.preview);
  END;

  CREATE TRIGGER IF NOT EXISTS threads_fts_au AFTER UPDATE ON threads BEGIN
    INSERT INTO threads_fts(threads_fts, rowid, title, preview)
    VALUES ('delete', old.rowid, old.title, old.preview);
    INSERT INTO threads_fts(rowid, title, preview)
    VALUES (new.rowid, new.title, new.preview);
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
  END;
`

/**
 * Drop all FTS tables and triggers, then recreate from scratch.
 * Used when the FTS index is detected as corrupt to avoid blocking
 * all subsequent writes (the triggers fire on every INSERT/UPDATE).
 */
function resetThreadSearchIndex(client: BetterSqlite3Client): void {
  client.exec(`
    DROP TRIGGER IF EXISTS threads_fts_ai;
    DROP TRIGGER IF EXISTS threads_fts_ad;
    DROP TRIGGER IF EXISTS threads_fts_au;
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
    DROP TABLE IF EXISTS threads_fts;
    DROP TABLE IF EXISTS messages_fts;
  `)
  client.exec(FTS_DDL)
}

function rebuildFtsTable(
  client: BetterSqlite3Client,
  ftsTable: string,
  backingTable: string
): void {
  const ftsCount = client.prepare(`SELECT COUNT(*) AS count FROM ${ftsTable}`).get() as {
    count?: number
  }
  const srcCount = client.prepare(`SELECT COUNT(*) AS count FROM ${backingTable}`).get() as {
    count?: number
  }
  if ((ftsCount.count ?? 0) === 0 && (srcCount.count ?? 0) > 0) {
    client.prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES ('rebuild')`).run()
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

export function ensureThreadSearchIndex(client: BetterSqlite3Client): void {
  client.exec(FTS_DDL)

  try {
    rebuildFtsTable(client, 'threads_fts', 'threads')
    rebuildFtsTable(client, 'messages_fts', 'messages')
  } catch {
    // Rebuild failed — the FTS shadow tables are likely corrupt.
    // Drop everything and recreate from scratch so the triggers don't
    // block normal database writes.
    resetThreadSearchIndex(client)
    try {
      rebuildFtsTable(client, 'threads_fts', 'threads')
      rebuildFtsTable(client, 'messages_fts', 'messages')
    } catch {
      // Second rebuild also failed — drop FTS entirely to keep the app
      // functional. Thread search will be unavailable until next restart.
      resetThreadSearchIndex(client)
    }
  }
}
