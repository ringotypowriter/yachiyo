import { and, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { ThingSourceRecord, ThingThreadScopeRecord } from '@yachiyo/shared/protocol'
import type { YachiyoStorage } from '../storage.ts'
import * as schema from './schema.ts'
import { thingsTable, thingSourcesTable, thingThreadScopesTable, threadsTable } from './schema.ts'

type SqliteDb = BetterSQLite3Database<typeof schema>

type SqliteThingsStorageMethods = Pick<
  YachiyoStorage,
  | 'listThings'
  | 'getThing'
  | 'getThingByName'
  | 'createThing'
  | 'updateThing'
  | 'deleteThing'
  | 'listThingThreadScopes'
  | 'upsertThingThreadScope'
  | 'deleteThingThreadScope'
  | 'listThingSources'
  | 'upsertThingSource'
  | 'deleteThingSource'
>

export function createSqliteThingsStorageMethods(db: SqliteDb): SqliteThingsStorageMethods {
  const toScopeRecord = (row: {
    thingId: string
    threadId: string
    threadTitle: string | null
    createdAt: string
    updatedAt: string
  }): ThingThreadScopeRecord => ({
    thingId: row.thingId,
    threadId: row.threadId,
    ...(row.threadTitle ? { threadTitle: row.threadTitle } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  })

  const toSourceRecord = (row: {
    id: string
    thingId: string
    threadId: string
    threadTitle: string | null
    threadIcon: string | null
    messageId: string | null
    spanRowId: string | null
    sourceRowId: string
    preview: string
    createdAt: string
  }): ThingSourceRecord => ({
    id: row.id,
    thingId: row.thingId,
    threadId: row.threadId,
    ...(row.threadTitle ? { threadTitle: row.threadTitle } : {}),
    ...(row.threadIcon ? { threadIcon: row.threadIcon } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.spanRowId ? { spanRowId: row.spanRowId } : {}),
    sourceRowId: row.sourceRowId,
    preview: row.preview,
    createdAt: row.createdAt
  })

  return {
    listThings() {
      return db.select().from(thingsTable).orderBy(desc(thingsTable.lastUpdatedAt)).all()
    },
    getThing(id) {
      return db.select().from(thingsTable).where(eq(thingsTable.id, id)).get()
    },
    getThingByName(name) {
      return db.select().from(thingsTable).where(eq(thingsTable.name, name)).get()
    },
    createThing(thing) {
      db.insert(thingsTable).values(thing).run()
    },
    updateThing(thing) {
      db.update(thingsTable).set(thing).where(eq(thingsTable.id, thing.id)).run()
    },
    deleteThing(id) {
      db.delete(thingsTable).where(eq(thingsTable.id, id)).run()
    },
    listThingThreadScopes(thingId) {
      const query = db
        .select({
          thingId: thingThreadScopesTable.thingId,
          threadId: thingThreadScopesTable.threadId,
          threadTitle: threadsTable.title,
          createdAt: thingThreadScopesTable.createdAt,
          updatedAt: thingThreadScopesTable.updatedAt
        })
        .from(thingThreadScopesTable)
        .leftJoin(threadsTable, eq(thingThreadScopesTable.threadId, threadsTable.id))
        .orderBy(desc(thingThreadScopesTable.updatedAt))

      return (
        thingId ? query.where(eq(thingThreadScopesTable.thingId, thingId)).all() : query.all()
      ).map(toScopeRecord)
    },
    upsertThingThreadScope(scope) {
      db.insert(thingThreadScopesTable)
        .values(scope)
        .onConflictDoUpdate({
          target: [thingThreadScopesTable.thingId, thingThreadScopesTable.threadId],
          set: { updatedAt: scope.updatedAt }
        })
        .run()
    },
    deleteThingThreadScope({ thingId, threadId }) {
      db.delete(thingThreadScopesTable)
        .where(
          and(
            eq(thingThreadScopesTable.thingId, thingId),
            eq(thingThreadScopesTable.threadId, threadId)
          )
        )
        .run()
    },
    listThingSources(thingId) {
      const query = db
        .select({
          id: thingSourcesTable.id,
          thingId: thingSourcesTable.thingId,
          threadId: thingSourcesTable.threadId,
          threadTitle: threadsTable.title,
          threadIcon: threadsTable.icon,
          messageId: thingSourcesTable.messageId,
          spanRowId: thingSourcesTable.spanRowId,
          sourceRowId: thingSourcesTable.sourceRowId,
          preview: thingSourcesTable.preview,
          createdAt: thingSourcesTable.createdAt
        })
        .from(thingSourcesTable)
        .leftJoin(threadsTable, eq(thingSourcesTable.threadId, threadsTable.id))
        .orderBy(desc(thingSourcesTable.createdAt))

      return (
        thingId ? query.where(eq(thingSourcesTable.thingId, thingId)).all() : query.all()
      ).map(toSourceRecord)
    },
    upsertThingSource(source) {
      const existing = db
        .select({ id: thingSourcesTable.id })
        .from(thingSourcesTable)
        .where(
          and(
            eq(thingSourcesTable.thingId, source.thingId),
            eq(thingSourcesTable.sourceRowId, source.sourceRowId)
          )
        )
        .get()

      if (existing) {
        db.update(thingSourcesTable)
          .set({
            threadId: source.threadId,
            messageId: source.messageId,
            spanRowId: source.spanRowId,
            sourceRowId: source.sourceRowId,
            preview: source.preview
          })
          .where(eq(thingSourcesTable.id, existing.id))
          .run()
        return
      }

      db.insert(thingSourcesTable).values(source).run()
    },
    deleteThingSource(id) {
      db.delete(thingSourcesTable).where(eq(thingSourcesTable.id, id)).run()
    }
  }
}
