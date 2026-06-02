import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { ThingDomain } from '../../app/domain/things/thingDomain.ts'
import type { AgentToolContext } from './shared.ts'
import { formatThingDetailText, formatThingListText } from './thingToolFormatting.ts'

type UseThingsInput =
  | { action: 'list'; includeInactive?: boolean }
  | { action: 'get'; name: string }
  | { action: 'create'; name: string; summary: string }
  | { action: 'updateSummary'; name: string; summary: string }
  | { action: 'addCurrentThreadSource'; name: string; preview: string }
  | { action: 'restore'; name: string }

const useThingsInputSchema = z
  .object({
    action: z.enum(['list', 'get', 'create', 'updateSummary', 'addCurrentThreadSource', 'restore']),
    includeInactive: z.boolean().optional(),
    name: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
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
        case 'addCurrentThreadSource':
          return data.name != null && data.preview != null
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
        addCurrentThreadSource: ['action', 'name', 'preview'],
        restore: ['action', 'name']
      }[data.action]
      return Object.keys(data).every((key) => allowed.includes(key))
    },
    { message: 'Unexpected fields for the given action.' }
  )
  .transform((data) => data as UseThingsInput)

interface UseThingsToolOutput {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
  error?: string
}

export interface UseThingsToolDeps {
  thingDomain: ThingDomain
}

const DESCRIPTION = `Manage Things, which are named context indexes referenced as #name.

Use this tool when the current conversation creates or changes a topic, project, decision, or long-running piece of work that should be easy to carry into future conversations. Do not use Things as todos, reminders, task lists, or a database of model-written summaries.

Grounding rules:
- The Thing summary describes the Thing itself: the stable topic, project, decision, or context.
- A source preview describes why the current conversation belongs to that Thing. It is a compact conversation preview, not an exact quote.
- This ordinary conversation tool can only save the current conversation as a source. It cannot attach other conversations or arbitrary sourceRowIds.
- If a future answer needs details from a source, open the saved source reference with querySource instead of relying only on the preview.

Language rule for user-visible text written into a Thing: write summaries and source previews in the main language of the current conversation.

Actions:
- list: inspect existing Things. Set includeInactive true when reviewing or reconciling old context.
- get: open one Thing by name.
- create: create a Thing only when the context is likely to be useful in a later conversation.
- updateSummary: rewrite the Thing summary.
- addCurrentThreadSource: attach the current conversation to a Thing with a source preview.
- restore: mark an inactive Thing as current again.`

function textOutput(text: string, details?: unknown): UseThingsToolOutput {
  return { content: [{ type: 'text', text }], ...(details ? { details } : {}) }
}

function threadRowId(threadId: string): string {
  return `thread:${encodeURIComponent(threadId)}`
}

export function createTool(
  context: AgentToolContext,
  deps: UseThingsToolDeps
): Tool<UseThingsInput, UseThingsToolOutput> {
  return tool({
    description: DESCRIPTION,
    inputSchema: useThingsInputSchema,
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
          case 'addCurrentThreadSource': {
            if (!context.threadId) throw new Error('Current threadId is required.')
            const thing = await deps.thingDomain.upsertSource({
              name: input.name,
              threadId: context.threadId,
              sourceRowId: threadRowId(context.threadId),
              preview: input.preview
            })
            return textOutput(
              thing
                ? `Saved current source for #${thing.name}.\n${formatThingDetailText(thing)}`
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
        const message = error instanceof Error ? error.message : 'useThings failed.'
        return { content: [{ type: 'text', text: message }], error: message }
      }
    }
  })
}

export const useThingsToolDescription = DESCRIPTION
