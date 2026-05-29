import type { YachiyoPreloadYachiyoApi } from '../../../preload/index.ts'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasPendingSoulDocumentChanges,
  loadSoulDocument,
  persistSoulDocument,
  toSoulTraitTexts
} from './soulDocumentEditorModel.ts'

type YachiyoApiMock = Partial<YachiyoPreloadYachiyoApi>

function withWindowApiMock(mock: YachiyoApiMock): () => void {
  const globalScope = globalThis as typeof globalThis & {
    window?: {
      api: {
        yachiyo: YachiyoApiMock
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
        evolvedTraits: [{ key: 'sharp1', trait: 'Sharp' }],
        lastUpdated: '2026-04-10T10:00:00.000Z'
      }
    }
  })

  try {
    assert.deepEqual(await loadSoulDocument(), {
      filePath: '/tmp/.yachiyo/SOUL.md',
      evolvedTraits: [{ key: 'sharp1', trait: 'Sharp' }],
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
        evolvedTraits: [{ key: 'curious1', trait: 'Curious' }],
        lastUpdated: '2026-04-10T10:01:00.000Z'
      }
    },
    addSoulTrait: async ({ trait }) => {
      calls.push(`add:${trait}`)
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: [
          { key: 'curious1', trait: 'Curious' },
          { key: `${trait.toLowerCase()}1`, trait }
        ],
        lastUpdated: '2026-04-10T10:02:00.000Z'
      }
    },
    getSoulDocument: async () => {
      calls.push('reload')
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: [
          { key: 'curious1', trait: 'Curious' },
          { key: 'precise1', trait: 'Precise' }
        ],
        lastUpdated: '2026-04-10T10:03:00.000Z'
      }
    }
  })

  try {
    assert.deepEqual(await persistSoulDocument(['Calm', 'Curious'], ['Curious', 'Precise']), {
      filePath: '/tmp/.yachiyo/SOUL.md',
      evolvedTraits: [
        { key: 'curious1', trait: 'Curious' },
        { key: 'precise1', trait: 'Precise' }
      ],
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
        evolvedTraits: [{ key: `${trait.toLowerCase()}1`, trait }],
        lastUpdated: '2026-04-10T10:02:00.000Z'
      }
    },
    getSoulDocument: async () => {
      calls.push('reload')
      return {
        filePath: '/tmp/.yachiyo/SOUL.md',
        evolvedTraits: [
          { key: 'curious1', trait: 'Curious' },
          { key: 'calm1', trait: 'Calm' }
        ],
        lastUpdated: '2026-04-10T10:03:00.000Z'
      }
    }
  })

  try {
    assert.deepEqual(await persistSoulDocument(['Calm', 'Curious'], ['Curious', 'Calm']), {
      filePath: '/tmp/.yachiyo/SOUL.md',
      evolvedTraits: [
        { key: 'curious1', trait: 'Curious' },
        { key: 'calm1', trait: 'Calm' }
      ],
      lastUpdated: '2026-04-10T10:03:00.000Z'
    })
    assert.deepEqual(calls, ['delete:Calm', 'add:Calm', 'reload'])
  } finally {
    restore()
  }
})

test('toSoulTraitTexts returns editable trait text from structured records', () => {
  assert.deepEqual(
    toSoulTraitTexts([
      { key: 'sharp1', trait: 'Sharp' },
      { key: 'calm1', trait: 'Calm' }
    ]),
    ['Sharp', 'Calm']
  )
})

test('hasPendingSoulDocumentChanges tracks unsaved trait edits', () => {
  assert.equal(hasPendingSoulDocumentChanges(['Sharp'], ['Sharp']), false)
  assert.equal(hasPendingSoulDocumentChanges(['Sharp'], ['Sharp', 'Precise']), true)
  assert.equal(hasPendingSoulDocumentChanges(['Sharp', 'Calm'], ['Calm', 'Sharp']), true)
})
