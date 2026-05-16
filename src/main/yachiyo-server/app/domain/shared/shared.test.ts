import { describe, test } from 'node:test'
import assert from 'node:assert'
import { createRunEventMetadata } from './runEventMetadata.ts'
import { createDeltaBatcher } from './shared.ts'

describe('createRunEventMetadata', () => {
  test('includes common run event fields and request message when present', () => {
    assert.deepStrictEqual(
      createRunEventMetadata({
        threadId: 'thread-1',
        runId: 'run-1',
        requestMessageId: 'message-1',
        runTrigger: 'channel'
      }),
      {
        threadId: 'thread-1',
        runId: 'run-1',
        requestMessageId: 'message-1',
        runTrigger: 'channel'
      }
    )
  })

  test('omits request message for assistant-only runs', () => {
    assert.deepStrictEqual(
      createRunEventMetadata({
        threadId: 'thread-1',
        runId: 'run-1',
        runTrigger: 'local'
      }),
      {
        threadId: 'thread-1',
        runId: 'run-1',
        runTrigger: 'local'
      }
    )
  })
})

describe('createDeltaBatcher', () => {
  test('coalesces multiple pushes into one flush', () => {
    const flushed: string[] = []
    const batcher = createDeltaBatcher({
      intervalMs: 0,
      onFlush: (batch) => flushed.push(batch)
    })
    batcher.push('hello')
    batcher.push(' ')
    batcher.push('world')
    batcher.flush()
    assert.deepStrictEqual(flushed, ['hello world'])
  })

  test('explicit flush still processes pending deltas even after abort', () => {
    const flushed: string[] = []
    let aborted = false
    const batcher = createDeltaBatcher({
      intervalMs: 0,
      onFlush: (batch) => flushed.push(batch),
      isAborted: () => aborted
    })
    batcher.push('hello')
    aborted = true
    batcher.flush()
    assert.deepStrictEqual(flushed, ['hello'])
  })

  test('ignores pushes after abort', () => {
    const flushed: string[] = []
    const batcher = createDeltaBatcher({
      intervalMs: 0,
      onFlush: (batch) => flushed.push(batch),
      isAborted: () => true
    })
    batcher.push('hello')
    batcher.flush()
    assert.deepStrictEqual(flushed, [])
  })

  test('timer callback does not discard pending deltas when aborted', async () => {
    const flushed: string[] = []
    let aborted = false
    const batcher = createDeltaBatcher({
      intervalMs: 10,
      onFlush: (batch) => flushed.push(batch),
      isAborted: () => aborted
    })
    batcher.push('hello')

    // Abort before the timer fires.
    aborted = true
    await new Promise((resolve) => setTimeout(resolve, 30))

    // The timer should not have cleared pending; explicit flush still works.
    assert.deepStrictEqual(flushed, [])
    batcher.flush()
    assert.deepStrictEqual(flushed, ['hello'])
  })
})
