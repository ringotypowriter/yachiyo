import { test } from 'node:test'
import assert from 'node:assert/strict'

import { EMPTY_THINKING_PAGE, THINKING_PAGE_LINES, computeThinkingPage } from './thinkingPager.ts'

test('empty reasoning returns empty page', () => {
  assert.deepEqual(computeThinkingPage(''), EMPTY_THINKING_PAGE)
})

test('single line is page 0', () => {
  const page = computeThinkingPage('hello')
  assert.equal(page.index, 0)
  assert.equal(page.text, 'hello')
})

test('under 4 lines stays on page 0', () => {
  const page = computeThinkingPage('a\nb\nc')
  assert.equal(page.index, 0)
  assert.equal(page.text, 'a\nb\nc')
})

test('exactly 4 lines stays on page 0', () => {
  const page = computeThinkingPage('a\nb\nc\nd')
  assert.equal(page.index, 0)
  assert.equal(page.text, 'a\nb\nc\nd')
})

test('5th line advances to page 1', () => {
  const page = computeThinkingPage('a\nb\nc\nd\ne')
  assert.equal(page.index, 1)
  assert.equal(page.text, 'e')
})

test('page 1 fills up through 8 lines', () => {
  const page = computeThinkingPage('a\nb\nc\nd\ne\nf\ng\nh')
  assert.equal(page.index, 1)
  assert.equal(page.text, 'e\nf\ng\nh')
})

test('trailing blank line is ignored for page boundary', () => {
  const page = computeThinkingPage('a\nb\nc\nd\n')
  assert.equal(page.index, 0)
  assert.equal(page.text, 'a\nb\nc\nd')
})

test('page index advances by exact multiples of PAGE_LINES', () => {
  const lines = Array.from({ length: 13 }, (_, i) => `L${i}`).join('\n')
  const page = computeThinkingPage(lines)
  assert.equal(page.index, 3)
  assert.equal(page.text, 'L12')
  assert.ok(THINKING_PAGE_LINES === 4)
})
