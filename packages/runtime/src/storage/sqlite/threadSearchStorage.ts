import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or } from 'drizzle-orm'

import type { ThreadSearchResult } from '@yachiyo/shared/protocol'
import {
  buildFtsSearchPlan,
  extractSnippet,
  ftsMessageSearchSql,
  ftsThreadSearchSql,
  FTS_MESSAGE_ROWS_PER_THREAD,
  likeMessageSearchSql,
  likeThreadSearchSql,
  toLikeFallbackPatterns,
  toPhraseMatchExpression,
  type FtsMessageRow
} from '../ftsQuery.ts'
import type { YachiyoStorage } from '../storage.ts'
import { messagesTable, threadsTable } from './schema.ts'
import type { BetterSqlite3Client, SqliteDb } from './sqliteRuntime.ts'

// Sidebar search FTS queries. Same visibility rules as the LIKE path below
// (exclude channel-group probe threads and archived threads, keep everything
// else) — deliberately looser than the querySource filters in ftsQuery.ts.
const UI_FTS_THREAD_SQL = `
  SELECT threads.id AS id
  FROM threads_fts
  JOIN threads ON threads.rowid = threads_fts.rowid
  WHERE threads_fts MATCH ?
    AND threads.channel_group_id IS NULL
    AND threads.archived_at IS NULL
  ORDER BY bm25(threads_fts, 3.0, 1.0) ASC
  LIMIT ?
`

const UI_FTS_MESSAGE_SQL = `
  SELECT
    messages.id        AS messageId,
    messages.thread_id AS threadId,
    messages.content   AS content
  FROM messages_fts
  JOIN messages ON messages.rowid = messages_fts.rowid
  JOIN threads  ON threads.id = messages.thread_id
  WHERE messages_fts MATCH ?
    AND threads.channel_group_id IS NULL
    AND threads.archived_at IS NULL
    AND messages.hidden IS NULL
  ORDER BY bm25(messages_fts) ASC, messages.created_at ASC
  LIMIT ?
`

export function createSqliteThreadSearchStorageMethods(input: {
  client: BetterSqlite3Client
  db: SqliteDb
}): Pick<YachiyoStorage, 'searchThreadsAndMessages' | 'searchThreadsAndMessagesFts'> {
  const { client, db } = input

  // Relevance-ranked sidebar search. A phrase MATCH keeps the
  // contiguous-substring semantics of the LIKE scan it replaces.
  function searchActiveViaFts(matchExpr: string, trimmed: string): ThreadSearchResult[] {
    const titleIds = (
      client.prepare(UI_FTS_THREAD_SQL).all(matchExpr, 30) as Array<{ id: string }>
    ).map((r) => r.id)
    const messageRows = client
      .prepare(UI_FTS_MESSAGE_SQL)
      .all(matchExpr, 30 * FTS_MESSAGE_ROWS_PER_THREAD) as Array<{
      messageId: string
      threadId: string
      content: string
    }>

    const messageMatchesByThread = new Map<string, { messageId: string; content: string }[]>()
    for (const row of messageRows) {
      const existing = messageMatchesByThread.get(row.threadId) ?? []
      existing.push({ messageId: row.messageId, content: row.content })
      messageMatchesByThread.set(row.threadId, existing)
    }

    // Title hits first (BM25 order), then content-only threads.
    const orderedIds: string[] = []
    const seen = new Set<string>()
    for (const id of [...titleIds, ...messageMatchesByThread.keys()]) {
      if (!seen.has(id)) {
        seen.add(id)
        orderedIds.push(id)
      }
    }
    if (orderedIds.length === 0) return []

    const limitedIds = orderedIds.slice(0, 30)
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
    const titleMatchedIds = new Set(titleIds)

    return limitedIds.flatMap((id): ThreadSearchResult[] => {
      const thread = threadMetaById.get(id)
      if (!thread) return []
      const matches = messageMatchesByThread.get(id) ?? []
      return [
        {
          threadId: thread.id,
          threadTitle: thread.title,
          threadUpdatedAt: thread.updatedAt,
          titleMatched: titleMatchedIds.has(thread.id),
          messageMatches: matches.map((m) => ({
            messageId: m.messageId,
            snippet: extractSnippet(m.content, trimmed)
          }))
        }
      ]
    })
  }

  return {
    searchThreadsAndMessages({ query, scope = 'active' }) {
      const trimmed = query.trim()
      if (trimmed.length === 0) {
        return []
      }

      // Phrase-matchable active-scope queries get the relevance-ranked FTS
      // path; short queries and the archived scope keep the LIKE scan below.
      if (scope === 'active') {
        const matchExpr = toPhraseMatchExpression(trimmed)
        if (matchExpr !== '') {
          try {
            return searchActiveViaFts(matchExpr, trimmed)
          } catch (error) {
            // Corrupt or reset FTS index — the LIKE scan below still works.
            console.error('[fts] sidebar search failed; falling back to LIKE', error)
          }
        }
      }

      const pattern = `%${trimmed.replace(/[%_]/g, '')}%`
      // Channel-group threads (hidden group probe runs) never appear in the
      // thread list, so keep them out of search results too.
      const searchablePredicate = and(
        isNull(threadsTable.channelGroupId),
        scope === 'archived' ? isNotNull(threadsTable.archivedAt) : isNull(threadsTable.archivedAt)
      )

      const titleMatchedIds = new Set(
        db
          .select({ id: threadsTable.id })
          .from(threadsTable)
          .where(
            and(
              searchablePredicate,
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
          and(
            searchablePredicate,
            like(messagesTable.content, pattern),
            isNull(messagesTable.hidden)
          )
        )
        .orderBy(desc(threadsTable.updatedAt), asc(messagesTable.createdAt))
        // Bound materialization for common substrings; most-recent threads win.
        .limit(30 * FTS_MESSAGE_ROWS_PER_THREAD)
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
      const plan = buildFtsSearchPlan(trimmed)
      if (plan.matchExpr === '' && plan.likePatterns.length === 0) return []
      const privacyClause = includePrivate ? '' : 'AND threads.privacy_mode IS NULL'
      const messageRowLimit = limit * FTS_MESSAGE_ROWS_PER_THREAD

      const titleIds: string[] = []
      const allMessageMatches: FtsMessageRow[] = []
      // Short tokens the trigram index cannot match (e.g. two-character
      // Chinese words in a mixed query) are supplemented via substring LIKE
      // instead of being silently dropped.
      let likePatterns = plan.likePatterns
      if (plan.matchExpr !== '') {
        try {
          // FTS5 trigram matches — BM25-ranked, title weighted higher;
          // message fetch bounded so common-token queries cannot materialize
          // the whole messages table.
          titleIds.push(
            ...(
              client
                .prepare(ftsThreadSearchSql(privacyClause))
                .all(plan.matchExpr, limit) as Array<{ id: string }>
            ).map((r) => r.id)
          )
          allMessageMatches.push(
            ...(client
              .prepare(ftsMessageSearchSql(privacyClause))
              .all(plan.matchExpr, messageRowLimit) as FtsMessageRow[])
          )
        } catch (error) {
          // Corrupt or reset FTS index — degrade the whole query to LIKE.
          console.error('[fts] search failed; falling back to LIKE', error)
          likePatterns = toLikeFallbackPatterns(trimmed)
        }
      }
      if (likePatterns.length > 0) {
        titleIds.push(
          ...(
            client
              .prepare(likeThreadSearchSql(privacyClause, likePatterns.length))
              .all(...likePatterns.flatMap((pattern) => [pattern, pattern]), limit) as Array<{
              id: string
            }>
          ).map((r) => r.id)
        )
        allMessageMatches.push(
          ...(client
            .prepare(likeMessageSearchSql(privacyClause, likePatterns.length))
            .all(...likePatterns, messageRowLimit) as FtsMessageRow[])
        )
      }
      const titleMatchedIds = new Set(titleIds)

      const messageMatchesByThread = new Map<
        string,
        { messageId: string; content: string; role: 'user' | 'assistant'; createdAt: string }[]
      >()
      // A message can match both the FTS and the LIKE query — keep the first
      // (better-ranked) occurrence.
      const seenMessageIds = new Set<string>()
      for (const match of allMessageMatches) {
        if (seenMessageIds.has(match.messageId)) continue
        seenMessageIds.add(match.messageId)
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
