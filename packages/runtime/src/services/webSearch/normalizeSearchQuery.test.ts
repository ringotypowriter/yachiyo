import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeSearchQuery } from './normalizeSearchQuery.ts'

const currentYear = new Date().getFullYear()

test('replaces {currentYear} placeholder', () => {
  const result = normalizeSearchQuery('best phones {currentYear}')
  assert.equal(result, `best phones ${currentYear}`)
})

test('bumps the most recent stale year for current-info queries', () => {
  assert.equal(
    normalizeSearchQuery(`latest AI news ${currentYear - 1}`),
    `latest AI news ${currentYear}`
  )

  assert.equal(
    normalizeSearchQuery(`latest AI news ${currentYear - 2}`),
    `latest AI news ${currentYear}`
  )
})

test('does not touch historical queries without current-info hints', () => {
  assert.equal(normalizeSearchQuery(`World Cup ${currentYear - 1}`), `World Cup ${currentYear - 1}`)

  assert.equal(normalizeSearchQuery(`World Cup ${currentYear - 2}`), `World Cup ${currentYear - 2}`)
})

test('does not replace when current year is already present', () => {
  assert.equal(
    normalizeSearchQuery(`compare ${currentYear - 1} and ${currentYear}`),
    `compare ${currentYear - 1} and ${currentYear}`
  )
})

test('ignores years outside the past-decade window', () => {
  assert.equal(normalizeSearchQuery('latest news 1999'), 'latest news 1999')
})

test('does not rewrite year for framework names containing hint substrings', () => {
  assert.equal(
    normalizeSearchQuery(`Next.js ${currentYear - 1} app router docs`),
    `Next.js ${currentYear - 1} app router docs`
  )

  assert.equal(
    normalizeSearchQuery(`next/router ${currentYear - 1} migration`),
    `next/router ${currentYear - 1} migration`
  )
})
