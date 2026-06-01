import assert from 'node:assert/strict'
import test from 'node:test'

import type { TodoItemRecord } from '@renderer/app/types'
import { getTodoProgressCount } from './todoProgressPresentation.ts'

const items: TodoItemRecord[] = [
  { id: 'done', content: 'Finish the first step', status: 'completed' },
  { id: 'active', content: 'Work on the second step', status: 'in_progress' },
  { id: 'next', content: 'Do the final step', status: 'pending' }
]

test('todo progress count only includes completed items', () => {
  assert.deepEqual(getTodoProgressCount(items), {
    completed: 1,
    total: 3
  })
})
