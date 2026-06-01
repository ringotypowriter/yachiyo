import assert from 'node:assert/strict'
import test from 'node:test'

import { readCodeHighlightTokenTheme } from './codeHighlightTheme.ts'

test('readCodeHighlightTokenTheme keeps Shiki light and dark token colors', () => {
  assert.deepEqual(
    readCodeHighlightTokenTheme({
      color: '#D73A49',
      '--shiki-dark': '#F97583'
    }),
    {
      lightColor: '#D73A49',
      darkColor: '#F97583'
    }
  )
})

test('readCodeHighlightTokenTheme falls back to the light color when no dark token exists', () => {
  assert.deepEqual(readCodeHighlightTokenTheme({ color: '#24292E' }), {
    lightColor: '#24292E',
    darkColor: '#24292E'
  })
})
