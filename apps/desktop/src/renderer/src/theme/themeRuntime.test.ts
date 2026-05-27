import assert from 'node:assert/strict'
import test from 'node:test'
import { parseHTML } from 'linkedom'

import { applyThemeAttributes } from './themeRuntime.ts'

function withDocument(callback: (document: Document) => void): void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const { document } = parseHTML('<html><body></body></html>')

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document
  })

  try {
    callback(document)
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(globalThis, 'document', previousDescriptor)
    } else {
      delete (globalThis as { document?: Document }).document
    }
  }
}

test('applyThemeAttributes toggles the root dark class with the theme variant', () => {
  withDocument((document) => {
    applyThemeAttributes({ themeId: 'mizu', appearance: 'dark', variant: 'dark' })

    assert.equal(document.documentElement.dataset['yachiyoThemeVariant'], 'dark')
    assert.equal(document.documentElement.classList.contains('dark'), true)

    applyThemeAttributes({ themeId: 'mizu', appearance: 'light', variant: 'light' })

    assert.equal(document.documentElement.dataset['yachiyoThemeVariant'], 'light')
    assert.equal(document.documentElement.classList.contains('dark'), false)
  })
})
