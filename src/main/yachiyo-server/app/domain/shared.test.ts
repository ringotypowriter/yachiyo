import { describe, test } from 'node:test'
import assert from 'node:assert'
import { createDeltaBatcher } from './shared.ts'

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
