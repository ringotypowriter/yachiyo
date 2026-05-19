import assert from 'node:assert/strict'
import test from 'node:test'

import { flattenMemoryTermTopics, loadMemoryTermDocument } from './memoryTermDocumentModel.ts'
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

test('flattenMemoryTermTopics keeps topic metadata for compact list rows', () => {
  const rows = flattenMemoryTermTopics([
    {
      topic: 'repo-preference',
      entryCount: 2,
      entries: [
        {
          id: 'mem-1',
          title: 'Repo root',
          content: 'Use the repository root for Yachiyo commands.',
          unitType: 'preference',
          updatedAt: '2026-03-27T00:00:00.000Z'
        },
        {
          id: 'mem-2',
          title: 'Package manager',
          content: 'Use pnpm for this repository.',
          unitType: 'preference',
          importance: 0.9,
          updatedAt: '2026-03-28T00:00:00.000Z'
        }
      ]
    }
  ])

  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.topic, 'repo-preference')
  assert.equal(rows[0]?.topicEntryCount, 2)
  assert.equal(rows[1]?.entry.id, 'mem-2')
  assert.equal(rows[1]?.entry.importance, 0.9)
})

test('memory term document model passes pagination through the settings bridge', async () => {
  let receivedInput: GetMemoryTermDocumentInput | undefined
  const restore = withWindowApiMock({
    getMemoryTermDocument: async (input) => {
      receivedInput = input
      return {
        provider: 'builtin-memory',
        topicCount: 0,
        memoryCount: 0,
        topics: []
      }
    }
  })

  try {
    await loadMemoryTermDocument(undefined, { limit: 10, offset: 20 })
    assert.deepEqual(receivedInput, { limit: 10, offset: 20 })
  } finally {
    restore()
  }
})

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
