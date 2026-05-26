import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or } from 'drizzle-orm'

import type { ThreadSearchResult } from '../../../../shared/yachiyo/protocol.ts'
import {
  extractSnippet,
  ftsMessageSearchSql,
  ftsThreadSearchSql,
  toMatchExpression,
  type FtsMessageRow
} from '../ftsQuery.ts'
import type { YachiyoStorage } from '../storage.ts'
import { messagesTable, threadsTable } from './schema.ts'
import type { BetterSqlite3Client, SqliteDb } from './sqliteRuntime.ts'

export function createSqliteThreadSearchStorageMethods(input: {
  client: BetterSqlite3Client
  db: SqliteDb
}): Pick<YachiyoStorage, 'searchThreadsAndMessages' | 'searchThreadsAndMessagesFts'> {
  const { client, db } = input

  return {
    searchThreadsAndMessages({ query, scope = 'active' }) {
      const trimmed = query.trim()
      if (trimmed.length === 0) {
        return []
      }
      const pattern = `%${trimmed.replace(/[%_]/g, '')}%`
      const archivePredicate =
        scope === 'archived' ? isNotNull(threadsTable.archivedAt) : isNull(threadsTable.archivedAt)

      const titleMatchedIds = new Set(
        db
          .select({ id: threadsTable.id })
          .from(threadsTable)
          .where(
            and(
              archivePredicate,
              or(like(threadsTable.title, pattern), like(threadsTable.preview, pattern))
            )
          )
          .all()
          .map((t) => t.id)
      )

      const allMessageMatches = db
        .select({
          messageId: messagesTable.id,
          threadId: messagesTable.threadId,
          content: messagesTable.content,
          threadUpdatedAt: threadsTable.updatedAt
        })
        .from(messagesTable)
        .innerJoin(threadsTable, eq(messagesTable.threadId, threadsTable.id))
        .where(
          and(archivePredicate, like(messagesTable.content, pattern), isNull(messagesTable.hidden))
        )
        .orderBy(desc(threadsTable.updatedAt), asc(messagesTable.createdAt))
        .all()

      const messageMatchesByThread = new Map<string, { messageId: string; content: string }[]>()
      for (const match of allMessageMatches) {
        const existing = messageMatchesByThread.get(match.threadId) ?? []
        existing.push({ messageId: match.messageId, content: match.content })
        messageMatchesByThread.set(match.threadId, existing)
      }

      const allMatchedIds = new Set([...titleMatchedIds, ...messageMatchesByThread.keys()])
      if (allMatchedIds.size === 0) {
        return []
      }

      const matchedThreads = db
        .select({
          id: threadsTable.id,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt
        })
        .from(threadsTable)
        .where(inArray(threadsTable.id, [...allMatchedIds]))
        .orderBy(desc(threadsTable.updatedAt))
        .limit(30)
        .all()

      const results: ThreadSearchResult[] = matchedThreads.map((thread) => {
        const matches = messageMatchesByThread.get(thread.id) ?? []
        return {
          threadId: thread.id,
          threadTitle: thread.title,
          threadUpdatedAt: thread.updatedAt,
          titleMatched: titleMatchedIds.has(thread.id),
          messageMatches: matches.map((m) => ({
            messageId: m.messageId,
            snippet: extractSnippet(m.content, trimmed)
          }))
        }
      })

      return results
    },

    searchThreadsAndMessagesFts({ query, limit = 30, includePrivate = false }) {
      const trimmed = query.trim()
      if (trimmed.length === 0) return []
      const matchExpr = toMatchExpression(trimmed)
      if (matchExpr === '') return []

      const privacyClause = includePrivate ? '' : 'AND threads.privacy_mode IS NULL'

      // FTS5 title/preview matches — BM25 with title weighted higher
      const titleMatchedIds = new Set(
        (
          client.prepare(ftsThreadSearchSql(privacyClause)).all(matchExpr, limit) as Array<{
            id: string
          }>
        ).map((r) => r.id)
      )

      // FTS5 message content matches — ranked by BM25
      const allMessageMatches = client
        .prepare(ftsMessageSearchSql(privacyClause))
        .all(matchExpr) as FtsMessageRow[]

      const messageMatchesByThread = new Map<
        string,
        { messageId: string; content: string; role: 'user' | 'assistant'; createdAt: string }[]
      >()
      for (const match of allMessageMatches) {
        const existing = messageMatchesByThread.get(match.threadId) ?? []
        existing.push({
          messageId: match.messageId,
          content: match.content,
          role: match.role,
          createdAt: match.createdAt
        })
        messageMatchesByThread.set(match.threadId, existing)
      }

      // Merge title and message matches, preserving BM25 match order.
      // Title hits come first (they matched the thread subject), followed by
      // threads that only matched on message content.  Within each group the
      // order is the BM25-ranked order returned by the FTS queries above.
      const seenThreadIds = new Set<string>()
      const orderedThreadIds: string[] = []
      for (const id of titleMatchedIds) {
        if (!seenThreadIds.has(id)) {
          seenThreadIds.add(id)
          orderedThreadIds.push(id)
        }
      }
      for (const id of messageMatchesByThread.keys()) {
        if (!seenThreadIds.has(id)) {
          seenThreadIds.add(id)
          orderedThreadIds.push(id)
        }
      }
      if (orderedThreadIds.length === 0) return []

      const limitedIds = orderedThreadIds.slice(0, limit)
      const threadMetaById = new Map(
        db
          .select({
            id: threadsTable.id,
            title: threadsTable.title,
            updatedAt: threadsTable.updatedAt
          })
          .from(threadsTable)
          .where(inArray(threadsTable.id, limitedIds))
          .all()
          .map((t) => [t.id, t] as const)
      )

      return limitedIds
        .map((id) => {
          const thread = threadMetaById.get(id)
          if (!thread) return null
          const matches = messageMatchesByThread.get(id) ?? []
          return {
            threadId: thread.id,
            threadTitle: thread.title,
            threadUpdatedAt: thread.updatedAt,
            titleMatched: titleMatchedIds.has(thread.id),
            messageMatches: matches.map((m) => ({
              messageId: m.messageId,
              snippet: extractSnippet(m.content, trimmed),
              role: m.role,
              createdAt: m.createdAt
            }))
          }
        })
        .filter((r): r is NonNullable<typeof r> => r !== null)
    }
  }
}
