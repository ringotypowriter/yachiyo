import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolCallRecord } from '@yachiyo/shared/protocol'
import { createDeckSummaryScheduler } from './deckSummary.ts'

const tool = (id: string, status: ToolCallRecord['status'] = 'completed'): ToolCallRecord => ({
  id,
  threadId: 'thread',
  runId: 'run',
  requestMessageId: 'request',
  toolName: 'read',
  status,
  inputSummary: `/tmp/${id}`,
  outputSummary: 'Read file',
  startedAt: new Date().toISOString()
})
const tick = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test('summarizes the first completed tool early and persists only on deck head', async () => {
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async () => 'Reading project files',
    update: (call) => updates.push(call)
  })
  scheduler.complete(tool('a'))
  await tick()
  assert.equal(updates[0]?.id, 'a')
  assert.equal(updates[0]?.deckSummary, 'Reading project files')
  scheduler.close()
})

test('coalesces in-flight results and never writes stale summaries after a text boundary', async () => {
  const pending: Array<(text: string) => void> = []
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: () => new Promise((resolve) => pending.push(resolve)),
    update: (call) => updates.push(call),
    throttleMs: 0
  })
  scheduler.complete(tool('a'))
  await tick()
  scheduler.complete(tool('b'))
  scheduler.textBoundary()
  scheduler.complete(tool('c'))
  assert.equal(pending.length, 1)
  pending[0]('Old deck')
  await tick()
  assert.equal(updates.length, 0)
  assert.equal(pending.length, 2)
  pending[1]('Refreshed old deck')
  await tick()
  assert.equal(updates[0]?.id, 'a')
  assert.equal(pending.length, 3)
  pending[2]('New deck')
  await tick()
  assert.equal(updates[1]?.id, 'c')
  scheduler.close()
})

test('final flush refreshes latest deck without waiting for generation', async () => {
  const prompts: string[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async (calls) => {
      prompts.push(calls.map((call) => call.id).join(','))
      return 'Done'
    },
    update: () => {},
    throttleMs: 8000
  })
  scheduler.complete(tool('a'))
  await tick()
  scheduler.complete(tool('b'))
  scheduler.finish()
  await tick()
  assert.deepEqual(prompts, ['a', 'a,b'])
})

test('reverse finish order still writes summary to earliest started tool', async () => {
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async () => 'Work',
    update: (call) => updates.push(call)
  })
  scheduler.start(tool('first', 'running'))
  scheduler.start(tool('second', 'running'))
  scheduler.complete(tool('second'))
  await tick()
  assert.equal(updates[0]?.id, 'first')
  scheduler.close()
})

test('preparing order determines deck head when starts arrive in reverse order', async () => {
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async () => 'Work',
    update: (call) => updates.push(call)
  })
  scheduler.start(tool('first', 'preparing'))
  scheduler.start(tool('second', 'preparing'))
  scheduler.start(tool('second', 'running'))
  scheduler.complete(tool('second'))
  await tick()
  assert.equal(updates[0]?.id, 'first')
  scheduler.close()
})

test('canonical start id replaces its orphaned preparing id without losing deck order', async () => {
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async () => 'Work',
    update: (call) => updates.push(call)
  })
  scheduler.start(tool('provisional', 'preparing'))
  scheduler.start(tool('second', 'preparing'))
  scheduler.start(tool('canonical', 'running'), 'provisional')
  scheduler.complete(tool('second'))
  await tick()
  assert.equal(updates[0]?.id, 'canonical')
  scheduler.close()
})

test('a text boundary seals previous deck without losing its in-flight summary', async () => {
  const pending: Array<(text: string) => void> = []
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: () => new Promise((resolve) => pending.push(resolve)),
    update: (call) => updates.push(call)
  })
  scheduler.complete(tool('old'))
  scheduler.textBoundary()
  scheduler.complete(tool('new'))
  pending[0]('Old summary')
  await tick()
  assert.equal(updates[0]?.id, 'old')
  assert.equal(pending.length, 2)
  pending[1]('New summary')
  await tick()
  assert.equal(updates[1]?.id, 'new')
  scheduler.close()
})

test('new deck starts immediately even when another deck awaits throttled refresh', async () => {
  const prompts: string[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async (calls) => {
      prompts.push(calls.map((call) => call.id).join(','))
      return 'Work'
    },
    update: () => {},
    throttleMs: 8000
  })
  scheduler.complete(tool('a'))
  await tick()
  scheduler.complete(tool('b'))
  scheduler.textBoundary()
  scheduler.complete(tool('c'))
  await tick()
  assert.deepEqual(prompts, ['a', 'a,b', 'c'])
  scheduler.close()
})

test('a tool started before text remains in its original deck when it finishes afterward', async () => {
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async () => 'Old work',
    update: (call) => updates.push(call)
  })
  scheduler.start(tool('old', 'running'))
  scheduler.textBoundary()
  scheduler.complete(tool('old'))
  await tick()
  assert.equal(updates[0]?.id, 'old')
  scheduler.close()
})
