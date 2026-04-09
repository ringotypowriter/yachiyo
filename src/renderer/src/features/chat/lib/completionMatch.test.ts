import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreMatch, scoreCandidates } from './completionMatch'

describe('scoreMatch', () => {
  it('exact beats prefix beats substring beats fuzzy', () => {
    const exact = scoreMatch('handoff', 'handoff')!
    const prefix = scoreMatch('handoff', 'hand')!
    const sub = scoreMatch('superhandoff', 'hand')!
    const fuzzy = scoreMatch('handoff', 'hdf')!
    assert.ok(exact > prefix)
    assert.ok(prefix > sub)
    assert.ok(sub > fuzzy)
  })
  it('is case-insensitive', () => {
    assert.ok(scoreMatch('Composer.tsx', 'comp') !== null)
  })
  it('returns null when no match', () => {
    assert.equal(scoreMatch('archive', 'xyz'), null)
  })
  it('word-boundary substring beats mid-word', () => {
    const boundary = scoreMatch('chat/Composer.tsx', 'Composer')!
    const mid = scoreMatch('recomposer.tsx', 'composer')!
    assert.ok(boundary > mid)
  })
})

describe('scoreCandidates', () => {
  it('filters and ranks prefix matches above non-matches', () => {
    const items = ['archive', 'handoff', 'handle']
    const out = scoreCandidates(items, 'hand', (x) => [x])
    assert.deepEqual(out.map((o) => o.item).sort(), ['handle', 'handoff'])
    assert.equal(out.length, 2)
  })
  it('is stable when scores tie exactly', () => {
    const items = ['foo', 'foo', 'bar']
    const out = scoreCandidates(items, 'f', (x) => [x])
    assert.equal(out.length, 2)
    assert.equal(out[0].index, 0)
    assert.equal(out[1].index, 1)
  })
  it('empty query keeps everything in original order', () => {
    const items = ['a', 'b', 'c']
    const out = scoreCandidates(items, '', (x) => [x])
    assert.deepEqual(
      out.map((o) => o.item),
      items
    )
  })
})
