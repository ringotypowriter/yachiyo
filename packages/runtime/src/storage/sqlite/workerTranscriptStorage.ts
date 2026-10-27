import { and, asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { YachiyoStorage } from '../storage.ts'
import { isLocalOrOwnerDmThread } from '../threadVisibility.ts'
import * as schema from './schema.ts'

export function createSqliteWorkerTranscriptStorageMethods(
  db: BetterSQLite3Database<typeof schema>
): Pick<YachiyoStorage, 'upsertWorkerTranscriptTurn' | 'listWorkerTranscriptTurns'> {
  return {
    upsertWorkerTranscriptTurn(turn) {
      return db.transaction((tx) => {
        const owner = tx
          .select({ thread: schema.threadsTable, role: schema.channelUsersTable.role })
          .from(schema.threadsTable)
          .leftJoin(
            schema.channelUsersTable,
            eq(schema.threadsTable.channelUserId, schema.channelUsersTable.id)
          )
          .innerJoin(
            schema.runsTable,
            and(
              eq(schema.runsTable.id, turn.launchRunId),
              eq(schema.runsTable.threadId, schema.threadsTable.id)
            )
          )
          .where(eq(schema.threadsTable.id, turn.threadId))
          .get()
        if (
          !owner ||
          owner.thread.privacyMode === '1' ||
          !isLocalOrOwnerDmThread(owner.thread, owner.role)
        ) {
          return false
        }
        tx.insert(schema.workerTranscriptTurnsTable)
          .values(turn)
          .onConflictDoUpdate({
            target: schema.workerTranscriptTurnsTable.id,
            set: turn
          })
          .run()
        return true
      })
    },
    listWorkerTranscriptTurns(threadId) {
      return db
        .select()
        .from(schema.workerTranscriptTurnsTable)
        .where(eq(schema.workerTranscriptTurnsTable.threadId, threadId))
        .orderBy(
          asc(schema.workerTranscriptTurnsTable.createdAt),
          asc(schema.workerTranscriptTurnsTable.id)
        )
        .all()
    }
  }
}
