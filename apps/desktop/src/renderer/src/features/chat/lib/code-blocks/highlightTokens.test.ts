import assert from 'node:assert/strict'
import test from 'node:test'

import type { HighlightOptions, HighlightResult } from '@streamdown/code'
import { requestHighlightTokens, toHighlightTokenLines } from './highlightTokens.ts'

const options: HighlightOptions = {
  code: '{"a": 1}',
  language: 'json',
  themes: ['github-light', 'github-dark']
}

function highlightResult(): HighlightResult {
  return {
    tokens: [
      [
        { content: '{', offset: 0 },
        {
          content: '"a"',
          offset: 1,
          htmlStyle: { color: '#D73A49', '--shiki-dark': '#F97583' }
        }
      ]
    ],
    fg: '',
    bg: '',
    themeName: 'github-light'
  } as HighlightResult
}

test('toHighlightTokenLines maps token content and theme colors per line', () => {
  assert.deepEqual(toHighlightTokenLines(highlightResult()), [
    [
      { content: '{', lightColor: undefined, darkColor: undefined },
      { content: '"a"', lightColor: '#D73A49', darkColor: '#F97583' }
    ]
  ])
})

test('requestHighlightTokens delivers tokens synchronously on a cached highlight result', () => {
  const delivered: unknown[] = []

  requestHighlightTokens(
    {
      // Cache hit: the plugin returns the result directly and never invokes the callback.
      highlight: () => highlightResult()
    },
    options,
    (lines) => delivered.push(lines)
  )

  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], toHighlightTokenLines(highlightResult()))
})

test('requestHighlightTokens delivers tokens through the async callback on a cache miss', () => {
  let capturedCallback: ((result: HighlightResult) => void) | undefined
  const delivered: unknown[] = []

  requestHighlightTokens(
    {
      highlight: (_options, callback) => {
        capturedCallback = callback
        return null
      }
    },
    options,
    (lines) => delivered.push(lines)
  )

  assert.equal(delivered.length, 0)
  capturedCallback?.(highlightResult())
  assert.equal(delivered.length, 1)
  assert.deepEqual(delivered[0], toHighlightTokenLines(highlightResult()))
})
