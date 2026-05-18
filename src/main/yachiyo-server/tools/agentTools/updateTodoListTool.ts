import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { TodoItemRecord } from '../../../../shared/yachiyo/protocol.ts'
import { textContent, toToolModelOutput, type ToolContentBlock } from './shared.ts'

const MAX_TODO_ITEMS = 20
const MAX_TODO_CONTENT_CHARS = 300

const todoItemInputSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TODO_CONTENT_CHARS)
      .describe(
        'User-visible task description. Make it outcome-oriented, independently actionable, and concrete enough that completion is verifiable. Include blocker details here when blocked.'
      ),
    status: z.enum(['pending', 'in_progress', 'completed'])
  })
  .strict()

export const updateTodoListToolInputSchema = z
  .object({
    items: z
      .array(todoItemInputSchema)
      .max(MAX_TODO_ITEMS)
      .describe(
        'The complete current todo list. Send an empty list only when every todo is no longer relevant.'
      )
  })
  .strict()

export type UpdateTodoListToolInput = z.infer<typeof updateTodoListToolInputSchema>
type UpdateTodoListToolInputItem = UpdateTodoListToolInput['items'][number]

export interface UpdateTodoListToolOutput {
  content: ToolContentBlock[]
  metadata: Record<string, never>
}

export interface UpdateTodoListToolContext {
  getCurrentItems: () => readonly TodoItemRecord[]
  createId: () => string
  onUpdate: (items: TodoItemRecord[]) => void
}

export function createUpdateTodoListTool(
  ctx: UpdateTodoListToolContext
): Tool<UpdateTodoListToolInput, UpdateTodoListToolOutput> {
  return tool({
    description:
      'Update the persistent todo widget for multi-step work. ' +
      'Use this only when the user request has three or more independent steps. ' +
      'Always send the full current list, preserving every item status honestly. ' +
      'When all work is finished, keep the completed items in the list instead of clearing it.',
    inputSchema: updateTodoListToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input): Promise<UpdateTodoListToolOutput> => {
      const items = assignTodoItemIds(input.items, ctx.getCurrentItems(), ctx.createId)
      ctx.onUpdate(items)

      return {
        content: textContent(items.length === 0 ? 'Todo list cleared.' : 'Todo list updated.'),
        metadata: {}
      }
    }
  })
}

function assignTodoItemIds(
  inputItems: readonly UpdateTodoListToolInputItem[],
  currentItems: readonly TodoItemRecord[],
  createId: () => string
): TodoItemRecord[] {
  const usedCurrentIndexes = new Set<number>()
  const usedIds = new Set<string>()
  const allowIndexFallback = currentItems.some((item) => item.status !== 'completed')

  return inputItems.map((item, index) => {
    const existing = findExistingTodoItem(
      currentItems,
      item,
      index,
      usedCurrentIndexes,
      usedIds,
      allowIndexFallback
    )
    const id = existing ? existing.item.id : createUniqueTodoItemId(createId, usedIds)

    if (existing) {
      usedCurrentIndexes.add(existing.index)
    }
    usedIds.add(id)

    return {
      id,
      content: item.content,
      status: item.status
    }
  })
}

function findExistingTodoItem(
  currentItems: readonly TodoItemRecord[],
  inputItem: UpdateTodoListToolInputItem,
  inputIndex: number,
  usedCurrentIndexes: ReadonlySet<number>,
  usedIds: ReadonlySet<string>,
  allowIndexFallback: boolean
): { index: number; item: TodoItemRecord } | undefined {
  const contentMatchIndex = currentItems.findIndex(
    (item, index) =>
      item.content === inputItem.content && !usedCurrentIndexes.has(index) && !usedIds.has(item.id)
  )
  if (contentMatchIndex >= 0) {
    return { index: contentMatchIndex, item: currentItems[contentMatchIndex]! }
  }

  const itemAtSameIndex = allowIndexFallback ? currentItems[inputIndex] : undefined
  if (itemAtSameIndex && !usedCurrentIndexes.has(inputIndex) && !usedIds.has(itemAtSameIndex.id)) {
    return { index: inputIndex, item: itemAtSameIndex }
  }

  return undefined
}

function createUniqueTodoItemId(createId: () => string, usedIds: ReadonlySet<string>): string {
  let suffix = 1
  let candidate = createId()
  while (usedIds.has(candidate)) {
    suffix += 1
    candidate = `${createId()}-${suffix}`
  }
  return candidate
}
