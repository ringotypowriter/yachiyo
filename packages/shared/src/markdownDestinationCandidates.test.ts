import assert from 'node:assert/strict'
import test from 'node:test'

import { toMarkdownDestinationCandidates } from './inlineCodeFileReferences.ts'

test('an encoded destination is offered decoded first and raw second', () => {
  // Markdown destinations are URIs, so the decoded reading is what a link
  // copied from anywhere else means. The raw form stays as a fallback because
  // a file may genuinely be named with those three characters.
  assert.deepEqual(toMarkdownDestinationCandidates('a%23b.md'), ['a#b.md', 'a%23b.md'])
})

test('the reserved characters decodeURI refuses are all covered', () => {
  // decodeURI leaves #, ? and / encoded; these are exactly the ones that never
  // resolved before.
  assert.equal(toMarkdownDestinationCandidates('a%23b.md')[0], 'a#b.md')
  assert.equal(toMarkdownDestinationCandidates('a%3Fb.md')[0], 'a?b.md')
  assert.equal(toMarkdownDestinationCandidates('docs%2Fnotes.md')[0], 'docs/notes.md')
  assert.equal(toMarkdownDestinationCandidates('a%20b.md')[0], 'a b.md')
})

test('a destination that needs no decoding is offered once', () => {
  // Sending the same string twice would burn a slot against the reference cap
  // for nothing.
  assert.deepEqual(toMarkdownDestinationCandidates('plain.md'), ['plain.md'])
})

test('a malformed percent escape keeps only the literal reading', () => {
  // A file really named "50%.md" is not valid percent-encoding. One bad link
  // must not throw away the whole render.
  assert.deepEqual(toMarkdownDestinationCandidates('50%.md'), ['50%.md'])
  assert.deepEqual(toMarkdownDestinationCandidates('a%ZZb.md'), ['a%ZZb.md'])
})

test('a decoded candidate still has to satisfy the reference rules', () => {
  // Decoding must not be a way around the checks the raw form goes through.
  assert.deepEqual(toMarkdownDestinationCandidates('https%3A%2F%2Fexample.com/x.md'), [
    'https%3A%2F%2Fexample.com/x.md'
  ])
  assert.deepEqual(toMarkdownDestinationCandidates('a%23b.exe'), [])
})

test('a destination that is not a file reference at all yields nothing', () => {
  assert.deepEqual(toMarkdownDestinationCandidates('https://example.com'), [])
  assert.deepEqual(toMarkdownDestinationCandidates(''), [])
})

test('a line/column suffix survives decoding', () => {
  assert.deepEqual(toMarkdownDestinationCandidates('a%20b.md:12'), ['a b.md:12', 'a%20b.md:12'])
})
