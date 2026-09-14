import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBrowserOperationLifecycle } from './browserOperationLifecycle.ts'

const input = { threadId: 't', session: 's' }
test('deadline invalidates hanging operation and queued work without starting it', async () => {
  let closed = 0
  let queuedStarted = false
  const lifecycle = createBrowserOperationLifecycle(() => {
    closed++
  }, 10)
  const pending = lifecycle.run(input, () => new Promise(() => {}))
  const queued = lifecycle.run(input, async () => {
    queuedStarted = true
  })
  await Promise.all([assert.rejects(pending, /Timed out/), assert.rejects(queued, /Timed out/)])
  assert.equal(closed, 1)
  assert.equal(queuedStarted, false)
})

test('cancel isolates old continuation and permits a new generation', async () => {
  const lifecycle = createBrowserOperationLifecycle(() => {})
  let release!: () => void
  let mutated = false
  const pending = lifecycle.run(input, async () => {
    await new Promise<void>((resolve) => {
      release = resolve
    })
    lifecycle.assertCurrent()
    mutated = true
  })
  await Promise.resolve()
  lifecycle.invalidate(input, new Error('closed'))
  await assert.rejects(pending, /closed/)
  await lifecycle.run(input, async () => {})
  release()
  await Promise.resolve()
  assert.equal(mutated, false)
})

test('same-session work serializes while other sessions progress', async () => {
  const lifecycle = createBrowserOperationLifecycle(() => {})
  const events: string[] = []
  let release!: () => void
  const first = lifecycle.run(input, async () => {
    await new Promise<void>((r) => {
      release = r
    })
    events.push('first')
  })
  const second = lifecycle.run(input, async () => {
    events.push('second')
  })
  await lifecycle.run({ ...input, session: 'other' }, async () => {
    events.push('other')
  })
  assert.deepEqual(events, ['other'])
  release()
  await Promise.all([first, second])
  assert.deepEqual(events, ['other', 'first', 'second'])
})
