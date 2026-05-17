import { Worker } from 'node:worker_threads'

import { resolveYachiyoActivitySourceKeyPath } from '../../config/paths.ts'
import type {
  QueryRowsResult,
  QuerySourceExecutor,
  QuerySourceToolInput
} from './querySourceTool.ts'

interface WorkerMessage {
  error?: string
  handled?: boolean
  result?: QueryRowsResult
}

const SQLITE_SOURCE_QUERY_WORKER_SCRIPT = `
const { parentPort, workerData } = require('node:worker_threads')
const { createDecipheriv } = require('node:crypto')
const { readFileSync } = require('node:fs')
const BetterSqlite3Module = require('better-sqlite3')
const BetterSqlite3 =
  typeof BetterSqlite3Module === 'function' ? BetterSqlite3Module : BetterSqlite3Module.default

if (!BetterSqlite3) {
  throw new Error('Failed to load better-sqlite3 runtime')
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const SPAN_CONTEXT_RADIUS = 2
const DETAIL_CONTEXT_RADIUS = 4

function normalizeText(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.replace(/\\s+/gu, ' ').trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function truncate(value, maxLength = 180) {
  const compact = String(value).replace(/\\s+/gu, ' ').trim()
  return compact.length > maxLength ? compact.slice(0, maxLength - 3) + '...' : compact
}

function includesText(value, text) {
  return typeof value === 'string' && value.toLowerCase().includes(text.toLowerCase())
}

function tokenizeQuery(query) {
  return (
    query
      .replace(/\\s+/gu, ' ')
      .trim()
      .toLowerCase()
      .match(/[\\p{L}\\p{N}]+/gu) ?? []
  ).filter(Boolean)
}

function toMatchExpression(query) {
  const tokens = tokenizeQuery(query)
  return tokens.map((token) => '"' + token.replace(/"/gu, '""') + '"').join(' OR ')
}

function extractSnippet(content, query, maxLength = 120) {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) {
    return content.length > maxLength ? content.slice(0, maxLength) + '...' : content
  }
  const start = Math.max(0, idx - 8)
  const end = Math.min(content.length, start + maxLength)
  const snippet = content.slice(start, end)
  return (start > 0 ? '...' : '') + snippet + (end < content.length ? '...' : '')
}

function getLimit(limit) {
  return typeof limit === 'number' && Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)))
    : DEFAULT_LIMIT
}

function parseCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) return 0
  const parsed = Number.parseInt(cursor, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function paginate(rows, input) {
  const start = parseCursor(input.cursor)
  const limit = getLimit(input.limit)
  const sliced = rows.slice(start, start + limit)
  const nextOffset = start + sliced.length
  return {
    rows: sliced,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {})
  }
}

function encodeSegment(value) {
  return encodeURIComponent(value)
}

function decodeSegment(value) {
  return decodeURIComponent(value)
}

function parseRowId(rowId) {
  const [kind, ...encodedParts] = String(rowId).split(':')
  return {
    kind,
    parts: encodedParts.map(decodeSegment)
  }
}

function threadRowId(threadId) {
  return 'thread:' + encodeSegment(threadId)
}

function folderRowId(folderId) {
  return 'thread_folder:' + encodeSegment(folderId)
}

function messageRowId(threadId, messageId) {
  return 'thread_message:' + encodeSegment(threadId) + ':' + encodeSegment(messageId)
}

function spanRowId(threadId, startMessageId, endMessageId) {
  return (
    'thread_span:' +
    encodeSegment(threadId) +
    ':' +
    encodeSegment(startMessageId) +
    ':' +
    encodeSegment(endMessageId)
  )
}

function activityRowId(activityId) {
  return 'activity_record:' + encodeSegment(activityId)
}

function parseSpanRowId(rowId) {
  const parsed = parseRowId(rowId)
  if (parsed.kind !== 'thread_span' || parsed.parts.length !== 3) return null
  return {
    threadId: parsed.parts[0],
    startMessageId: parsed.parts[1],
    endMessageId: parsed.parts[2]
  }
}

function visibilityClause() {
  return [
    'threads.archived_at IS NULL',
    'threads.privacy_mode IS NULL',
    "(((threads.source IS NULL OR threads.source = 'local') AND threads.channel_user_id IS NULL) OR (threads.channel_group_id IS NULL AND channel_users.role = 'owner'))"
  ].join(' AND ')
}

function appendThreadFilters(clauses, params, where) {
  if (!where) return
  if (typeof where.threadId === 'string' && where.threadId.length > 0) {
    clauses.push('threads.id = ?')
    params.push(where.threadId)
  }
  if (typeof where.folderId === 'string' && where.folderId.length > 0) {
    clauses.push('threads.folder_id = ?')
    params.push(where.folderId)
  }
}

function appendMessageTimeFilters(clauses, params, where) {
  if (!where) return
  if (typeof where.since === 'string' && where.since.length > 0) {
    clauses.push('messages.created_at >= ?')
    params.push(where.since)
  }
  if (typeof where.until === 'string' && where.until.length > 0) {
    clauses.push('messages.created_at <= ?')
    params.push(where.until)
  }
}

function appendActivityTimeFilters(clauses, params, where) {
  if (!where) return
  if (typeof where.since === 'string' && where.since.length > 0) {
    clauses.push('activity_source_records.ended_at >= ?')
    params.push(where.since)
  }
  if (typeof where.until === 'string' && where.until.length > 0) {
    clauses.push('activity_source_records.started_at <= ?')
    params.push(where.until)
  }
}

function isTimestampInRange(timestamp, where) {
  if (where?.since && timestamp < where.since) return false
  if (where?.until && timestamp > where.until) return false
  return true
}

function overlapsTimeRange(startedAt, endedAt, where) {
  if (where?.since && endedAt < where.since) return false
  if (where?.until && startedAt > where.until) return false
  return true
}

function placeholders(values) {
  return values.map(() => '?').join(', ')
}

function toFolderReference(thread) {
  if (!thread.folderId || !thread.folderTitle) return undefined
  return {
    id: thread.folderId,
    title: thread.folderTitle,
    colorTag: thread.folderColorTag
  }
}

function toThreadMessageRow(thread, message) {
  const folder = toFolderReference(thread)
  return {
    table: 'thread_messages',
    rowId: messageRowId(thread.id, message.id),
    parentRowId: threadRowId(thread.id),
    sourceKind: 'thread',
    threadId: thread.id,
    threadTitle: thread.title,
    ...(folder ? { folder } : {}),
    messageId: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt
  }
}

function summarizeMessages(messages) {
  return messages
    .slice(0, 4)
    .map((message) => message.role + ': ' + truncate(message.content, 120))
    .join('\\n')
}

function evidenceFromMessages(messages, text) {
  const lower = typeof text === 'string' ? text.toLowerCase() : undefined
  const candidates = lower
    ? messages.filter((message) => message.content.toLowerCase().includes(lower))
    : messages
  return candidates.slice(0, 3).map((message) => truncate(message.content, 160))
}

function buildThreadSpanRow({ matchedEvidence, messages, thread, view }) {
  if (messages.length === 0) return undefined
  const first = messages[0]
  const last = messages[messages.length - 1]
  const folder = toFolderReference(thread)
  const evidence =
    matchedEvidence && matchedEvidence.length > 0
      ? matchedEvidence.map((value) => truncate(value, 180))
      : evidenceFromMessages(messages)

  const row = {
    table: 'thread_spans',
    rowId: spanRowId(thread.id, first.id, last.id),
    parentRowId: threadRowId(thread.id),
    sourceKind: 'thread',
    threadId: thread.id,
    threadTitle: thread.title,
    ...(folder ? { folder } : {}),
    title: thread.title,
    startedAt: first.createdAt,
    endedAt: last.createdAt,
    timeRange: {
      since: first.createdAt,
      until: last.createdAt
    },
    messageCount: messages.length,
    summary: summarizeMessages(messages),
    matchedEvidence: evidence,
    availableViews: ['messages', 'surroundingContext', 'fullThread', 'folderThreads', 'folderSpans']
  }

  if (view !== 'index') {
    row.messages = messages.map((message) => toThreadMessageRow(thread, message))
  }
  return row
}

function sortRows(rows, orderBy) {
  const getTime = (row) => row.startedAt ?? row.createdAt ?? row.updatedAt ?? ''
  if (orderBy === 'timeAsc') {
    return rows.slice().sort((left, right) => getTime(left).localeCompare(getTime(right)))
  }
  if (orderBy === 'timeDesc') {
    return rows.slice().sort((left, right) => getTime(right).localeCompare(getTime(left)))
  }
  return rows
}

function resolveTimeOrder(input, autoOrder = 'timeDesc') {
  return input.orderBy === 'timeAsc' || input.orderBy === 'timeDesc' ? input.orderBy : autoOrder
}

function fetchThreads(db, threadIds) {
  if (threadIds.length === 0) return new Map()
  const clauses = [visibilityClause(), \`threads.id IN (\${placeholders(threadIds)})\`]
  const rows = db
    .prepare(
      \`SELECT
         threads.id AS id,
         threads.title AS title,
         threads.preview AS preview,
         threads.folder_id AS folderId,
         threads.updated_at AS updatedAt,
         threads.created_at AS createdAt,
         thread_folders.title AS folderTitle,
         thread_folders.color_tag AS folderColorTag
       FROM threads
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       LEFT JOIN thread_folders ON thread_folders.id = threads.folder_id
       WHERE \${clauses.join(' AND ')}\`
    )
    .all(...threadIds)
  return new Map(rows.map((row) => [row.id, row]))
}

function fetchMessagesByThread(db, threadIds, where) {
  if (threadIds.length === 0) return new Map()
  const clauses = [
    \`messages.thread_id IN (\${placeholders(threadIds)})\`,
    'messages.hidden IS NULL'
  ]
  const params = [...threadIds]
  appendMessageTimeFilters(clauses, params, where)
  const rows = db
    .prepare(
      \`SELECT
         messages.id AS id,
         messages.thread_id AS threadId,
         messages.role AS role,
         messages.content AS content,
         messages.created_at AS createdAt
       FROM messages
       WHERE \${clauses.join(' AND ')}
       ORDER BY messages.thread_id ASC, messages.created_at ASC\`
    )
    .all(...params)
  const byThread = new Map()
  for (const row of rows) {
    const existing = byThread.get(row.threadId) ?? []
    existing.push(row)
    byThread.set(row.threadId, existing)
  }
  return byThread
}

function fetchAllThreadMessages(db, threadId) {
  return db
    .prepare(
      \`SELECT
         id AS id,
         thread_id AS threadId,
         role AS role,
         content AS content,
         created_at AS createdAt
       FROM messages
       WHERE thread_id = ? AND hidden IS NULL
       ORDER BY created_at ASC\`
    )
    .all(threadId)
}

function queryTextThreadSpans(db, input, text) {
  const where = input.where ?? {}
  const limit = getLimit(input.limit)
  const scanLimit = parseCursor(input.cursor) + limit + 1
  const matchExpr = toMatchExpression(text)
  if (matchExpr.length === 0) return { rows: [] }

  const titleClauses = [visibilityClause(), 'threads_fts MATCH ?']
  const titleParams = [matchExpr]
  appendThreadFilters(titleClauses, titleParams, where)
  titleParams.push(scanLimit)
  const titleIds = db
    .prepare(
      \`SELECT threads.id AS id
       FROM threads_fts
       JOIN threads ON threads.rowid = threads_fts.rowid
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       WHERE \${titleClauses.join(' AND ')}
       ORDER BY bm25(threads_fts, 3.0, 1.0) ASC
       LIMIT ?\`
    )
    .all(...titleParams)
    .map((row) => row.id)

  const messageLimit = Math.min(Math.max(scanLimit * 8, 40), 400)
  const messageClauses = [
    visibilityClause(),
    'messages.hidden IS NULL',
    'messages_fts MATCH ?'
  ]
  const messageParams = [matchExpr]
  appendThreadFilters(messageClauses, messageParams, where)
  appendMessageTimeFilters(messageClauses, messageParams, where)
  messageParams.push(messageLimit)
  const messageOrder =
    input.orderBy === 'timeAsc'
      ? 'messages.created_at ASC'
      : input.orderBy === 'timeDesc'
        ? 'messages.created_at DESC'
        : 'bm25(messages_fts) ASC, messages.created_at ASC'
  const messageMatches = db
    .prepare(
      \`SELECT
         threads.id AS threadId,
         messages.id AS messageId,
         messages.role AS role,
         messages.created_at AS createdAt,
         messages.content AS content
       FROM messages_fts
       JOIN messages ON messages.rowid = messages_fts.rowid
       JOIN threads ON threads.id = messages.thread_id
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       WHERE \${messageClauses.join(' AND ')}
       ORDER BY \${messageOrder}
       LIMIT ?\`
    )
    .all(...messageParams)

  const messageMatchesByThread = new Map()
  for (const match of messageMatches) {
    const existing = messageMatchesByThread.get(match.threadId) ?? []
    existing.push(match)
    messageMatchesByThread.set(match.threadId, existing)
  }

  const orderedThreadIds = []
  const seenThreadIds = new Set()
  for (const id of titleIds) {
    if (!seenThreadIds.has(id)) {
      seenThreadIds.add(id)
      orderedThreadIds.push(id)
    }
  }
  for (const match of messageMatches) {
    if (!seenThreadIds.has(match.threadId)) {
      seenThreadIds.add(match.threadId)
      orderedThreadIds.push(match.threadId)
    }
  }

  const threads = fetchThreads(db, orderedThreadIds)
  const messagesByThread = fetchMessagesByThread(db, orderedThreadIds)
  const rows = []
  for (const threadId of orderedThreadIds) {
    const thread = threads.get(threadId)
    if (!thread) continue
    const messages = messagesByThread.get(threadId) ?? []
    if (messages.length === 0) continue
    const matches = messageMatchesByThread.get(threadId) ?? []
    const matchIds = new Set(matches.map((match) => match.messageId))
    const matchedIndexes = messages
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => matchIds.has(message.id) && isTimestampInRange(message.createdAt, where))
      .map(({ index }) => index)
    const rangeMessages =
      matchedIndexes.length > 0
        ? messages.slice(
            Math.max(0, Math.min(...matchedIndexes) - SPAN_CONTEXT_RADIUS),
            Math.min(messages.length, Math.max(...matchedIndexes) + SPAN_CONTEXT_RADIUS + 1)
          )
        : messages.filter((message) => isTimestampInRange(message.createdAt, where)).slice(0, 5)
    const row = buildThreadSpanRow({
      matchedEvidence: matches.map((match) => extractSnippet(match.content, text)),
      messages: rangeMessages,
      thread,
      view: input.view ?? 'index'
    })
    if (row) rows.push(row)
  }

  return paginate(sortRows(rows, input.orderBy), input)
}

function queryRangeThreadSpans(db, input) {
  const where = input.where ?? {}
  const limit = getLimit(input.limit)
  const scanLimit = parseCursor(input.cursor) + limit + 1
  const clauses = [visibilityClause(), 'messages.hidden IS NULL']
  const params = []
  appendThreadFilters(clauses, params, where)
  appendMessageTimeFilters(clauses, params, where)
  const order =
    input.orderBy === 'timeAsc'
      ? 'MIN(messages.created_at) ASC'
      : 'MAX(messages.created_at) DESC'
  params.push(scanLimit)
  const threadRows = db
    .prepare(
      \`SELECT threads.id AS threadId
       FROM messages
       JOIN threads ON threads.id = messages.thread_id
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       WHERE \${clauses.join(' AND ')}
       GROUP BY threads.id
       ORDER BY \${order}
       LIMIT ?\`
    )
    .all(...params)
  const threadIds = threadRows.map((row) => row.threadId)
  const threads = fetchThreads(db, threadIds)
  const messagesByThread = fetchMessagesByThread(db, threadIds, where)
  const rows = []
  for (const threadId of threadIds) {
    const thread = threads.get(threadId)
    if (!thread) continue
    const row = buildThreadSpanRow({
      messages: messagesByThread.get(threadId) ?? [],
      thread,
      view: input.view ?? 'index'
    })
    if (row) rows.push(row)
  }
  return paginate(sortRows(rows, input.orderBy), input)
}

function findMessageRange(messages, startMessageId, endMessageId, radius) {
  const startIndex = messages.findIndex((message) => message.id === startMessageId)
  const endIndex = messages.findIndex((message) => message.id === endMessageId)
  if (startIndex < 0 || endIndex < 0) return []
  return messages.slice(
    Math.max(0, startIndex - radius),
    Math.min(messages.length, endIndex + radius + 1)
  )
}

function queryThreadSpans(db, input) {
  const text = normalizeText(input.where?.text)
  return text ? queryTextThreadSpans(db, input, text) : queryRangeThreadSpans(db, input)
}

function queryThreadMessages(db, input) {
  const where = input.where ?? {}
  const view = input.view ?? 'index'
  let rows = []

  if (where.parentRowId) {
    const span = parseSpanRowId(where.parentRowId)
    if (span) {
      const threads = fetchThreads(db, [span.threadId])
      const thread = threads.get(span.threadId)
      if (!thread) return { rows: [] }
      const messages = fetchAllThreadMessages(db, span.threadId)
      rows = findMessageRange(
        messages,
        span.startMessageId,
        span.endMessageId,
        view === 'detail' ? DETAIL_CONTEXT_RADIUS : 0
      ).map((message) => toThreadMessageRow(thread, message))
    } else {
      const parsed = parseRowId(where.parentRowId)
      if (parsed.kind === 'thread' && parsed.parts.length === 1) {
        const threadId = parsed.parts[0]
        const threads = fetchThreads(db, [threadId])
        const thread = threads.get(threadId)
        rows = thread
          ? fetchAllThreadMessages(db, threadId).map((message) =>
              toThreadMessageRow(thread, message)
            )
          : []
      }
    }
    return paginate(sortRows(rows, input.orderBy ?? 'timeAsc'), input)
  }

  if (where.rowId) {
    const parsed = parseRowId(where.rowId)
    if (parsed.kind !== 'thread_message' || parsed.parts.length !== 2) return { rows: [] }
    const [threadId, messageId] = parsed.parts
    const threads = fetchThreads(db, [threadId])
    const thread = threads.get(threadId)
    if (!thread) return { rows: [] }
    const message = db
      .prepare(
        \`SELECT
           id AS id,
           thread_id AS threadId,
           role AS role,
           content AS content,
           created_at AS createdAt
         FROM messages
         WHERE thread_id = ? AND id = ? AND hidden IS NULL\`
      )
      .get(threadId, messageId)
    return { rows: message ? [toThreadMessageRow(thread, message)] : [] }
  }

  const limit = getLimit(input.limit)
  const offset = parseCursor(input.cursor)
  const clauses = [visibilityClause(), 'messages.hidden IS NULL']
  const params = []
  appendThreadFilters(clauses, params, where)
  appendMessageTimeFilters(clauses, params, where)
  const text = normalizeText(where.text)
  if (text) {
    clauses.push('messages.content LIKE ?')
    params.push('%' + text.replace(/[%_]/gu, '') + '%')
  }
  const order = input.orderBy === 'timeDesc' ? 'messages.created_at DESC' : 'messages.created_at ASC'
  params.push(limit + 1, offset)
  rows = db
    .prepare(
      \`SELECT
         messages.id AS id,
         messages.thread_id AS threadId,
         messages.role AS role,
         messages.content AS content,
         messages.created_at AS createdAt,
         threads.title AS threadTitle,
         threads.folder_id AS folderId,
         thread_folders.title AS folderTitle,
         thread_folders.color_tag AS folderColorTag
       FROM messages
       JOIN threads ON threads.id = messages.thread_id
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       LEFT JOIN thread_folders ON thread_folders.id = threads.folder_id
       WHERE \${clauses.join(' AND ')}
       ORDER BY \${order}
       LIMIT ? OFFSET ?\`
    )
    .all(...params)
    .map((row) =>
      toThreadMessageRow(
        {
          id: row.threadId,
          title: row.threadTitle,
          folderId: row.folderId,
          folderTitle: row.folderTitle,
          folderColorTag: row.folderColorTag
        },
        row
      )
    )

  const hasMore = rows.length > limit
  return {
    rows: rows.slice(0, limit),
    ...(hasMore ? { nextCursor: String(offset + limit) } : {})
  }
}

function toThreadRow(row) {
  const folder = toFolderReference(row)
  return {
    table: 'threads',
    rowId: threadRowId(row.id),
    sourceKind: 'thread',
    threadId: row.id,
    title: row.title,
    ...(folder ? { folder } : {}),
    preview: row.preview ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    messageCount: Number(row.messageCount ?? 0),
    availableViews: ['messages', 'spans', 'folderThreads', 'folderSpans']
  }
}

function queryThreads(db, input) {
  const where = input.where ?? {}
  const clauses = [visibilityClause()]
  const params = []

  if (where.rowId) {
    const parsed = parseRowId(where.rowId)
    if (parsed.kind !== 'thread' || parsed.parts.length !== 1) return { rows: [] }
    clauses.push('threads.id = ?')
    params.push(parsed.parts[0])
  }

  appendThreadFilters(clauses, params, where)

  const text = normalizeText(where.text)
  if (text) {
    const pattern = '%' + text.replace(/[%_]/gu, '') + '%'
    clauses.push('(threads.title LIKE ? OR threads.preview LIKE ?)')
    params.push(pattern, pattern)
  }

  const limit = getLimit(input.limit)
  const offset = parseCursor(input.cursor)
  const order = resolveTimeOrder(input) === 'timeAsc' ? 'threads.updated_at ASC' : 'threads.updated_at DESC'
  params.push(limit + 1, offset)

  const rows = db
    .prepare(
      \`SELECT
         threads.id AS id,
         threads.title AS title,
         threads.preview AS preview,
         threads.folder_id AS folderId,
         threads.updated_at AS updatedAt,
         threads.created_at AS createdAt,
         thread_folders.title AS folderTitle,
         thread_folders.color_tag AS folderColorTag,
         COALESCE(message_counts.message_count, 0) AS messageCount
       FROM threads
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       LEFT JOIN thread_folders ON thread_folders.id = threads.folder_id
       LEFT JOIN (
         SELECT thread_id, COUNT(*) AS message_count
         FROM messages
         WHERE hidden IS NULL
         GROUP BY thread_id
       ) AS message_counts ON message_counts.thread_id = threads.id
       WHERE \${clauses.join(' AND ')}
       ORDER BY \${order}
       LIMIT ? OFFSET ?\`
    )
    .all(...params)
    .map(toThreadRow)

  const hasMore = rows.length > limit
  return {
    rows: rows.slice(0, limit),
    ...(hasMore ? { nextCursor: String(offset + limit) } : {})
  }
}

function fetchRecentThreadTitlesByFolder(db, folderIds) {
  if (folderIds.length === 0) return new Map()
  const rows = db
    .prepare(
      \`SELECT
         threads.folder_id AS folderId,
         threads.title AS title
       FROM threads
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       WHERE \${visibilityClause()} AND threads.folder_id IN (\${placeholders(folderIds)})
       ORDER BY threads.folder_id ASC, threads.updated_at DESC\`
    )
    .all(...folderIds)

  const titlesByFolder = new Map()
  for (const row of rows) {
    const existing = titlesByFolder.get(row.folderId) ?? []
    if (existing.length < 5) {
      existing.push(row.title)
      titlesByFolder.set(row.folderId, existing)
    }
  }
  return titlesByFolder
}

function queryThreadFolders(db, input) {
  const where = input.where ?? {}
  const clauses = [visibilityClause()]
  const params = []

  if (where.rowId) {
    const parsed = parseRowId(where.rowId)
    if (parsed.kind !== 'thread_folder' || parsed.parts.length !== 1) return { rows: [] }
    clauses.push('thread_folders.id = ?')
    params.push(parsed.parts[0])
  }

  if (typeof where.folderId === 'string' && where.folderId.length > 0) {
    clauses.push('thread_folders.id = ?')
    params.push(where.folderId)
  }

  const text = normalizeText(where.text)
  if (text) {
    clauses.push('thread_folders.title LIKE ?')
    params.push('%' + text.replace(/[%_]/gu, '') + '%')
  }

  const limit = getLimit(input.limit)
  const offset = parseCursor(input.cursor)
  const order =
    resolveTimeOrder(input) === 'timeAsc'
      ? 'thread_folders.updated_at ASC'
      : 'thread_folders.updated_at DESC'
  params.push(limit + 1, offset)

  const folderRows = db
    .prepare(
      \`SELECT
         thread_folders.id AS folderId,
         thread_folders.title AS title,
         thread_folders.color_tag AS colorTag,
         thread_folders.created_at AS createdAt,
         thread_folders.updated_at AS updatedAt,
         COUNT(threads.id) AS threadCount
       FROM thread_folders
       JOIN threads ON threads.folder_id = thread_folders.id
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       WHERE \${clauses.join(' AND ')}
       GROUP BY thread_folders.id
       ORDER BY \${order}
       LIMIT ? OFFSET ?\`
    )
    .all(...params)

  const recentTitles = fetchRecentThreadTitlesByFolder(
    db,
    folderRows.map((row) => row.folderId)
  )
  const rows = folderRows.map((row) => ({
    table: 'thread_folders',
    rowId: folderRowId(row.folderId),
    sourceKind: 'thread_folder',
    folderId: row.folderId,
    title: row.title,
    colorTag: row.colorTag,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    threadCount: Number(row.threadCount ?? 0),
    recentThreadTitles: recentTitles.get(row.folderId) ?? [],
    availableViews: ['folderThreads', 'folderSpans']
  }))

  const hasMore = rows.length > limit
  return {
    rows: rows.slice(0, limit),
    ...(hasMore ? { nextCursor: String(offset + limit) } : {})
  }
}

let activitySourceKey

function readActivitySourceKey() {
  if (!activitySourceKey) {
    activitySourceKey = Buffer.from(readFileSync(workerData.activitySourceKeyPath, 'utf8').trim(), 'base64')
    if (activitySourceKey.byteLength !== 32) {
      throw new Error('Activity source key must be 32 bytes')
    }
  }
  return activitySourceKey
}

function decryptActivityPayload(row) {
  if (row.payloadAlgorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported activity source encryption algorithm: ' + row.payloadAlgorithm)
  }
  if (row.payloadKeyVersion !== 1) {
    throw new Error('Unsupported activity source key version: ' + row.payloadKeyVersion)
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    readActivitySourceKey(),
    Buffer.from(row.payloadNonce, 'base64')
  )
  decipher.setAuthTag(Buffer.from(row.payloadAuthTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.payloadCiphertext, 'base64')),
    decipher.final()
  ]).toString('utf8')
  return JSON.parse(plaintext)
}

function activitySnapshotSearchText(snapshot) {
  return [
    snapshot.appName,
    snapshot.bundleId,
    snapshot.windowTitle,
    snapshot.ocr?.excerpt,
    snapshot.ocr?.text
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join('\\n')
}

function activitySnapshotExcerpt(snapshot) {
  return snapshot.ocr?.excerpt || snapshot.error
}

function findActivityMatchedEvidence(record, text) {
  if (!text) return undefined
  if (includesText(record.summaryText, text)) return truncate(record.summaryText)

  const entry = record.entries.find(
    (candidate) =>
      includesText(candidate.appName, text) ||
      includesText(candidate.windowTitle, text) ||
      includesText(candidate.bundleId, text)
  )
  if (entry) {
    return truncate(
      [entry.appName, entry.windowTitle, entry.bundleId]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join(' — ')
    )
  }

  const snapshot = record.snapshots?.find((candidate) =>
    includesText(activitySnapshotSearchText(candidate), text)
  )
  const snapshotText = snapshot?.ocr?.text ?? snapshot?.ocr?.excerpt
  return snapshotText ? truncate(snapshotText) : undefined
}

function matchesActivityRecord(record, where) {
  if (!overlapsTimeRange(record.startedAt, record.endedAt, where)) return false

  const text = normalizeText(where?.text)
  if (text && !findActivityMatchedEvidence(record, text)) return false

  const appName = normalizeText(where?.appName)
  if (appName && !record.entries.some((entry) => includesText(entry.appName, appName))) {
    return false
  }

  return true
}

function toActivityRecord(row) {
  const payload = decryptActivityPayload(row)
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

function toActivityRecordRow(record, row, view, where) {
  const folder = toFolderReference(row)
  const apps = [...new Set(record.entries.map((entry) => entry.appName))]
  const snapshots = record.snapshots ?? []
  const snapshotExcerpts = snapshots
    .map(activitySnapshotExcerpt)
    .filter((value) => typeof value === 'string' && value.length > 0)
  const matchedEvidence = findActivityMatchedEvidence(record, normalizeText(where?.text))
  return {
    table: 'activity_records',
    rowId: activityRowId(record.id),
    sourceKind: 'activity',
    activityId: record.id,
    threadId: record.threadId,
    threadTitle: row.threadTitle,
    ...(folder ? { folder } : {}),
    title: apps.length > 0 ? 'Activity in ' + apps.join(', ') : 'Activity record',
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    timeRange: {
      since: record.startedAt,
      until: record.endedAt
    },
    durationMs: record.totalDurationMs,
    uniqueApps: record.uniqueApps,
    summary: record.summaryText,
    apps,
    ...(snapshots.length > 0 ? { snapshotCount: snapshots.length } : {}),
    ...(matchedEvidence ? { matchedEvidence } : {}),
    ...(view !== 'index' ? { entries: record.entries } : {}),
    ...(view === 'content' && snapshotExcerpts.length > 0 ? { snapshotExcerpts } : {}),
    ...(view === 'detail' && snapshotExcerpts.length > 0 ? { snapshotExcerpts } : {}),
    ...(view === 'detail' && snapshots.length > 0 ? { snapshots } : {}),
    availableViews: ['content', 'detail']
  }
}

function queryActivityRecords(db, input) {
  const where = input.where ?? {}
  const clauses = [visibilityClause()]
  const params = []

  if (where.rowId) {
    const parsed = parseRowId(where.rowId)
    if (parsed.kind !== 'activity_record' || parsed.parts.length !== 1) return { rows: [] }
    clauses.push('activity_source_records.id = ?')
    params.push(parsed.parts[0])
  }

  appendThreadFilters(clauses, params, where)
  appendActivityTimeFilters(clauses, params, where)

  const order =
    resolveTimeOrder(input) === 'timeAsc'
      ? 'activity_source_records.started_at ASC'
      : 'activity_source_records.started_at DESC'

  const rows = db
    .prepare(
      \`SELECT
         activity_source_records.id AS id,
         activity_source_records.thread_id AS threadId,
         activity_source_records.run_id AS runId,
         activity_source_records.request_message_id AS requestMessageId,
         activity_source_records.started_at AS startedAt,
         activity_source_records.ended_at AS endedAt,
         activity_source_records.total_duration_ms AS totalDurationMs,
         activity_source_records.unique_apps AS uniqueApps,
         activity_source_records.afk_duration_ms AS afkDurationMs,
         activity_source_records.payload_algorithm AS payloadAlgorithm,
         activity_source_records.payload_key_version AS payloadKeyVersion,
         activity_source_records.payload_nonce AS payloadNonce,
         activity_source_records.payload_auth_tag AS payloadAuthTag,
         activity_source_records.payload_ciphertext AS payloadCiphertext,
         activity_source_records.created_at AS createdAt,
         threads.title AS threadTitle,
         threads.folder_id AS folderId,
         thread_folders.title AS folderTitle,
         thread_folders.color_tag AS folderColorTag
       FROM activity_source_records
       JOIN threads ON threads.id = activity_source_records.thread_id
       LEFT JOIN channel_users ON channel_users.id = threads.channel_user_id
       LEFT JOIN thread_folders ON thread_folders.id = threads.folder_id
       WHERE \${clauses.join(' AND ')}
       ORDER BY \${order}\`
    )
    .all(...params)
    .map((row) => {
      const record = toActivityRecord(row)
      return { record, row }
    })
    .filter(({ record }) => matchesActivityRecord(record, where))
    .map(({ record, row }) => toActivityRecordRow(record, row, input.view ?? 'index', where))

  return paginate(sortRows(rows, resolveTimeOrder(input)), input)
}

function sourceWindowInput(input, from) {
  return {
    ...input,
    from,
    view: 'index',
    orderBy: resolveTimeOrder(input),
    limit: parseCursor(input.cursor) + getLimit(input.limit) + 1,
    cursor: undefined
  }
}

function querySourceEvents(db, input) {
  const threadRows = queryThreadSpans(db, sourceWindowInput(input, 'thread_spans')).rows.map(
    (span) => ({
      table: 'source_events',
      rowId: 'source_event:' + span.rowId,
      sourceRowId: span.rowId,
      sourceKind: 'thread',
      threadId: span.threadId,
      title: span.title,
      ...(span.folder ? { folder: span.folder } : {}),
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      timeRange: span.timeRange,
      summary: span.summary,
      availableViews: ['threadSpan', 'messages']
    })
  )

  const activityRows = queryActivityRecords(db, sourceWindowInput(input, 'activity_records')).rows.map(
    (activity) => ({
      table: 'source_events',
      rowId: 'source_event:' + activity.rowId,
      sourceRowId: activity.rowId,
      sourceKind: 'activity',
      threadId: activity.threadId,
      title: activity.title,
      ...(activity.folder ? { folder: activity.folder } : {}),
      startedAt: activity.startedAt,
      endedAt: activity.endedAt,
      timeRange: activity.timeRange,
      summary: activity.summary,
      ...(activity.snapshotCount ? { snapshotCount: activity.snapshotCount } : {}),
      ...(activity.matchedEvidence ? { matchedEvidence: activity.matchedEvidence } : {}),
      availableViews: ['activityRecord']
    })
  )

  return paginate(sortRows([...threadRows, ...activityRows], resolveTimeOrder(input)), input)
}

function query(db, input) {
  if (input.from === 'source_events') {
    return { handled: true, result: querySourceEvents(db, input) }
  }
  if (input.from === 'thread_folders') {
    return { handled: true, result: queryThreadFolders(db, input) }
  }
  if (input.from === 'threads') {
    return { handled: true, result: queryThreads(db, input) }
  }
  if (input.from === 'thread_spans') {
    return { handled: true, result: queryThreadSpans(db, input) }
  }
  if (input.from === 'thread_messages') {
    return { handled: true, result: queryThreadMessages(db, input) }
  }
  if (input.from === 'activity_records') {
    return { handled: true, result: queryActivityRecords(db, input) }
  }
  return { handled: false }
}

let db
try {
  db = new BetterSqlite3(workerData.dbPath, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  db.pragma('busy_timeout = 1000')
  parentPort.postMessage(query(db, workerData.input))
} finally {
  if (db) db.close()
}
`

function createAbortError(): Error {
  const error = new Error('querySource sqlite query aborted.')
  error.name = 'AbortError'
  return error
}

function runSqliteSourceQueryWorker(input: {
  activitySourceKeyPath: string
  dbPath: string
  queryInput: QuerySourceToolInput
  signal?: AbortSignal
}): Promise<QueryRowsResult | undefined> {
  if (input.signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  const worker = new Worker(SQLITE_SOURCE_QUERY_WORKER_SCRIPT, {
    eval: true,
    workerData: {
      activitySourceKeyPath: input.activitySourceKeyPath,
      dbPath: input.dbPath,
      input: input.queryInput
    }
  })

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      input.signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      void worker.terminate().catch(() => {})
      settle(() => reject(createAbortError()))
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: WorkerMessage) => {
      settle(() => {
        if (message.error) {
          reject(new Error(message.error))
          return
        }
        resolve(message.handled === true ? message.result : undefined)
      })
    })
    worker.on('error', (error) => {
      settle(() => reject(error))
    })
    worker.on('exit', (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`querySource sqlite worker exited with code ${code}`)))
      }
    })
  })
}

const SQLITE_SOURCE_QUERY_TABLES = new Set<QuerySourceToolInput['from']>([
  'source_events',
  'thread_folders',
  'threads',
  'thread_spans',
  'thread_messages',
  'activity_records'
])

export function createSqliteSourceQueryExecutor(input: { dbPath: string }): QuerySourceExecutor {
  const activitySourceKeyPath = resolveYachiyoActivitySourceKeyPath()

  return {
    query(queryInput, signal) {
      if (!SQLITE_SOURCE_QUERY_TABLES.has(queryInput.from)) {
        return Promise.resolve(undefined)
      }
      return runSqliteSourceQueryWorker({
        activitySourceKeyPath,
        dbPath: input.dbPath,
        queryInput,
        signal
      })
    }
  }
}
