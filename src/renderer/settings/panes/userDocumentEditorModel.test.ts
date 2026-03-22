import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hasPendingUserDocumentChanges,
  loadUserDocument,
  persistUserDocument
} from './userDocumentEditorModel.ts'

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

test('user document editor model loads USER.md through the settings bridge', async () => {
  let calls = 0
  const restore = withWindowApiMock({
    getUserDocument: async () => {
      calls += 1
      return {
        filePath: '/tmp/.yachiyo/USER.md',
        content: '# USER\n'
      }
    }
  })

  try {
    assert.deepEqual(await loadUserDocument(), {
      filePath: '/tmp/.yachiyo/USER.md',
      content: '# USER\n'
    })
    assert.equal(calls, 1)
  } finally {
    restore()
  }
})

test('user document editor model saves USER.md through the settings bridge', async () => {
  const savedPayloads: string[] = []
  const restore = withWindowApiMock({
    saveUserDocument: async ({ content }) => {
      savedPayloads.push(content)
      return {
        filePath: '/tmp/.yachiyo/USER.md',
        content: `${content}\n`
      }
    }
  })

  try {
    assert.deepEqual(await persistUserDocument('# USER'), {
      filePath: '/tmp/.yachiyo/USER.md',
      content: '# USER\n'
    })
    assert.deepEqual(savedPayloads, ['# USER'])
  } finally {
    restore()
  }
})

test('hasPendingUserDocumentChanges tracks unsaved editor state', () => {
  assert.equal(hasPendingUserDocumentChanges('# USER\n', '# USER\n'), false)
  assert.equal(hasPendingUserDocumentChanges('# USER\n', '# USER\n## Notes\n'), true)
})
