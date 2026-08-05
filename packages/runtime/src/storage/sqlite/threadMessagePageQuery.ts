import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm'
import type { SQLiteSelectQueryBuilder } from 'drizzle-orm/sqlite-core'

import { assertPageLimit } from '../messagePageWindow.ts'
import { messagesTable } from './schema.ts'

/**
 * Where a page ends, expressed the way sqlite orders rows.
 *
 * The id half is not decoration: `created_at` is a timestamp string, and two
 * messages in the same burst share one. Without the tie-break their relative
 * order is unspecified, and a message that moves across a page boundary
 * between two reads is either shown twice or lost.
 */
export interface ThreadMessagePageCursor {
  createdAt: string
  id: string
}

export interface ThreadMessagePageArgs {
  threadId: string
  /** Omit to read the whole thread; a page is opt-in. */
  limit?: number
  /** Omit to start at the newest message. */
  cursor?: ThreadMessagePageCursor
}

/** Rows strictly older than the cursor under `(created_at, id)` descending. */
function olderThanCursor(cursor: ThreadMessagePageCursor): SQL | undefined {
  return or(
    lt(messagesTable.createdAt, cursor.createdAt),
    and(eq(messagesTable.createdAt, cursor.createdAt), lt(messagesTable.id, cursor.id))
  )
}

/**
 * Bound a thread-message read in the database.
 *
 * The rows come back newest-first, because that is the end a page is anchored
 * at; the reader reverses them into reading order. Callers render a
 * conversation, not a reversed list.
 *
 * This is the one place the paging statement is assembled — the reader uses it
 * and so does its test, so what CI compiles is what production sends.
 */
export function buildThreadMessagePageQuery<TQuery extends SQLiteSelectQueryBuilder>(
  selected: TQuery,
  { threadId, limit, cursor }: ThreadMessagePageArgs
): TQuery {
  // Shared with the in-memory store, so the two implementations cannot drift
  // into disagreeing about which limits are legal.
  assertPageLimit(limit)

  const scoped = selected
    .where(and(eq(messagesTable.threadId, threadId), cursor ? olderThanCursor(cursor) : undefined))
    .orderBy(desc(messagesTable.createdAt), desc(messagesTable.id))

  return (limit === undefined ? scoped : scoped.limit(limit)) as TQuery
}
