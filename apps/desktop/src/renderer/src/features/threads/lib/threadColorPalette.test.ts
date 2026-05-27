import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveThreadTitleColor } from './threadColorPalette.ts'

test('resolveThreadTitleColor ignores thread color for folder children', () => {
  assert.equal(
    resolveThreadTitleColor({
      colorTag: 'azure',
      fallback: 'plain-title-color',
      isInFolder: true
    }),
    'plain-title-color'
  )
})

test('resolveThreadTitleColor uses thread color for loose threads', () => {
  assert.equal(
    resolveThreadTitleColor({
      colorTag: 'azure',
      fallback: 'plain-title-color',
      isInFolder: false
    }),
    '#4A90D9'
  )
})
