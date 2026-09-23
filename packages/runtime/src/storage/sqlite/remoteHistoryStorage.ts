import { and, asc, eq } from 'drizzle-orm'
import type { YachiyoStorage } from '../storage.ts'
import type { SqliteDb } from './sqliteRuntime.ts'
import { messagesTable, toolCallsTable } from './schema.ts'

export function createSqliteRemoteHistoryStorageMethods(
  db: SqliteDb
): Pick<YachiyoStorage, 'listThreadMessageTopology' | 'hasThreadWaitingToolCall'> {
  return {
    listThreadMessageTopology(threadId) {
      return db
        .select({
          id: messagesTable.id,
          parentMessageId: messagesTable.parentMessageId,
          createdAt: messagesTable.createdAt,
          hidden: messagesTable.hidden
        })
        .from(messagesTable)
        .where(eq(messagesTable.threadId, threadId))
        .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id))
        .all()
        .map((row) => ({
          ...row,
          parentMessageId: row.parentMessageId ?? undefined,
          hidden: row.hidden ?? undefined
        }))
    },

    hasThreadWaitingToolCall(threadId) {
      return (
        db
          .select({ id: toolCallsTable.id })
          .from(toolCallsTable)
          .where(
            and(
              eq(toolCallsTable.threadId, threadId),
              eq(toolCallsTable.status, 'waiting-for-user')
            )
          )
          .limit(1)
          .get() !== undefined
      )
    }
  }
}
