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
  inputSummary: status === 'preparing' ? '' : `/tmp/${id}`,
  ...(status === 'completed' ? { outputSummary: 'Read file' } : {}),
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

test('publishes an in-flight snapshot despite later calls and refreshes sealed decks', async () => {
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
  assert.equal(updates[0]?.id, 'a')
  assert.equal(updates[0]?.deckSummary, 'Old deck')
  assert.equal(pending.length, 2)
  pending[1]('Refreshed old deck')
  await tick()
  assert.equal(updates[1]?.id, 'a')
  assert.equal(pending.length, 3)
  pending[2]('New deck')
  await tick()
  assert.equal(updates[2]?.id, 'c')
  scheduler.close()
})

test('starts at first input-bearing running call, never at blank preparing state', async () => {
  const prompts: ToolCallRecord[][] = []
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async (calls) => {
      prompts.push(calls)
      return 'Reading source'
    },
    update: (call) => updates.push(call)
  })
  scheduler.start(tool('provisional', 'preparing'))
  scheduler.start(tool('second', 'preparing'))
  await tick()
  assert.equal(prompts.length, 0)
  scheduler.start(tool('canonical', 'running'), 'provisional')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0][0].id, 'canonical')
  assert.equal(prompts[0][0].inputSummary, '/tmp/canonical')
  assert.equal(prompts[0][0].outputSummary, undefined)
  await tick()
  assert.equal(updates[0]?.id, 'canonical')
  scheduler.close()
})

test('fourteen rapid completions cannot starve the initial summary or bypass refresh throttle', async () => {
  const pending: Array<(text: string) => void> = []
  const prompts: string[] = []
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: (calls) => {
      prompts.push(calls.map((call) => call.id).join(','))
      return new Promise((resolve) => pending.push(resolve))
    },
    update: (call) => updates.push(call),
    throttleMs: 80
  })
  scheduler.start(tool('first', 'preparing'))
  scheduler.start(tool('first', 'running'))
  assert.deepEqual(prompts, ['first'])
  for (let index = 0; index < 14; index++) scheduler.complete(tool(`call-${index}`))
  pending[0]('Reading source')
  await tick()
  assert.deepEqual(
    updates.map((call) => call.deckSummary),
    ['Reading source']
  )
  assert.equal(updates[0].id, 'first')
  assert.equal(prompts.length, 1)
  scheduler.finish()
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].split(',').length, 15)
  pending[1]('Reviewing files')
  await tick()
  assert.equal(updates[1]?.deckSummary, 'Reviewing files')
  scheduler.close()
})

test('subsequent rapid revisions coalesce into one throttled refresh', async () => {
  const prompts: string[] = []
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async (calls) => {
      prompts.push(calls.map((call) => call.id).join(','))
      return 'Work'
    },
    update: (call) => updates.push(call),
    throttleMs: 60
  })
  scheduler.start(tool('first', 'running'))
  await tick()
  for (let index = 0; index < 14; index++) scheduler.complete(tool(`call-${index}`))
  assert.deepEqual(prompts, ['first'])
  await new Promise((resolve) => setTimeout(resolve, 90))
  assert.equal(prompts.length, 2)
  assert.equal(prompts[1].split(',').length, 15)
  assert.deepEqual(
    updates.map((call) => call.id),
    ['first', 'first']
  )
  scheduler.close()
})

test('empty model output is not published or retried without a new revision', async () => {
  let requests = 0
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: async () => {
      requests++
      return undefined
    },
    update: (call) => updates.push(call),
    throttleMs: 20
  })
  scheduler.start(tool('first', 'running'))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(requests, 1)
  assert.deepEqual(updates, [])
  scheduler.close()
})

test('a remapped preparing head retains its canonical ID when a prior snapshot resolves', async () => {
  const pending: Array<(text: string) => void> = []
  const updates: ToolCallRecord[] = []
  const scheduler = createDeckSummaryScheduler({
    generate: () => new Promise((resolve) => pending.push(resolve)),
    update: (call) => updates.push(call),
    throttleMs: 80
  })
  scheduler.start(tool('provisional', 'preparing'))
  scheduler.start(tool('second', 'running'))
  scheduler.start(tool('canonical', 'running'), 'provisional')
  pending[0]('Reading files')
  await tick()
  assert.equal(updates[0]?.id, 'canonical')
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
