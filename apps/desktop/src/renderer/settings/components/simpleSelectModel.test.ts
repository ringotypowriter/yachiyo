import assert from 'node:assert/strict'
import test from 'node:test'

import { filterSimpleSelectOptions, moveSimpleSelectActiveIndex } from './simpleSelectModel.ts'

const options = [
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
  { value: 'Asia/Shanghai', label: 'China Standard Time' },
  { value: 'UTC', label: 'UTC' }
]

test('filterSimpleSelectOptions matches labels and values case-insensitively', () => {
  assert.deepEqual(filterSimpleSelectOptions(options, 'shanghai'), [options[1]])
  assert.deepEqual(filterSimpleSelectOptions(options, 'china'), [options[1]])
  assert.deepEqual(filterSimpleSelectOptions(options, 'america/los'), [options[0]])
})

test('filterSimpleSelectOptions preserves all options for an empty query', () => {
  assert.equal(filterSimpleSelectOptions(options, '  '), options)
})

test('moveSimpleSelectActiveIndex wraps keyboard navigation through visible options', () => {
  assert.equal(moveSimpleSelectActiveIndex(-1, 1, 3), 0)
  assert.equal(moveSimpleSelectActiveIndex(0, 1, 3), 1)
  assert.equal(moveSimpleSelectActiveIndex(2, 1, 3), 0)
  assert.equal(moveSimpleSelectActiveIndex(0, -1, 3), 2)
  assert.equal(moveSimpleSelectActiveIndex(-1, -1, 3), 2)
  assert.equal(moveSimpleSelectActiveIndex(0, 1, 0), -1)
})
