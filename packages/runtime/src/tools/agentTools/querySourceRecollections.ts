import { parseRowId, parseSourceEventSourceRowId, spanRowId } from './querySourceRowIds.ts'
import { selectMemorySourceReferences } from '../../services/memory/cognitiveMemory.ts'
import type { QueryRowsResult, QuerySourceInput, QuerySourceToolInput } from './querySourceTool.ts'

export const DEFAULT_SOURCE_QUERY_LIMIT = 10

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0
  }
  const parsed = Number.parseInt(cursor, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

export function paginateSourceRows(
  rows: Array<Record<string, unknown>>,
  input: QuerySourceToolInput
): QueryRowsResult {
  const start = parseCursor(input.cursor)
  const limit = input.limit ?? DEFAULT_SOURCE_QUERY_LIMIT
  const sliced = rows.slice(start, start + limit)
  const nextOffset = start + sliced.length
  return {
    rows: sliced,
    ...(nextOffset < rows.length ? { nextCursor: String(nextOffset) } : {})
  }
}

export async function queryRecollections(
  input: QuerySourceInput,
  deps: {
    query: (input: QuerySourceToolInput) => Promise<QueryRowsResult>
    canReadSources: boolean
  }
): Promise<QueryRowsResult & { beforeRef?: string; afterRef?: string }> {
  const { query, canReadSources } = deps
  if (input.ref) {
    if (input.text) throw new Error('Provide text to search or ref to open, not both.')
    const ref = parseSourceEventSourceRowId(input.ref) ?? input.ref
    const parsed = parseRowId(ref)
    let parentRowId = ref
    if (parsed.kind === 'thread_message' && parsed.parts.length === 2) {
      parentRowId = spanRowId(parsed.parts[0]!, parsed.parts[1]!, parsed.parts[1]!)
    } else if (parsed.kind !== 'thread_span' && parsed.kind !== 'thread') {
      throw new Error(
        'Open a thread, thread_span, or thread_message reference. Use advanced queries for other sources.'
      )
    }
    const result = await query({
      from: 'thread_messages',
      view: 'detail',
      where: { parentRowId },
      limit: input.limit,
      cursor: input.cursor
    })
    return {
      ...result,
      ...(result.rows.length
        ? {
            beforeRef: String(result.rows[0]!.rowId),
            afterRef: String(result.rows.at(-1)!.rowId)
          }
        : {})
    }
  }
  const text = input.text?.trim()
  if (!text) throw new Error('Provide text to search, ref to open, or from for an advanced query.')
  if (input.where || input.orderBy || input.view) {
    throw new Error('Use from/where for filtered or ordered queries.')
  }
  // A bounded discovery window; precise queries retain full source pagination.
  const [originals, memories] = await Promise.all([
    canReadSources
      ? query({ from: 'thread_spans', where: { text }, limit: 50 })
      : Promise.resolve({ rows: [] }),
    query({ from: 'memories', where: { text }, limit: 4 })
  ])
  const rows: Array<Record<string, unknown> & { notes: Array<Record<string, unknown>> }> =
    originals.rows.map((row) => ({
      ...row,
      ref: row.rowId,
      excerpt: row.summary,
      notes: [] as Array<Record<string, unknown>>
    }))
  const unresolved: Array<Record<string, unknown>> = []
  for (const memory of memories.rows) {
    const note = { id: memory.memoryId, note: memory.summary }
    const refs = selectMemorySourceReferences({
      sourceMessageRowIds: memory.sourceMessageRowIds as string[] | undefined,
      sourceThreadRowIds: memory.sourceThreadRowIds as string[] | undefined
    })
    let resolved = false
    for (const ref of (canReadSources ? refs : []).slice(0, 3)) {
      const parsed = parseRowId(ref)
      const sourceRef =
        parsed.kind === 'thread_message' && parsed.parts.length === 2
          ? spanRowId(parsed.parts[0]!, parsed.parts[1]!, parsed.parts[1]!)
          : ref
      const source = await query({
        from: parsed.kind === 'thread' ? 'threads' : 'thread_spans',
        view: 'content',
        where: { rowId: sourceRef },
        limit: 1
      })
      const row = source.rows[0]
      if (!row) continue
      resolved = true
      const existing = rows.find(
        (candidate) =>
          candidate.threadId === row.threadId &&
          String(candidate.startedAt) <= String(row.endedAt) &&
          String(candidate.endedAt) >= String(row.startedAt)
      )
      if (existing) {
        if (!existing.notes.some((entry) => entry.id === note.id)) existing.notes.push(note)
      } else {
        rows.push({ ...row, ref: row.rowId, excerpt: row.summary, notes: [note] })
      }
    }
    if (!resolved) unresolved.push({ ...note, sourceAvailable: false })
  }
  return paginateSourceRows([...rows, ...unresolved], {
    from: 'thread_spans',
    limit: input.limit,
    cursor: input.cursor
  })
}
