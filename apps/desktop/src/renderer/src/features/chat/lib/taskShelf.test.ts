import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeTasks, sortTasks } from './taskShelf.ts'

test('empty and completed tasks do not claim to be running', () => {
  assert.equal(summarizeTasks([]), '')
  assert.equal(summarizeTasks([{ state: 'closed' }]), '1 task')
})

test('mixed tasks combine running counts and retain idle agents without zero noise', () => {
  assert.equal(
    summarizeTasks([
      { state: 'running' },
      { state: 'starting' },
      { state: 'idle' },
      { state: 'closed' }
    ]),
    '2 running · 1 idle'
  )
  assert.equal(summarizeTasks([{ state: 'idle' }]), '1 idle')
  assert.equal(summarizeTasks([{ state: 'failed' }, { state: 'closed' }]), '2 tasks')
})

test('mixed list puts running then idle then finished, preserving chronological activity order', () => {
  const tasks = [
    { state: 'closed', time: '2026-09-12', id: 'closed' },
    { state: 'running', time: '2026-09-11', id: 'shell' },
    { state: 'idle', time: '2026-09-10', id: 'idle' },
    { state: 'starting', time: '2026-09-10', id: 'agent' }
  ]
  assert.deepEqual(
    sortTasks(tasks).map((task) => task.id),
    ['agent', 'shell', 'idle', 'closed']
  )
  assert.equal(tasks[0].id, 'closed')
})
