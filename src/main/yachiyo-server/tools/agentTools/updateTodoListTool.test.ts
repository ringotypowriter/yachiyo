import assert from 'node:assert/strict'
import test from 'node:test'

import { isTrackedToolName } from '../../../../shared/yachiyo/protocol.ts'
import type { TodoItemRecord } from '../../../../shared/yachiyo/protocol.ts'
import {
  createUpdateTodoListTool,
  updateTodoListToolInputSchema,
  type UpdateTodoListToolOutput
} from './updateTodoListTool.ts'

test('updateTodoList input accepts one active item and completed items', () => {
  const result = updateTodoListToolInputSchema.safeParse({
    items: [
      { content: 'Inspect the existing flow', status: 'completed' },
      { content: 'Wire the server event', status: 'in_progress' },
      { content: 'Render the widget', status: 'pending' }
    ]
  })

  assert.equal(result.success, true)
})

test('updateTodoList input accepts multiple in-progress items', () => {
  const result = updateTodoListToolInputSchema.safeParse({
    items: [
      { content: 'Wire the server event', status: 'in_progress' },
      { content: 'Render the widget', status: 'in_progress' }
    ]
  })

  assert.equal(result.success, true)
})

test('updateTodoList input rejects model-provided item ids', () => {
  const result = updateTodoListToolInputSchema.safeParse({
    items: [{ id: 'server', content: 'Wire the server event', status: 'in_progress' }]
  })

  assert.equal(result.success, false)
})

test('updateTodoList assigns stable ids without becoming a tracked timeline tool', async () => {
  const emitted: TodoItemRecord[][] = []
  const tool = createUpdateTodoListTool({
    getCurrentItems: () => [],
    createId: createSequentialId(),
    onUpdate: (items) => {
      emitted.push(items)
    }
  })

  const output = (await tool.execute!(
    {
      items: [
        { content: 'Inspect the existing flow', status: 'completed' },
        { content: 'Wire the server event', status: 'in_progress' }
      ]
    },
    { abortSignal: AbortSignal.timeout(5000), toolCallId: 'todo-1', messages: [] }
  )) as UpdateTodoListToolOutput

  assert.deepEqual(emitted, [
    [
      { id: 'todo-1', content: 'Inspect the existing flow', status: 'completed' },
      { id: 'todo-2', content: 'Wire the server event', status: 'in_progress' }
    ]
  ])
  assert.deepEqual(output.content, [{ type: 'text', text: 'Todo list updated.' }])
  assert.equal(isTrackedToolName('updateTodoList'), false)
})

test('updateTodoList emits multiple in-progress items unchanged', async () => {
  const emitted: TodoItemRecord[][] = []
  const tool = createUpdateTodoListTool({
    getCurrentItems: () => [],
    createId: createSequentialId(),
    onUpdate: (items) => {
      emitted.push(items)
    }
  })

  await tool.execute!(
    {
      items: [
        { content: 'Wire the server event', status: 'in_progress' },
        { content: 'Render the widget', status: 'in_progress' },
        { content: 'Verify the result', status: 'pending' }
      ]
    },
    { abortSignal: AbortSignal.timeout(5000), toolCallId: 'todo-2', messages: [] }
  )

  assert.deepEqual(emitted, [
    [
      { id: 'todo-1', content: 'Wire the server event', status: 'in_progress' },
      { id: 'todo-2', content: 'Render the widget', status: 'in_progress' },
      { id: 'todo-3', content: 'Verify the result', status: 'pending' }
    ]
  ])
})

test('updateTodoList preserves ids from existing todo items', async () => {
  const emitted: TodoItemRecord[][] = []
  const tool = createUpdateTodoListTool({
    getCurrentItems: () => [
      { id: 'existing-server-id', content: 'Wire the server event', status: 'pending' }
    ],
    createId: createSequentialId(),
    onUpdate: (items) => {
      emitted.push(items)
    }
  })

  await tool.execute!(
    {
      items: [
        { content: 'Wire the server event', status: 'completed' },
        { content: 'Verify the result', status: 'pending' }
      ]
    },
    { abortSignal: AbortSignal.timeout(5000), toolCallId: 'todo-3', messages: [] }
  )

  assert.deepEqual(emitted, [
    [
      { id: 'existing-server-id', content: 'Wire the server event', status: 'completed' },
      { id: 'todo-1', content: 'Verify the result', status: 'pending' }
    ]
  ])
})

test('updateTodoList keeps an existing id when the item text changes in place', async () => {
  const emitted: TodoItemRecord[][] = []
  const tool = createUpdateTodoListTool({
    getCurrentItems: () => [
      { id: 'existing-1', content: 'Inspect the existing flow', status: 'completed' },
      { id: 'existing-2', content: 'Wire the server event', status: 'in_progress' }
    ],
    createId: createSequentialId(),
    onUpdate: (items) => {
      emitted.push(items)
    }
  })

  await tool.execute!(
    {
      items: [
        { content: 'Inspect the existing flow', status: 'completed' },
        {
          content: 'Wire the server event (blocked on renderer wiring)',
          status: 'in_progress'
        }
      ]
    },
    { abortSignal: AbortSignal.timeout(5000), toolCallId: 'todo-4', messages: [] }
  )

  assert.deepEqual(emitted, [
    [
      { id: 'existing-1', content: 'Inspect the existing flow', status: 'completed' },
      {
        id: 'existing-2',
        content: 'Wire the server event (blocked on renderer wiring)',
        status: 'in_progress'
      }
    ]
  ])
})

function createSequentialId(): () => string {
  let nextId = 1
  return () => `todo-${nextId++}`
}
