import { and, asc, desc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { ThingSourceQuoteRecord, ThingThreadScopeRecord } from '@yachiyo/shared/protocol'
import type { YachiyoStorage } from '../storage.ts'
import * as schema from './schema.ts'
import {
  thingsTable,
  thingSourceQuotesTable,
  thingThreadScopesTable,
  threadsTable
} from './schema.ts'

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
  | 'listThingSourceQuotes'
  | 'addThingSourceQuote'
  | 'deleteThingSourceQuote'
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

  const toQuoteRecord = (row: {
    id: string
    thingId: string
    threadId: string
    threadTitle: string | null
    threadIcon: string | null
    messageId: string | null
    spanRowId: string | null
    sourceRowId: string
    quote: string
    createdAt: string
  }): ThingSourceQuoteRecord => ({
    id: row.id,
    thingId: row.thingId,
    threadId: row.threadId,
    ...(row.threadTitle ? { threadTitle: row.threadTitle } : {}),
    ...(row.threadIcon ? { threadIcon: row.threadIcon } : {}),
    ...(row.messageId ? { messageId: row.messageId } : {}),
    ...(row.spanRowId ? { spanRowId: row.spanRowId } : {}),
    sourceRowId: row.sourceRowId,
    quote: row.quote,
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
    listThingSourceQuotes(thingId) {
      const query = db
        .select({
          id: thingSourceQuotesTable.id,
          thingId: thingSourceQuotesTable.thingId,
          threadId: thingSourceQuotesTable.threadId,
          threadTitle: threadsTable.title,
          threadIcon: threadsTable.icon,
          messageId: thingSourceQuotesTable.messageId,
          spanRowId: thingSourceQuotesTable.spanRowId,
          sourceRowId: thingSourceQuotesTable.sourceRowId,
          quote: thingSourceQuotesTable.quote,
          createdAt: thingSourceQuotesTable.createdAt
        })
        .from(thingSourceQuotesTable)
        .leftJoin(threadsTable, eq(thingSourceQuotesTable.threadId, threadsTable.id))
        .orderBy(asc(thingSourceQuotesTable.createdAt))

      return (
        thingId ? query.where(eq(thingSourceQuotesTable.thingId, thingId)).all() : query.all()
      ).map(toQuoteRecord)
    },
    addThingSourceQuote(quote) {
      db.insert(thingSourceQuotesTable).values(quote).run()
    },
    deleteThingSourceQuote(id) {
      db.delete(thingSourceQuotesTable).where(eq(thingSourceQuotesTable.id, id)).run()
    }
  }
}
