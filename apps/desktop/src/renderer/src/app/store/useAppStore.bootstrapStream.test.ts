import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_SETTINGS, useAppStore } from './useAppStore.ts'

test('bootstrap retains only the streamed deltas newer than its snapshot', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const timestamp = '2026-10-27T00:00:00.000Z'
  let receive: (event: YachiyoServerEvent) => void = () => assert.fail('not subscribed')
  const event = (sequence: number, delta: string): YachiyoServerEvent =>
    ({
      type: 'message.delta',
      eventId: String(sequence),
      timestamp,
      threadId: 'thread',
      runId: 'run',
      messageId: 'reply',
      delta,
      streamCursor: { instanceId: 'server', sequence }
    }) as YachiyoServerEvent
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      requestAnimationFrame: () => 1,
      setTimeout: () => 1,
      clearTimeout: () => {},
      api: {
        yachiyo: {
          subscribe: (listener: typeof receive) => {
            receive = listener
            return () => {}
          },
          bootstrap: async () => {
            receive(event(1, 'prefix'))
            return {
              streamCursor: { instanceId: 'server', sequence: 1 },
              threads: [{ id: 'thread', title: 'Running', updatedAt: timestamp }],
              archivedThreads: [],
              folders: [],
              messagesByThread: {
                thread: [
                  {
                    id: 'reply',
                    threadId: 'thread',
                    role: 'assistant',
                    content: 'prefix',
                    status: 'streaming',
                    createdAt: timestamp
                  }
                ]
              },
              queuedFollowUpMessagesByThread: {},
              toolCallsByThread: {},
              sentinelsByThread: {},
              latestRunsByThread: {
                thread: { id: 'run', threadId: 'thread', status: 'running', createdAt: timestamp }
              },
              recoveredInterruptedSaveThreadIds: [],
              config: { providers: [] },
              settings: DEFAULT_SETTINGS
            }
          },
          listThings: async () => {
            receive(event(2, ' tail'))
            return []
          },
          listSkills: async () => []
        }
      }
    }
  })
  try {
    await useAppStore.getState().initialize()
    const state = useAppStore.getState()
    const message = state.messages.thread.find((entry) => entry.id === 'reply')
    assert.equal(message?.content, 'prefix tail')
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
