import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { ThingDomain } from '../../app/domain/things/thingDomain.ts'

const quoteInputSchema = z.object({
  name: z.string().min(1),
  threadId: z.string().min(1),
  messageId: z.string().optional(),
  spanRowId: z.string().optional(),
  sourceRowId: z.string().min(1),
  quote: z.string().min(1)
})

const useThingsInputSchema = z.object({
  action: z.enum([
    'list',
    'get',
    'create',
    'updateSummary',
    'linkThread',
    'unlinkThread',
    'addQuote',
    'reactivate',
    'dailyReview'
  ]),
  name: z.string().optional(),
  summary: z.string().optional(),
  includeInactive: z.boolean().optional(),
  threadId: z.string().optional(),
  sourceRowId: z.string().optional(),
  messageId: z.string().optional(),
  spanRowId: z.string().optional(),
  quote: z.string().optional(),
  creates: z
    .array(
      z.object({
        name: z.string().min(1),
        summary: z.string().min(1),
        threadId: z.string().optional(),
        sourceQuotes: z
          .array(
            z.object({
              threadId: z.string().min(1),
              messageId: z.string().optional(),
              spanRowId: z.string().optional(),
              sourceRowId: z.string().min(1),
              quote: z.string().min(1)
            })
          )
          .optional()
      })
    )
    .optional(),
  summaryUpdates: z
    .array(z.object({ name: z.string().min(1), summary: z.string().min(1) }))
    .optional(),
  threadLinks: z
    .array(z.object({ name: z.string().min(1), threadId: z.string().min(1) }))
    .optional(),
  quotes: z.array(quoteInputSchema).optional(),
  reactivations: z.array(z.object({ name: z.string().min(1) })).optional()
})

type UseThingsInput = z.infer<typeof useThingsInputSchema>

interface UseThingsToolOutput {
  content: Array<{ type: 'text'; text: string }>
  details?: unknown
  error?: string
}

export interface UseThingsToolDeps {
  thingDomain: ThingDomain
}

const DESCRIPTION = `Manage Things, which are named cross-chat context indexes referenced as #name.

Use this tool when a topic, project, decision, or long-running piece of work should be easy to carry into future conversations. Do not use Things as todos, reminders, task lists, or a database of model-written summaries.

Grounding rules:
- Treat source quotes and references as the factual record.
- Treat summary as a short recognition label only; never rely on it as evidence.
- When saving a quote, preserve the original quote text exactly enough to verify the claim.
- Always save sourceRowId. Save threadId and messageId/spanRowId when available.

Language rule for user-visible text written into a Thing: write summaries and review-created descriptions in the main language of the included chats/source quotes. If the sources are mixed, use the language the user used most in those related chats/source quotes.

Actions:
- list: inspect existing Things. Set includeInactive true when reviewing or reconciling old context.
- get: open one Thing by name.
- create: create a Thing only when the context is likely to be useful in a later conversation.
- updateSummary: rewrite the recognition summary without changing the evidence.
- linkThread/unlinkThread: connect or disconnect a chat from a Thing.
- addQuote: attach factual evidence to a Thing.
- reactivate: mark an inactive Thing as current again.
- dailyReview: batch creates, summaryUpdates, threadLinks, quotes, and reactivations; the tool applies them in that order.`

function textOutput(text: string, details?: unknown): UseThingsToolOutput {
  return { content: [{ type: 'text', text }], ...(details ? { details } : {}) }
}

function requireString(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required.`)
  return value
}

export function createTool(deps: UseThingsToolDeps): Tool<UseThingsInput, UseThingsToolOutput> {
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
            return textOutput(`Found ${things.length} thing${things.length === 1 ? '' : 's'}.`, {
              things
            })
          }
          case 'get': {
            const name = requireString(input.name, 'name')
            const thing = await deps.thingDomain.getThing(name)
            return thing
              ? textOutput(`#${thing.name}`, { thing })
              : textOutput(`Thing not found: #${name}`, { thing: null })
          }
          case 'create': {
            const thing = await deps.thingDomain.createThing({
              name: requireString(input.name, 'name'),
              summary: requireString(input.summary, 'summary'),
              ...(input.threadId ? { threadId: input.threadId } : {})
            })
            return textOutput(`Created #${thing.name}.`, { thing })
          }
          case 'updateSummary': {
            const thing = await deps.thingDomain.updateThing({
              name: requireString(input.name, 'name'),
              summary: requireString(input.summary, 'summary')
            })
            return textOutput(thing ? `Updated #${thing.name}.` : 'Thing not found.', { thing })
          }
          case 'linkThread': {
            const thing = await deps.thingDomain.linkThread({
              name: requireString(input.name, 'name'),
              threadId: requireString(input.threadId, 'threadId')
            })
            return textOutput(thing ? `Linked #${thing.name}.` : 'Thing not found.', { thing })
          }
          case 'unlinkThread': {
            const thing = await deps.thingDomain.unlinkThread({
              name: requireString(input.name, 'name'),
              threadId: requireString(input.threadId, 'threadId')
            })
            return textOutput(thing ? `Unlinked #${thing.name}.` : 'Thing not found.', { thing })
          }
          case 'addQuote': {
            const thing = await deps.thingDomain.addQuote({
              name: requireString(input.name, 'name'),
              threadId: requireString(input.threadId, 'threadId'),
              messageId: input.messageId,
              spanRowId: input.spanRowId,
              sourceRowId: requireString(input.sourceRowId, 'sourceRowId'),
              quote: requireString(input.quote, 'quote')
            })
            return textOutput(thing ? `Added quote to #${thing.name}.` : 'Thing not found.', {
              thing
            })
          }
          case 'reactivate': {
            const thing = await deps.thingDomain.reactivateThing(requireString(input.name, 'name'))
            return textOutput(thing ? `Reactivated #${thing.name}.` : 'Thing not found.', { thing })
          }
          case 'dailyReview': {
            let changed = 0
            for (const create of input.creates ?? []) {
              await deps.thingDomain.createThing(create)
              changed += 1
            }
            for (const update of input.summaryUpdates ?? []) {
              if (await deps.thingDomain.updateThing(update)) changed += 1
            }
            for (const link of input.threadLinks ?? []) {
              if (await deps.thingDomain.linkThread(link)) changed += 1
            }
            for (const quote of input.quotes ?? []) {
              if (await deps.thingDomain.addQuote(quote)) changed += 1
            }
            for (const item of input.reactivations ?? []) {
              if (await deps.thingDomain.reactivateThing(item.name)) changed += 1
            }
            const things = await deps.thingDomain.listThings({ includeInactive: true })
            const inactiveThings = things.filter((thing) => thing.isInactive)
            return textOutput(`Daily review changed ${changed} item${changed === 1 ? '' : 's'}.`, {
              things,
              inactiveThings,
              counts: { changed, inactive: inactiveThings.length }
            })
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
