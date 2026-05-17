import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type {
  ActivitySnapshot,
  ActivitySourceRecord,
  FolderRecord,
  MessageRecord,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { MemorySearchResult, MemoryService } from '../../services/memory/memoryService.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'

const SOURCE_TABLES = [
  'source_events',
  'memories',
  'thread_folders',
  'threads',
  'thread_spans',
  'thread_messages',
  'activity_records'
] as const

const SOURCE_VIEWS = ['index', 'content', 'detail'] as const
const SOURCE_ORDER = ['auto', 'match', 'timeAsc', 'timeDesc'] as const
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const SPAN_CONTEXT_RADIUS = 2
const DETAIL_CONTEXT_RADIUS = 4
const MATCH_ORDER_ERROR =
  'orderBy.match is only supported for memories and text-filtered thread_spans.'
const MEMORY_TIME_ORDER_ERROR = 'memories only supports orderBy.auto or orderBy.match.'

type SourceTable = (typeof SOURCE_TABLES)[number]
type SourceView = (typeof SOURCE_VIEWS)[number]
type SourceOrder = (typeof SOURCE_ORDER)[number]
type AppliedSourceOrder = Exclude<SourceOrder, 'auto'>

export interface QuerySourceWhere {
  text?: string
  since?: string
  until?: string
  rowId?: string
  parentRowId?: string
  threadId?: string
  folderId?: string
  topic?: string
  appName?: string
}

export interface QuerySourceToolInput {
  from: SourceTable
  view?: SourceView
  where?: QuerySourceWhere
  orderBy?: SourceOrder
  limit?: number
  cursor?: string
}

interface QuerySourceToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

interface SourceCatalog {
  foldersById: Map<string, FolderRecord>
  messagesByThread: Map<string, MessageRecord[]>
  threadCreatedAtById: Map<string, string>
  threadById: Map<string, ThreadRecord>
  threads: ThreadRecord[]
}

interface ThreadSpanRow extends Record<string, unknown> {
  rowId: string
  threadId: string
  startedAt: string
  endedAt: string
}

export interface QueryRowsResult {
  rows: Array<Record<string, unknown>>
  nextCursor?: string
}

export interface QuerySourceExecutor {
  query(input: QuerySourceToolInput, signal?: AbortSignal): Promise<QueryRowsResult | undefined>
}

export interface QuerySourceToolDeps {
  memoryService?: MemoryService
  sourceQueryExecutor?: QuerySourceExecutor
  storage?: YachiyoStorage
}

const whereSchema = z
  .object({
    text: z.string().optional().describe('Text query for semantic or full-text matching.'),
    since: z.string().optional().describe('Inclusive ISO timestamp lower bound.'),
    until: z.string().optional().describe('Inclusive ISO timestamp upper bound.'),
    rowId: z.string().optional().describe('Open one row returned by a previous query.'),
    parentRowId: z
      .string()
      .optional()
      .describe('Open child rows for a previously returned row, such as span messages.'),
    threadId: z.string().optional().describe('Restrict thread tables to one thread.'),
    folderId: z.string().optional().describe('Restrict thread tables to one user-curated folder.'),
    topic: z.string().optional().describe('Restrict memories to a topic key.'),
    appName: z.string().optional().describe('Restrict activity records to an app name.')
  })
  .optional()

const inputSchema = z.object({
  from: z.enum(SOURCE_TABLES).describe('Virtual source table to query.'),
  view: z.enum(SOURCE_VIEWS).optional().describe('Return size: index, content, or detail.'),
  where: whereSchema,
  orderBy: z
    .enum(SOURCE_ORDER)
    .optional()
    .describe('Row ordering: auto, match, timeAsc, or timeDesc.'),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().optional().describe('Pagination cursor returned by a previous query.')
})

const DESCRIPTION = `
Query a read-only local source database built from durable user data.

The data is exposed as virtual tables. This tool does not execute raw SQL.
Use \`from\` to choose one table, \`where\` to filter rows, and \`view\` to choose how much content to return.
Rows are semantic records, not just search snippets. Each row may include a \`rowId\` for follow-up queries; \`rowId\` is only a join key, not the useful content.

Terminology:

- A thread is the internal data name for one user-visible conversation.
- Use thread table names, threadId, and thread rowIds when querying this tool.
- When answering the user, say "conversation" instead of "thread" unless you are quoting a table name, field name, rowId, or the user used "thread" first.

Tables:

- source_events
  A timeline view over event-like sources. Use this when you need to know what happened during a time range.
  Includes thread activity and computer activity. Does not include memories.

- memories
  Long-term extracted facts, preferences, decisions, plans, and user context.
  Use this only with a text query or topic. Do not use memories to browse a time range.

- thread_folders
  User-curated thread communities. Threads in the same folder usually share a goal, project, or problem area.
  Use this to discover or browse a folder of related conversations.

- threads
  Thread-level rows. Each row includes folder/community metadata when available.
  Use this when you already know a folder or thread, or want a thread list.

- thread_spans
  Searchable or time-bounded thread segments.
  Use this to find prior discussions and get enough context to decide whether to open more messages.
  Prefer this table over thread_messages when starting from a vague question.

- thread_messages
  Actual messages from threads.
  Use this after finding a thread span, or when you already know a threadId, rowId, or parentRowId.
  Use this to read fuller context from a past thread.

- activity_records
  Durable user activity records from apps/windows.
  Use this to inspect what the user was doing during a time range, or to search activity summaries.

Views:

- index
  Return compact but meaningful rows: title, time range, source kind, summary, matched evidence, folder/community data, and available follow-up views.
  Use this first when discovering data.

- content
  Return the main content for matching rows.

- detail
  Return fuller surrounding context. Use this only after narrowing results with a rowId, parentRowId, threadId, folderId, or tight time range.

Ordering:

- auto
  Default. Chooses the natural order for the table: match order for memories and text-filtered thread_spans, newest-first time order for timeline and browsing tables, and chronological order for thread_messages.

- match
  Match-ranked search order. Only supported for memories and thread_spans with where.text. Do not use this for source_events, activity_records, threads, thread_folders, or thread_messages because they do not have one unified match score.

- timeAsc / timeDesc
  Explicit chronological order. Not supported for memories because memory rows are match-ranked facts, not timeline events.

Rules:

- Start with index unless you already know the exact row to open.
- Use the narrowest useful filters.
- Do not use memories for timeline browsing.
- Use thread_spans to discover past discussions, then thread_messages to read fuller dialogue.
- Same-folder threads are a strong community signal, but they are not expanded unless you query by folderId or follow an available folder view.
`

function toResponse(payload: Record<string, unknown>, error?: string): QuerySourceToolOutput {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(error ? { error } : {})
  }
}

function toError(message: string, input: QuerySourceToolInput): QuerySourceToolOutput {
  return toResponse(
    {
      table: input.from,
      view: input.view ?? 'index',
      error: message,
      rows: []
    },
    message
  )
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/gu, ' ').trim()
  return trimmed ? trimmed : undefined
}

function includesText(value: string | undefined, text: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(text.toLowerCase())
}

function truncate(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

function decodeSegment(value: string): string {
  return decodeURIComponent(value)
}

function folderRowId(folderId: string): string {
  return `thread_folder:${encodeSegment(folderId)}`
}

function threadRowId(threadId: string): string {
  return `thread:${encodeSegment(threadId)}`
}

function messageRowId(threadId: string, messageId: string): string {
  return `thread_message:${encodeSegment(threadId)}:${encodeSegment(messageId)}`
}

function spanRowId(threadId: string, startMessageId: string, endMessageId: string): string {
  return `thread_span:${encodeSegment(threadId)}:${encodeSegment(startMessageId)}:${encodeSegment(endMessageId)}`
}

function activityRowId(activityId: string): string {
  return `activity_record:${encodeSegment(activityId)}`
}

function memoryRowId(memoryId: string): string {
  return `memory:${encodeSegment(memoryId)}`
}

function parseRowId(rowId: string): { kind: string; parts: string[] } {
  const [kind, ...encodedParts] = rowId.split(':')
  return {
    kind,
    parts: encodedParts.map(decodeSegment)
  }
}

function readCatalog(storage: YachiyoStorage): SourceCatalog {
  const bootstrap = storage.bootstrap()
  const threads = bootstrap.threads.filter((thread) => thread.privacyMode !== true)
  const visibleThreadIds = new Set(threads.map((thread) => thread.id))
  const visibleFolderIds = new Set(
    threads
      .map((thread) => thread.folderId)
      .filter((folderId): folderId is string => typeof folderId === 'string')
  )
  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const))
  const threadCreatedAtById = new Map(
    threads
      .map((thread) => {
        const createdAt = storage.getThreadCreatedAt(thread.id)
        return createdAt ? ([thread.id, createdAt] as const) : null
      })
      .filter((entry): entry is readonly [string, string] => entry !== null)
  )
  const foldersById = new Map(
    bootstrap.folders
      .filter((folder) => visibleFolderIds.has(folder.id))
      .map((folder) => [folder.id, folder] as const)
  )
  const messagesByThread = new Map<string, MessageRecord[]>()

  for (const [threadId, messages] of Object.entries(bootstrap.messagesByThread)) {
    if (!visibleThreadIds.has(threadId)) {
      continue
    }
    messagesByThread.set(
      threadId,
      messages.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    )
  }

  return {
    foldersById,
    messagesByThread,
    threadCreatedAtById,
    threadById,
    threads
  }
}

function toFolderReference(
  thread: ThreadRecord,
  foldersById: Map<string, FolderRecord>
): { id: string; title: string; colorTag: FolderRecord['colorTag'] } | undefined {
  if (!thread.folderId) {
    return undefined
  }
  const folder = foldersById.get(thread.folderId)
  if (!folder) {
    return undefined
  }
  return {
    id: folder.id,
    title: folder.title,
    colorTag: folder.colorTag
  }
}

function getMessageTime(message: MessageRecord): string {
  return message.createdAt
}

function isTimestampInRange(timestamp: string, where: QuerySourceWhere | undefined): boolean {
  if (where?.since && timestamp < where.since) {
    return false
  }
  if (where?.until && timestamp > where.until) {
    return false
  }
  return true
}

function overlapsTimeRange(
  startedAt: string,
  endedAt: string,
  where: QuerySourceWhere | undefined
): boolean {
  if (where?.since && endedAt < where.since) {
    return false
  }
  if (where?.until && startedAt > where.until) {
    return false
  }
  return true
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0
  }
  const parsed = Number.parseInt(cursor, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function getLimit(limit: number | undefined): number {
  return typeof limit === 'number' ? limit : DEFAULT_LIMIT
}

function paginate(
  rows: Array<Record<string, unknown>>,
  input: QuerySourceToolInput
): QueryRowsResult {
  const start = parseCursor(input.cursor)
  const limit = getLimit(input.limit)
  const sliced = rows.slice(start, start + limit)
  const nextOffset = start + sliced.length
  return {
    rows: sliced,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {})
  }
}

function isSourceOrder(value: unknown): value is SourceOrder {
  return typeof value === 'string' && SOURCE_ORDER.includes(value as SourceOrder)
}

function supportsMatchOrder(input: QuerySourceToolInput): boolean {
  if (input.from === 'memories') {
    return true
  }
  return input.from === 'thread_spans' && Boolean(normalizeText(input.where?.text))
}

function validateOrder(input: QuerySourceToolInput): QuerySourceToolOutput | undefined {
  if (input.orderBy === undefined) {
    return undefined
  }
  if (!isSourceOrder(input.orderBy)) {
    return toError(
      `Unsupported orderBy "${String(input.orderBy)}". Use auto, match, timeAsc, or timeDesc.`,
      input
    )
  }
  if (input.from === 'memories' && (input.orderBy === 'timeAsc' || input.orderBy === 'timeDesc')) {
    return toError(MEMORY_TIME_ORDER_ERROR, input)
  }
  if (input.orderBy === 'match' && !supportsMatchOrder(input)) {
    return toError(MATCH_ORDER_ERROR, input)
  }
  return undefined
}

function resolveOrder(
  input: QuerySourceToolInput,
  autoOrder: AppliedSourceOrder
): AppliedSourceOrder {
  return input.orderBy === undefined || input.orderBy === 'auto' ? autoOrder : input.orderBy
}

function sortByOrder(
  rows: Array<Record<string, unknown>>,
  orderBy: AppliedSourceOrder
): Array<Record<string, unknown>> {
  if (orderBy === 'timeAsc') {
    return rows.slice().sort((left, right) => getRowTime(left).localeCompare(getRowTime(right)))
  }
  if (orderBy === 'timeDesc') {
    return rows.slice().sort((left, right) => getRowTime(right).localeCompare(getRowTime(left)))
  }
  return rows
}

function getRowTime(row: Record<string, unknown>): string {
  const startedAt = row['startedAt']
  if (typeof startedAt === 'string') {
    return startedAt
  }
  const createdAt = row['createdAt']
  if (typeof createdAt === 'string') {
    return createdAt
  }
  const updatedAt = row['updatedAt']
  if (typeof updatedAt === 'string') {
    return updatedAt
  }
  return ''
}

function summarizeMessages(messages: MessageRecord[]): string {
  return messages
    .slice(0, 4)
    .map((message) => `${message.role}: ${truncate(message.content, 120)}`)
    .join('\n')
}

function evidenceFromMessages(messages: MessageRecord[], text: string | undefined): string[] {
  const candidates = text
    ? messages.filter((message) => includesText(message.content, text))
    : messages

  return candidates.slice(0, 3).map((message) => truncate(message.content, 160))
}

function buildThreadSpanRow(input: {
  catalog: SourceCatalog
  matchedEvidence?: string[]
  messages: MessageRecord[]
  thread: ThreadRecord
  view: SourceView
}): ThreadSpanRow | undefined {
  const messages = input.messages.filter((message) => !message.hidden)
  if (messages.length === 0) {
    return undefined
  }

  const first = messages[0]
  const last = messages[messages.length - 1]
  if (!first || !last) {
    return undefined
  }

  const folder = toFolderReference(input.thread, input.catalog.foldersById)
  const matchedEvidence =
    input.matchedEvidence && input.matchedEvidence.length > 0
      ? input.matchedEvidence.map((value) => truncate(value, 180))
      : evidenceFromMessages(messages, undefined)

  const row: ThreadSpanRow = {
    table: 'thread_spans',
    rowId: spanRowId(input.thread.id, first.id, last.id),
    parentRowId: threadRowId(input.thread.id),
    sourceKind: 'thread',
    threadId: input.thread.id,
    threadTitle: input.thread.title,
    ...(folder ? { folder } : {}),
    title: input.thread.title,
    startedAt: getMessageTime(first),
    endedAt: getMessageTime(last),
    timeRange: {
      since: getMessageTime(first),
      until: getMessageTime(last)
    },
    messageCount: messages.length,
    summary: summarizeMessages(messages),
    matchedEvidence,
    availableViews: ['messages', 'surroundingContext', 'fullThread', 'folderThreads', 'folderSpans']
  }

  if (input.view !== 'index') {
    row['messages'] = messages.map((message) =>
      toThreadMessageRow(input.catalog, input.thread, message)
    )
  }

  return row
}

function toThreadMessageRow(
  catalog: SourceCatalog,
  thread: ThreadRecord,
  message: MessageRecord
): Record<string, unknown> {
  const folder = toFolderReference(thread, catalog.foldersById)
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

function matchesThreadFilters(thread: ThreadRecord, where: QuerySourceWhere | undefined): boolean {
  if (where?.threadId && thread.id !== where.threadId) {
    return false
  }
  if (where?.folderId && thread.folderId !== where.folderId) {
    return false
  }
  return true
}

function getThreadMessages(catalog: SourceCatalog, threadId: string): MessageRecord[] {
  return (catalog.messagesByThread.get(threadId) ?? []).filter((message) => !message.hidden)
}

function buildTextThreadSpans(input: {
  catalog: SourceCatalog
  limit: number
  storage: YachiyoStorage
  text: string
  view: SourceView
  where?: QuerySourceWhere
}): ThreadSpanRow[] {
  const results = input.storage.searchThreadsAndMessagesFts({
    query: input.text,
    limit: Math.max(input.limit, DEFAULT_LIMIT)
  })
  const spans: ThreadSpanRow[] = []

  for (const result of results) {
    const thread = input.catalog.threadById.get(result.threadId)
    if (!thread || !matchesThreadFilters(thread, input.where)) {
      continue
    }

    const messages = getThreadMessages(input.catalog, thread.id)
    if (messages.length === 0) {
      continue
    }

    const matchIds = new Set(result.messageMatches.map((match) => match.messageId))
    const matchedIndexes = messages
      .map((message, index) => ({ message, index }))
      .filter(
        ({ message }) =>
          matchIds.has(message.id) && isTimestampInRange(message.createdAt, input.where)
      )
      .map(({ index }) => index)

    const rangeMessages =
      matchedIndexes.length > 0
        ? messages.slice(
            Math.max(0, Math.min(...matchedIndexes) - SPAN_CONTEXT_RADIUS),
            Math.min(messages.length, Math.max(...matchedIndexes) + SPAN_CONTEXT_RADIUS + 1)
          )
        : messages
            .filter((message) => isTimestampInRange(message.createdAt, input.where))
            .slice(0, 5)

    const row = buildThreadSpanRow({
      catalog: input.catalog,
      matchedEvidence: result.messageMatches.map((match) => match.snippet),
      messages: rangeMessages,
      thread,
      view: input.view
    })
    if (row) {
      spans.push(row)
    }
  }

  return spans
}

function buildRangeThreadSpans(input: {
  catalog: SourceCatalog
  view: SourceView
  where?: QuerySourceWhere
}): ThreadSpanRow[] {
  const rows: ThreadSpanRow[] = []
  for (const thread of input.catalog.threads) {
    if (!matchesThreadFilters(thread, input.where)) {
      continue
    }

    const messages = getThreadMessages(input.catalog, thread.id).filter((message) =>
      isTimestampInRange(message.createdAt, input.where)
    )
    if (messages.length === 0) {
      continue
    }

    const row = buildThreadSpanRow({
      catalog: input.catalog,
      messages,
      thread,
      view: input.view
    })
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

function queryThreadSpans(
  storage: YachiyoStorage,
  input: QuerySourceToolInput,
  catalog: SourceCatalog
): QueryRowsResult {
  const view = input.view ?? 'index'
  const rows = buildThreadSpans(storage, input, catalog, view)
  const order = resolveOrder(input, normalizeText(input.where?.text) ? 'match' : 'timeDesc')

  return paginate(sortByOrder(rows, order), input)
}

function buildThreadSpans(
  storage: YachiyoStorage,
  input: QuerySourceToolInput,
  catalog: SourceCatalog,
  view: SourceView
): ThreadSpanRow[] {
  const text = normalizeText(input.where?.text)
  return text
    ? buildTextThreadSpans({
        catalog,
        limit: getLimit(input.limit),
        storage,
        text,
        view,
        where: input.where
      })
    : buildRangeThreadSpans({
        catalog,
        view,
        where: input.where
      })
}

function parseSpanRowId(
  rowId: string
): { threadId: string; startMessageId: string; endMessageId: string } | null {
  const parsed = parseRowId(rowId)
  if (parsed.kind !== 'thread_span' || parsed.parts.length !== 3) {
    return null
  }
  return {
    threadId: parsed.parts[0]!,
    startMessageId: parsed.parts[1]!,
    endMessageId: parsed.parts[2]!
  }
}

function findMessageRange(
  messages: MessageRecord[],
  startMessageId: string,
  endMessageId: string,
  radius: number
): MessageRecord[] {
  const startIndex = messages.findIndex((message) => message.id === startMessageId)
  const endIndex = messages.findIndex((message) => message.id === endMessageId)
  if (startIndex < 0 || endIndex < 0) {
    return []
  }
  return messages.slice(
    Math.max(0, startIndex - radius),
    Math.min(messages.length, endIndex + radius + 1)
  )
}

function queryThreadMessages(input: QuerySourceToolInput, catalog: SourceCatalog): QueryRowsResult {
  const where = input.where
  const view = input.view ?? 'index'
  let messages: Array<{ thread: ThreadRecord; message: MessageRecord }> = []

  if (where?.parentRowId) {
    const span = parseSpanRowId(where.parentRowId)
    if (span) {
      const thread = catalog.threadById.get(span.threadId)
      if (!thread) {
        return { rows: [] }
      }
      const threadMessages = getThreadMessages(catalog, thread.id)
      const range = findMessageRange(
        threadMessages,
        span.startMessageId,
        span.endMessageId,
        view === 'detail' ? DETAIL_CONTEXT_RADIUS : 0
      )
      messages = range.map((message) => ({ thread, message }))
    } else {
      const parsed = parseRowId(where.parentRowId)
      if (parsed.kind === 'thread' && parsed.parts.length === 1) {
        const thread = catalog.threadById.get(parsed.parts[0]!)
        if (thread) {
          messages = getThreadMessages(catalog, thread.id).map((message) => ({ thread, message }))
        }
      }
    }
  } else if (where?.rowId) {
    const parsed = parseRowId(where.rowId)
    if (parsed.kind === 'thread_message' && parsed.parts.length === 2) {
      const thread = catalog.threadById.get(parsed.parts[0]!)
      const message = thread
        ? getThreadMessages(catalog, thread.id).find(
            (candidate) => candidate.id === parsed.parts[1]
          )
        : undefined
      messages = thread && message ? [{ thread, message }] : []
    }
  } else {
    for (const thread of catalog.threads) {
      if (!matchesThreadFilters(thread, where)) {
        continue
      }
      for (const message of getThreadMessages(catalog, thread.id)) {
        if (!isTimestampInRange(message.createdAt, where)) {
          continue
        }
        const text = normalizeText(where?.text)
        if (text && !includesText(message.content, text)) {
          continue
        }
        messages.push({ thread, message })
      }
    }
  }

  const rows = messages.map(({ thread, message }) => toThreadMessageRow(catalog, thread, message))
  return paginate(sortByOrder(rows, resolveOrder(input, 'timeAsc')), input)
}

function queryThreads(input: QuerySourceToolInput, catalog: SourceCatalog): QueryRowsResult {
  const text = normalizeText(input.where?.text)
  const rows = catalog.threads
    .filter((thread) => matchesThreadFilters(thread, input.where))
    .filter((thread) => {
      if (!text) {
        return true
      }
      return includesText(thread.title, text) || includesText(thread.preview, text)
    })
    .map((thread) => {
      const folder = toFolderReference(thread, catalog.foldersById)
      return {
        table: 'threads',
        rowId: threadRowId(thread.id),
        sourceKind: 'thread',
        threadId: thread.id,
        title: thread.title,
        ...(folder ? { folder } : {}),
        preview: thread.preview ?? '',
        ...(catalog.threadCreatedAtById.get(thread.id)
          ? { createdAt: catalog.threadCreatedAtById.get(thread.id) }
          : {}),
        updatedAt: thread.updatedAt,
        messageCount: getThreadMessages(catalog, thread.id).length,
        availableViews: ['messages', 'spans', 'folderThreads', 'folderSpans']
      }
    })

  return paginate(sortByOrder(rows, resolveOrder(input, 'timeDesc')), input)
}

function queryThreadFolders(input: QuerySourceToolInput, catalog: SourceCatalog): QueryRowsResult {
  const text = normalizeText(input.where?.text)
  const rows = [...catalog.foldersById.values()]
    .filter((folder) => !input.where?.folderId || folder.id === input.where.folderId)
    .filter((folder) => !text || includesText(folder.title, text))
    .map((folder) => {
      const threads = catalog.threads
        .filter((thread) => thread.folderId === folder.id)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      return {
        table: 'thread_folders',
        rowId: folderRowId(folder.id),
        sourceKind: 'thread_folder',
        folderId: folder.id,
        title: folder.title,
        colorTag: folder.colorTag,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
        threadCount: threads.length,
        recentThreadTitles: threads.slice(0, 5).map((thread) => thread.title),
        availableViews: ['folderThreads', 'folderSpans']
      }
    })

  return paginate(sortByOrder(rows, resolveOrder(input, 'timeDesc')), input)
}

function activitySnapshotSearchText(snapshot: ActivitySnapshot): string {
  return [
    snapshot.appName,
    snapshot.bundleId,
    snapshot.windowTitle,
    snapshot.ocr?.excerpt,
    snapshot.ocr?.text
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
}

function activitySnapshotExcerpt(snapshot: ActivitySnapshot): string | undefined {
  return snapshot.ocr?.excerpt || snapshot.error
}

function findActivityMatchedEvidence(
  record: ActivitySourceRecord,
  text: string | undefined
): string | undefined {
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
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' — ')
    )
  }

  const snapshot = record.snapshots?.find((candidate) =>
    includesText(activitySnapshotSearchText(candidate), text)
  )
  const snapshotText = snapshot?.ocr?.text ?? snapshot?.ocr?.excerpt
  return snapshotText ? truncate(snapshotText) : undefined
}

function matchesActivityRecord(
  record: ActivitySourceRecord,
  where: QuerySourceWhere | undefined
): boolean {
  if (!overlapsTimeRange(record.startedAt, record.endedAt, where)) {
    return false
  }

  const text = normalizeText(where?.text)
  if (text && !findActivityMatchedEvidence(record, text)) {
    return false
  }

  const appName = normalizeText(where?.appName)
  if (appName && !record.entries.some((entry) => includesText(entry.appName, appName))) {
    return false
  }

  return true
}

function toActivityRecordRow(
  record: ActivitySourceRecord,
  catalog: SourceCatalog,
  view: SourceView,
  where?: QuerySourceWhere
): Record<string, unknown> {
  const thread = catalog.threadById.get(record.threadId)
  const folder = thread ? toFolderReference(thread, catalog.foldersById) : undefined
  const apps = [...new Set(record.entries.map((entry) => entry.appName))]
  const snapshots = record.snapshots ?? []
  const snapshotExcerpts = snapshots
    .map(activitySnapshotExcerpt)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const matchedEvidence = findActivityMatchedEvidence(record, normalizeText(where?.text))
  return {
    table: 'activity_records',
    rowId: activityRowId(record.id),
    sourceKind: 'activity',
    activityId: record.id,
    threadId: record.threadId,
    ...(thread ? { threadTitle: thread.title } : {}),
    ...(folder ? { folder } : {}),
    title: apps.length > 0 ? `Activity in ${apps.join(', ')}` : 'Activity record',
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

function queryActivityRecords(
  storage: YachiyoStorage,
  input: QuerySourceToolInput,
  catalog: SourceCatalog
): QueryRowsResult {
  const view = input.view ?? 'index'
  const rows = storage
    .listActivitySourceRecords()
    .filter((record) => catalog.threadById.has(record.threadId))
    .filter((record) => matchesActivityRecord(record, input.where))
    .map((record) => toActivityRecordRow(record, catalog, view, input.where))

  return paginate(sortByOrder(rows, resolveOrder(input, 'timeDesc')), input)
}

async function queryMemories(
  deps: QuerySourceToolDeps,
  input: QuerySourceToolInput,
  signal?: AbortSignal
): Promise<QueryRowsResult | QuerySourceToolOutput> {
  const text = normalizeText(input.where?.text)
  if (!text) {
    return toError('memories requires where.text.', input)
  }
  if (!deps.memoryService?.isConfigured()) {
    return { rows: [] }
  }

  const results = await deps.memoryService.searchMemories({
    limit: getLimit(input.limit),
    query: text,
    topic: input.where?.topic,
    signal
  })

  const rows = results.map(toMemoryRow)
  return paginate(rows, input)
}

function parseMemoryTopic(result: MemorySearchResult): string | undefined {
  return result.labels?.find((label) => label.startsWith('topic:'))?.slice('topic:'.length)
}

function toMemoryRow(result: MemorySearchResult): Record<string, unknown> {
  return {
    table: 'memories',
    rowId: memoryRowId(result.id),
    sourceKind: 'memory',
    memoryId: result.id,
    title: result.title?.trim() || 'Untitled memory',
    ...(parseMemoryTopic(result) ? { topic: parseMemoryTopic(result) } : {}),
    ...(result.unitType ? { unitType: result.unitType } : {}),
    ...(typeof result.importance === 'number' ? { importance: result.importance } : {}),
    ...(typeof result.score === 'number' ? { score: result.score } : {}),
    summary: result.content.trim(),
    availableViews: ['content']
  }
}

function querySourceEvents(
  storage: YachiyoStorage,
  input: QuerySourceToolInput,
  catalog: SourceCatalog
): QueryRowsResult {
  const threadRows = buildThreadSpans(storage, input, catalog, 'index').map((span) => ({
    table: 'source_events',
    rowId: `source_event:${span.rowId}`,
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
  }))

  const activityRows = storage
    .listActivitySourceRecords()
    .filter((record) => catalog.threadById.has(record.threadId))
    .filter((record) => matchesActivityRecord(record, input.where))
    .map((record) => {
      const row = toActivityRecordRow(record, catalog, 'index', input.where)
      return {
        table: 'source_events',
        rowId: `source_event:${row['rowId']}`,
        sourceRowId: row['rowId'],
        sourceKind: 'activity',
        threadId: row['threadId'],
        title: row['title'],
        ...(row['folder'] ? { folder: row['folder'] } : {}),
        startedAt: row['startedAt'],
        endedAt: row['endedAt'],
        timeRange: row['timeRange'],
        summary: row['summary'],
        ...(row['snapshotCount'] ? { snapshotCount: row['snapshotCount'] } : {}),
        ...(row['matchedEvidence'] ? { matchedEvidence: row['matchedEvidence'] } : {}),
        availableViews: ['activityRecord']
      }
    })

  const rows = [...threadRows, ...activityRows]
  return paginate(sortByOrder(rows, resolveOrder(input, 'timeDesc')), input)
}

async function executeQuery(
  deps: QuerySourceToolDeps,
  input: QuerySourceToolInput,
  signal?: AbortSignal
): Promise<QueryRowsResult | QuerySourceToolOutput> {
  const orderError = validateOrder(input)
  if (orderError) {
    return orderError
  }

  if (input.from === 'memories') {
    return queryMemories(deps, input, signal)
  }

  const delegated = await deps.sourceQueryExecutor?.query(input, signal)
  if (delegated) {
    return delegated
  }

  if (!deps.storage) {
    return toError(`${input.from} requires local source storage.`, input)
  }

  const storage = deps.storage
  const catalog = readCatalog(storage)
  switch (input.from) {
    case 'source_events':
      return querySourceEvents(storage, input, catalog)
    case 'thread_folders':
      return queryThreadFolders(input, catalog)
    case 'threads':
      return queryThreads(input, catalog)
    case 'thread_spans':
      return queryThreadSpans(storage, input, catalog)
    case 'thread_messages':
      return queryThreadMessages(input, catalog)
    case 'activity_records':
      return queryActivityRecords(storage, input, catalog)
  }
}

function isToolOutput(
  value: QueryRowsResult | QuerySourceToolOutput
): value is QuerySourceToolOutput {
  return 'content' in value
}

export function createTool(
  deps: QuerySourceToolDeps
): Tool<QuerySourceToolInput, QuerySourceToolOutput> {
  return tool({
    description: DESCRIPTION.trim(),
    inputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input, options) => {
      try {
        const result = await executeQuery(deps, input, options.abortSignal)
        if (isToolOutput(result)) {
          return result
        }

        return toResponse({
          table: input.from,
          view: input.view ?? 'index',
          rows: result.rows,
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {})
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'querySource failed.'
        return toError(message, input)
      }
    }
  })
}
