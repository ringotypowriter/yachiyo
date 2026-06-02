import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { ThingDomain } from '../../app/domain/things/thingDomain.ts'
import { formatThingDetailText, formatThingListText } from './thingToolFormatting.ts'

type ReviewThingsInput =
  | { action: 'list'; includeInactive?: boolean }
  | { action: 'get'; name: string }
  | { action: 'create'; name: string; summary: string }
  | { action: 'updateSummary'; name: string; summary: string }
  | { action: 'addReviewedSource'; name: string; sourceRowId: string; preview: string }
  | { action: 'restore'; name: string }

const reviewThingsInputSchema = z
  .object({
    action: z.enum(['list', 'get', 'create', 'updateSummary', 'addReviewedSource', 'restore']),
    includeInactive: z.boolean().optional(),
    name: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    sourceRowId: z.string().min(1).optional(),
    preview: z.string().min(1).optional()
  })
  .passthrough()
  .refine(
    (data) => {
      switch (data.action) {
        case 'list':
          return true
        case 'get':
        case 'restore':
          return data.name != null
        case 'create':
        case 'updateSummary':
          return data.name != null && data.summary != null
        case 'addReviewedSource':
          return data.name != null && data.sourceRowId != null && data.preview != null
      }
    },
    { message: 'Missing required fields for the given action.' }
  )
  .refine(
    (data) => {
      const allowed = {
        list: ['action', 'includeInactive'],
        get: ['action', 'name'],
        create: ['action', 'name', 'summary'],
        updateSummary: ['action', 'name', 'summary'],
        addReviewedSource: ['action', 'name', 'sourceRowId', 'preview'],
        restore: ['action', 'name']
      }[data.action]
      return Object.keys(data).every((key) => allowed.includes(key))
    },
    { message: 'Unexpected fields for the given action.' }
  )
  .transform((data) => data as ReviewThingsInput)

interface ReviewThingsToolOutput {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
  error?: string
}

export interface ReviewThingsToolDeps {
  thingDomain: ThingDomain
}

interface ParsedRowId {
  kind: string
  parts: string[]
}

interface ReviewedSourceRef {
  threadId: string
  messageId?: string
  spanRowId?: string
  sourceRowId: string
}

const DESCRIPTION = `Review Things from scheduled source review runs.

Use this schedule-only tool when a daily review identifies a past conversation that should be attached to a Thing. Do not use it as a todo list, reminder system, or batch summary database.

Grounding rules:
- The Thing summary describes the Thing itself: the stable topic, project, decision, or context.
- A source preview describes the main content of one reviewed conversation source. It is not an exact quote.
- Always pass a sourceRowId returned by querySource. This tool derives threadId and message/span references from that rowId.
- Only thread, thread_span, and thread_message rowIds can be saved as Thing sources.
- If a future answer needs details from a source, open the saved sourceRowId with querySource.

Actions:
- list: inspect existing Things. Set includeInactive true when reviewing or reconciling old context.
- get: open one Thing by name.
- create: create a Thing only when the context is likely to be useful in a later conversation.
- updateSummary: rewrite the Thing summary.
- addReviewedSource: attach one reviewed thread source to a Thing with a source preview.
- restore: mark an inactive Thing as current again.`

function textOutput(text: string, details?: unknown): ReviewThingsToolOutput {
  return { content: [{ type: 'text', text }], ...(details ? { details } : {}) }
}

function parseSourceEventSourceRowId(rowId: string): string {
  const prefix = 'source_event:'
  return rowId.startsWith(prefix) ? rowId.slice(prefix.length) : rowId
}

function parseRowId(rowId: string): ParsedRowId {
  const [kind, ...encodedParts] = rowId.split(':')
  return {
    kind: kind ?? '',
    parts: encodedParts.map((part) => decodeURIComponent(part))
  }
}

function parseReviewedSourceRowId(sourceRowId: string): ReviewedSourceRef {
  const normalizedSourceRowId = parseSourceEventSourceRowId(sourceRowId)
  const parsed = parseRowId(normalizedSourceRowId)

  if (parsed.kind === 'thread' && parsed.parts.length === 1) {
    return {
      threadId: parsed.parts[0] ?? '',
      sourceRowId: normalizedSourceRowId
    }
  }

  if (parsed.kind === 'thread_message' && parsed.parts.length === 2) {
    return {
      threadId: parsed.parts[0] ?? '',
      messageId: parsed.parts[1] ?? '',
      sourceRowId: normalizedSourceRowId
    }
  }

  if (parsed.kind === 'thread_span' && parsed.parts.length === 3) {
    return {
      threadId: parsed.parts[0] ?? '',
      spanRowId: normalizedSourceRowId,
      sourceRowId: normalizedSourceRowId
    }
  }

  throw new Error('reviewThings can only save thread source rowIds.')
}

export function createTool(
  deps: ReviewThingsToolDeps
): Tool<ReviewThingsInput, ReviewThingsToolOutput> {
  return tool({
    description: DESCRIPTION,
    inputSchema: reviewThingsInputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input) => {
      try {
        switch (input.action) {
          case 'list': {
            const things = await deps.thingDomain.listThings({
              includeInactive: input.includeInactive
            })
            return textOutput(formatThingListText(things), { things })
          }
          case 'get': {
            const thing = await deps.thingDomain.getThing(input.name)
            return thing
              ? textOutput(formatThingDetailText(thing), { thing })
              : textOutput(`Thing not found: #${input.name}`, { thing: null })
          }
          case 'create': {
            const thing = await deps.thingDomain.createThing({
              name: input.name,
              summary: input.summary
            })
            return textOutput(`Created #${thing.name}.\n${formatThingDetailText(thing)}`, { thing })
          }
          case 'updateSummary': {
            const thing = await deps.thingDomain.updateThing({
              name: input.name,
              summary: input.summary
            })
            return textOutput(
              thing
                ? `Updated #${thing.name}.\n${formatThingDetailText(thing)}`
                : 'Thing not found.',
              { thing }
            )
          }
          case 'addReviewedSource': {
            const source = parseReviewedSourceRowId(input.sourceRowId)
            const thing = await deps.thingDomain.upsertSource({
              name: input.name,
              threadId: source.threadId,
              ...(source.messageId ? { messageId: source.messageId } : {}),
              ...(source.spanRowId ? { spanRowId: source.spanRowId } : {}),
              sourceRowId: source.sourceRowId,
              preview: input.preview
            })
            return textOutput(
              thing
                ? `Saved reviewed source for #${thing.name}.\n${formatThingDetailText(thing)}`
                : 'Thing not found.',
              {
                thing
              }
            )
          }
          case 'restore': {
            const thing = await deps.thingDomain.restoreThing(input.name)
            return textOutput(
              thing
                ? `Restored #${thing.name}.\n${formatThingDetailText(thing)}`
                : 'Thing not found.',
              { thing }
            )
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'reviewThings failed.'
        return { content: [{ type: 'text', text: message }], error: message }
      }
    }
  })
}

export const reviewThingsToolDescription = DESCRIPTION
