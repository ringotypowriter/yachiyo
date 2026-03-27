import assert from 'node:assert/strict'
import test from 'node:test'

import { loadMemoryTermDocument } from './memoryTermDocumentModel.ts'
import type { GetMemoryTermDocumentInput } from '../../../shared/yachiyo/protocol.ts'

function withWindowApiMock(mock: Partial<Window['api']['yachiyo']>): () => void {
  const globalScope = globalThis as typeof globalThis & {
    window?: {
      api: {
        yachiyo: Partial<Window['api']['yachiyo']>
      }
    }
  }
  const originalWindow = globalScope.window

  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: mock
      }
    },
    configurable: true,
    writable: true
  })

  return () => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalScope, 'window')
      return
    }

    Object.defineProperty(globalScope, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
  }
}

test('memory term document model loads builtin memory hierarchy through the settings bridge', async () => {
  let calls = 0
  let receivedInput: GetMemoryTermDocumentInput | undefined
  const restore = withWindowApiMock({
    getMemoryTermDocument: async (input) => {
      calls += 1
      receivedInput = input
      return {
        provider: 'builtin-memory',
        topicCount: 1,
        memoryCount: 1,
        topics: [
          {
            topic: 'repo-preference',
            entryCount: 1,
            entries: [
              {
                id: 'mem-1',
                title: 'Repo root',
                content: 'Use the repository root for Yachiyo commands.',
                unitType: 'preference',
                updatedAt: '2026-03-27T00:00:00.000Z'
              }
            ]
          }
        ]
      }
    }
  })

  try {
    const document = await loadMemoryTermDocument({
      providers: [],
      memory: {
        enabled: true,
        provider: 'builtin-memory'
      }
    })
    assert.equal(calls, 1)
    assert.deepEqual(receivedInput, {
      config: {
        providers: [],
        memory: {
          enabled: true,
          provider: 'builtin-memory'
        }
      }
    })
    assert.equal(document.provider, 'builtin-memory')
    assert.equal(document.topics[0]?.topic, 'repo-preference')
    assert.equal(document.topics[0]?.entries[0]?.title, 'Repo root')
  } finally {
    restore()
  }
})
