import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parseRowId, parseSpanRowId } from '@yachiyo/shared/sourceRowIds'
import {
  normalizeCognitiveName,
  type CognitiveEvidenceRef,
  type CognitivePatch
} from '../cognitiveMemory.ts'
import type { CognitiveMemoryStore } from '../cognitiveMemoryStore.ts'

export interface NoteInput {
  note?: string
  id?: string
  action?: 'save' | 'delete'
  sources?: string[]
}

export interface NoteContext {
  threadId?: string
  messageId?: string
  toolCallId?: string
  workspacePath?: string
}

export interface NoteWriteResult {
  savedCount: number
  id?: string
  deleted?: boolean
  rejected?: string
}

export function noteSourceEvidence(sources: string[]): CognitiveEvidenceRef[] {
  return sources.flatMap((source): CognitiveEvidenceRef[] => {
    const span = parseSpanRowId(source)
    if (span)
      return [...new Set([span.startMessageId, span.endMessageId])].map((messageId) => ({
        kind: 'message',
        threadId: span.threadId,
        messageId
      }))
    const parsed = parseRowId(source)
    if (parsed.kind === 'thread_message' && parsed.parts.length === 2) {
      return [{ kind: 'message', threadId: parsed.parts[0]!, messageId: parsed.parts[1]! }]
    }
    if (parsed.kind === 'thread' && parsed.parts.length === 1) {
      return [{ kind: 'thread', threadId: parsed.parts[0]! }]
    }
    throw new Error(`Invalid conversation source: ${source}`)
  })
}

export function buildNotePatch(input: {
  note: string
  evidence: CognitiveEvidenceRef[]
  key?: string
  relation?: string
  scope?: Record<string, string>
}): CognitivePatch {
  return {
    operations: [
      {
        type: 'upsertRelation',
        relation: input.relation ?? 'notes',
        columns: ['note'],
        evidence: input.evidence
      },
      {
        type: 'upsertRow',
        relation: input.relation ?? 'notes',
        key: input.key ?? randomUUID(),
        values: { note: input.note },
        replace: true,
        evidence: input.evidence,
        scope: input.scope
      }
    ]
  }
}

export async function writeNote(
  store: CognitiveMemoryStore,
  input: NoteInput,
  context: NoteContext = {}
): Promise<NoteWriteResult> {
  const state = await store.readState()
  const existing = input.id ? state.rows.find((row) => row.id === input.id) : undefined
  if (input.id && !existing) return { savedCount: 0, rejected: 'Note not found.' }
  if (input.action === 'delete') {
    if (!input.id) return { savedCount: 0, rejected: 'Deleting a note requires its id.' }
    return { savedCount: 0, id: input.id, ...(await store.deleteRow({ id: input.id })) }
  }
  if (!input.note?.trim()) return { savedCount: 0, rejected: 'A note needs non-empty text.' }
  const evidence = noteSourceEvidence(input.sources ?? [])
  if (context.threadId)
    evidence.push({
      kind: context.messageId ? 'message' : 'thread',
      threadId: context.threadId,
      ...(context.messageId ? { messageId: context.messageId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {})
    })
  if (!evidence.length && !existing?.evidence.length)
    evidence.push({ kind: 'manual', note: 'Source unavailable.' })
  const patch = buildNotePatch({
    note: input.note,
    evidence: [...(existing?.evidence ?? []), ...evidence],
    ...(existing ? { key: existing.key, relation: existing.relation, scope: existing.scope } : {})
  })
  await store.applyPatch(patch)
  const operation = patch.operations[1]!
  const row = (await store.readState()).rows.find(
    (row) =>
      operation.type === 'upsertRow' &&
      row.relation === operation.relation &&
      row.key === normalizeCognitiveName(operation.key)
  )
  return { savedCount: row ? 1 : 0, id: row?.id }
}

const generatedNotesSchema = z.object({
  notes: z
    .array(
      z.object({
        note: z.string().min(1).max(8000),
        sources: z.array(z.string()).min(1).max(12)
      })
    )
    .max(4)
})

export async function saveGeneratedNotes(
  store: CognitiveMemoryStore,
  text: string,
  availableSources: string[],
  signal?: AbortSignal
): Promise<NoteWriteResult> {
  let json: unknown
  try {
    json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gu, '').trim())
  } catch {
    return { savedCount: 0 }
  }
  const parsed = generatedNotesSchema.safeParse(json)
  if (!parsed.success) return { savedCount: 0 }
  const available = new Set(availableSources)
  const state = await store.readState()
  const patch: CognitivePatch = { operations: [] }
  const keys = new Set(state.rows.filter((row) => row.relation === 'notes').map((row) => row.key))
  let savedCount = 0
  for (const item of parsed.data.notes) {
    if (!item.note.trim() || item.sources.some((ref) => !available.has(ref))) continue
    const sources = [...new Set(item.sources)].sort()
    const evidence = noteSourceEvidence(sources)
    const key = createHash('sha256')
      .update(JSON.stringify([item.note, sources]))
      .digest('hex')
    if (keys.has(key)) continue
    // Exact duplicates are skipped, never semantically merged or used to revise another note.
    if (
      state.rows.some(
        (row) =>
          row.values.note === item.note &&
          evidence.every((ref) =>
            row.evidence.some(
              (old) => old.threadId === ref.threadId && old.messageId === ref.messageId
            )
          )
      )
    )
      continue
    patch.operations.push(...buildNotePatch({ note: item.note, evidence, key }).operations)
    keys.add(key)
    savedCount++
  }
  signal?.throwIfAborted()
  if (savedCount) await store.applyPatch(patch)
  return { savedCount }
}
