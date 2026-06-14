import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import { createToolProgressReporter } from './channelToolProgressReporter.ts'

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval

afterEach(() => {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
})

describe('createToolProgressReporter', () => {
  it('does not send a queued progress report after stop', async () => {
    let intervalCallback: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void) => {
      intervalCallback = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval
    globalThis.clearInterval = (() => undefined) as typeof clearInterval

    let listener: ((event: YachiyoServerEvent) => void) | undefined
    const sent: string[] = []
    const reporter = createToolProgressReporter({
      threadId: 'thread-1',
      runId: 'run-1',
      intervalMs: 1,
      subscribe: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      sendMessage: async (text) => {
        sent.push(text)
      }
    })

    listener?.({
      type: 'tool.updated',
      threadId: 'thread-1',
      runId: 'run-1',
      toolCall: {
        id: 'tool-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'path=/tmp/a.txt'
      }
    } as YachiyoServerEvent)

    reporter.stop()
    intervalCallback?.()
    await Promise.resolve()

    assert.deepEqual(sent, [])
  })
})
