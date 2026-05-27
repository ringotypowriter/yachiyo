import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { longestCommonPrefix } from './longestCommonPrefix'

describe('longestCommonPrefix', () => {
  it('returns empty for empty input', () => {
    assert.equal(longestCommonPrefix([]), '')
  })
  it('returns the only string for singleton input', () => {
    assert.equal(longestCommonPrefix(['handoff']), 'handoff')
  })
  it('finds shared prefix', () => {
    assert.equal(longestCommonPrefix(['handoff', 'handle', 'hand']), 'hand')
  })
  it('returns empty when nothing shared', () => {
    assert.equal(longestCommonPrefix(['archive', 'handoff']), '')
  })
  it('is case-sensitive by default', () => {
    assert.equal(longestCommonPrefix(['Foo', 'foo']), '')
  })
  it('supports case-insensitive mode but preserves first casing', () => {
    assert.equal(longestCommonPrefix(['Foobar', 'fooBaz'], true), 'Fooba')
  })
})
