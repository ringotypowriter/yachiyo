import assert from 'node:assert/strict'
import test from 'node:test'
import { previewDiscardCandidates } from './previewRetention.ts'

const hot = (
  key: string,
  lastUsedAt: number
): { key: string; hot: boolean; lastUsedAt: number } => ({ key, hot: true, lastUsedAt })
test('one global LRU budget protects current preview across conversations', () => {
  const tabs = [hot('a/1', 1), hot('b/1', 2), hot('c/1', 3), hot('d/1', 4), hot('e/current', 0)]
  assert.deepEqual(
    previewDiscardCandidates(tabs, 'e/current', 100).map((tab) => tab.key),
    ['a/1']
  )
})
test('idle background previews expire at five minutes, never the visible one', () => {
  assert.deepEqual(
    previewDiscardCandidates([hot('a/1', 0), hot('b/current', 0)], 'b/current', 300000).map(
      (tab) => tab.key
    ),
    ['a/1']
  )
  assert.deepEqual(previewDiscardCandidates([hot('a/1', 1)], null, 300000), [])
})
test('cold descriptors do not consume the hot budget', () => {
  assert.deepEqual(
    previewDiscardCandidates(
      [hot('a', 1), hot('b', 2), hot('c', 3), { ...hot('cold', 0), hot: false }],
      null,
      100
    ),
    []
  )
})
test('protected exceptions can exceed budget while oldest eligible resources are reclaimed', () => {
  const tabs = [
    hot('protected-a', 0),
    hot('protected-b', 1),
    hot('protected-c', 2),
    hot('protected-d', 3),
    hot('eligible', 4)
  ]
  assert.deepEqual(
    previewDiscardCandidates(
      tabs,
      null,
      100,
      new Set(['protected-a', 'protected-b', 'protected-c', 'protected-d'])
    ).map((tab) => tab.key),
    ['eligible']
  )
})
