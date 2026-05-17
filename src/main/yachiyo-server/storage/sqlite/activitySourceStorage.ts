import { desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { ActivitySourceRecord } from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../storage.ts'
import * as schema from './schema.ts'
import { activitySourceRecordsTable } from './schema.ts'
import { createActivitySourceCipher, type ActivitySourceCipher } from './activitySourceCrypto.ts'

type SqliteDb = BetterSQLite3Database<typeof schema>

type SqliteActivitySourceStorageMethods = Pick<
  YachiyoStorage,
  'saveActivitySourceRecord' | 'listActivitySourceRecords'
>

function toActivitySourceRecord(
  row: typeof activitySourceRecordsTable.$inferSelect,
  cipher: ActivitySourceCipher
): ActivitySourceRecord {
  const payload = cipher.decrypt({
    algorithm: row.payloadAlgorithm as 'aes-256-gcm',
    keyVersion: row.payloadKeyVersion as 1,
    nonce: row.payloadNonce,
    authTag: row.payloadAuthTag,
    ciphertext: row.payloadCiphertext
  })

  return {
    id: row.id,
    threadId: row.threadId,
    runId: row.runId,
    requestMessageId: row.requestMessageId,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    totalDurationMs: row.totalDurationMs,
    uniqueApps: row.uniqueApps,
    ...(row.afkDurationMs !== null ? { afkDurationMs: row.afkDurationMs } : {}),
    summaryText: payload.summaryText,
    entries: payload.entries,
    ...(payload.snapshots ? { snapshots: payload.snapshots } : {}),
    createdAt: row.createdAt
  }
}

export function createSqliteActivitySourceStorageMethods(input: {
  db: SqliteDb
  cipher?: ActivitySourceCipher
}): SqliteActivitySourceStorageMethods {
  const { db, cipher = createActivitySourceCipher() } = input

  return {
    saveActivitySourceRecord(record) {
      const payload = cipher.encrypt({
        version: 2,
        summaryText: record.summaryText,
        entries: record.entries,
        ...(record.snapshots ? { snapshots: record.snapshots } : {})
      })

      db.insert(activitySourceRecordsTable)
        .values({
          id: record.id,
          threadId: record.threadId,
          runId: record.runId,
          requestMessageId: record.requestMessageId,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          totalDurationMs: record.totalDurationMs,
          uniqueApps: record.uniqueApps,
          afkDurationMs: record.afkDurationMs ?? null,
          payloadAlgorithm: payload.algorithm,
          payloadKeyVersion: payload.keyVersion,
          payloadNonce: payload.nonce,
          payloadAuthTag: payload.authTag,
          payloadCiphertext: payload.ciphertext,
          createdAt: record.createdAt
        })
        .run()
    },

    listActivitySourceRecords(input) {
      const limit = input?.limit
      const query = db
        .select()
        .from(activitySourceRecordsTable)
        .orderBy(desc(activitySourceRecordsTable.startedAt))

      const rows = typeof limit === 'number' ? query.limit(limit).all() : query.all()

      return rows.map((row) => toActivitySourceRecord(row, cipher))
    }
  }
}
