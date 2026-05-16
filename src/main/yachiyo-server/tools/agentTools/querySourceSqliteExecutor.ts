import { Worker } from 'node:worker_threads'

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
    "(channel_users.id IS NULL OR channel_users.role != 'guest')"
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

function isTimestampInRange(timestamp, where) {
  if (where?.since && timestamp < where.since) return false
  if (where?.until && timestamp > where.until) return false
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

function fetchThreads(db, threadIds) {
  if (threadIds.length === 0) return new Map()
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
       LEFT JOIN thread_folders ON thread_folders.id = threads.folder_id
       WHERE threads.id IN (\${placeholders(threadIds)})\`
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

function query(db, input) {
  if (input.from === 'thread_spans') {
    return { handled: true, result: queryThreadSpans(db, input) }
  }
  if (input.from === 'thread_messages') {
    return { handled: true, result: queryThreadMessages(db, input) }
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

export function createSqliteSourceQueryExecutor(input: { dbPath: string }): QuerySourceExecutor {
  return {
    query(queryInput, signal) {
      if (queryInput.from !== 'thread_spans' && queryInput.from !== 'thread_messages') {
        return Promise.resolve(undefined)
      }
      return runSqliteSourceQueryWorker({
        dbPath: input.dbPath,
        queryInput,
        signal
      })
    }
  }
}
