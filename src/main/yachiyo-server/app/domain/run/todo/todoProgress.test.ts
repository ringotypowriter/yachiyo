import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TODO_REMINDER_STEP_INTERVAL,
  createTodoProgressState,
  markTodoReminderInjected,
  shouldInjectTodoReminder
} from './todoProgress.ts'

const incompleteItems = [
  { id: 'inspect', content: 'Inspect the existing flow', status: 'completed' as const },
  { id: 'server', content: 'Wire the server event', status: 'in_progress' as const },
  { id: 'ui', content: 'Render the widget', status: 'pending' as const }
]

test('todo reminder counts the todo update call as the first interval step', () => {
  const state = createTodoProgressState({
    items: incompleteItems,
    step: 1
  })

  assert.equal(shouldInjectTodoReminder(state, 9), false)
  assert.equal(shouldInjectTodoReminder(state, 10), true)
})

test('todo reminder repeats every ten steps until the list is completed or updated', () => {
  let state = createTodoProgressState({
    items: incompleteItems,
    step: 0
  })

  assert.equal(shouldInjectTodoReminder(state, TODO_REMINDER_STEP_INTERVAL), true)
  state = markTodoReminderInjected(state, TODO_REMINDER_STEP_INTERVAL)
  assert.equal(shouldInjectTodoReminder(state, TODO_REMINDER_STEP_INTERVAL + 9), false)
  assert.equal(shouldInjectTodoReminder(state, TODO_REMINDER_STEP_INTERVAL * 2), true)

  state = createTodoProgressState({
    items: incompleteItems.map((item) => ({ ...item, status: 'completed' as const })),
    step: TODO_REMINDER_STEP_INTERVAL * 2
  })
  assert.equal(shouldInjectTodoReminder(state, TODO_REMINDER_STEP_INTERVAL * 3), false)
})
