import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasPendingSoulDocumentChanges,
  loadSoulDocument,
  persistSoulDocument
} from './soulDocumentEditorModel.ts'

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

test('soul document editor model loads SOUL.md through the settings bridge', async () => {
  let calls = 0
  const restore = withWindowApiMock({
    getSoulDocument: async () => {
      calls += 1
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: ['Sharp'],
        lastUpdated: '2026-04-10T10:00:00.000Z'
      }
    }
  })

  try {
    assert.deepEqual(await loadSoulDocument(), {
      filePath: '/tmp/.yachiyo/SOUL.md',
      evolvedTraits: ['Sharp'],
      lastUpdated: '2026-04-10T10:00:00.000Z'
    })
    assert.equal(calls, 1)
  } finally {
    restore()
  }
})

test('persistSoulDocument applies removals and additions before reloading SOUL.md', async () => {
  const calls: string[] = []
  const restore = withWindowApiMock({
    deleteSoulTrait: async ({ trait }) => {
      calls.push(`delete:${trait}`)
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: ['Curious'],
        lastUpdated: '2026-04-10T10:01:00.000Z'
      }
    },
    addSoulTrait: async ({ trait }) => {
      calls.push(`add:${trait}`)
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: ['Curious', trait],
        lastUpdated: '2026-04-10T10:02:00.000Z'
      }
    },
    getSoulDocument: async () => {
      calls.push('reload')
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: ['Curious', 'Precise'],
        lastUpdated: '2026-04-10T10:03:00.000Z'
      }
    }
  })

  try {
    assert.deepEqual(await persistSoulDocument(['Calm', 'Curious'], ['Curious', 'Precise']), {
      filePath: '/tmp/.yachiyo/SOUL.md',
      evolvedTraits: ['Curious', 'Precise'],
      lastUpdated: '2026-04-10T10:03:00.000Z'
    })
    assert.deepEqual(calls, ['delete:Calm', 'add:Precise', 'reload'])
  } finally {
    restore()
  }
})

test('persistSoulDocument rewrites only the moved traits when the order changed', async () => {
  const calls: string[] = []
  const restore = withWindowApiMock({
    deleteSoulTrait: async ({ trait }) => {
      calls.push(`delete:${trait}`)
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: [],
        lastUpdated: '2026-04-10T10:01:00.000Z'
      }
    },
    addSoulTrait: async ({ trait }) => {
      calls.push(`add:${trait}`)
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: [trait],
        lastUpdated: '2026-04-10T10:02:00.000Z'
      }
    },
    getSoulDocument: async () => {
      calls.push('reload')
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: ['Curious', 'Calm'],
        lastUpdated: '2026-04-10T10:03:00.000Z'
      }
    }
  })

  try {
    assert.deepEqual(await persistSoulDocument(['Calm', 'Curious'], ['Curious', 'Calm']), {
      filePath: '/tmp/.yachiyo/SOUL.md',
      evolvedTraits: ['Curious', 'Calm'],
      lastUpdated: '2026-04-10T10:03:00.000Z'
    })
    assert.deepEqual(calls, ['delete:Calm', 'add:Calm', 'reload'])
  } finally {
    restore()
  }
})

test('hasPendingSoulDocumentChanges tracks unsaved trait edits', () => {
  assert.equal(hasPendingSoulDocumentChanges(['Sharp'], ['Sharp']), false)
  assert.equal(hasPendingSoulDocumentChanges(['Sharp'], ['Sharp', 'Precise']), true)
  assert.equal(hasPendingSoulDocumentChanges(['Sharp', 'Calm'], ['Calm', 'Sharp']), true)
})
