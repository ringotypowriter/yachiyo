import assert from 'node:assert/strict'
import test from 'node:test'

import { splitStreamingMarkdownSegments } from './streamingMarkdownSegments.ts'

test('splits completed paragraph blocks away from the active streaming tail', () => {
  assert.deepEqual(
    splitStreamingMarkdownSegments('First paragraph.\n\nSecond paragraph is still streaming'),
    {
      stableSegments: ['First paragraph.\n\n'],
      activeSegment: 'Second paragraph is still streaming'
    }
  )
})

test('keeps an unfinished fenced code block in the active streaming tail', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('Intro.\n\n```ts\nconst value = 1\n'), {
    stableSegments: ['Intro.\n\n'],
    activeSegment: '```ts\nconst value = 1\n'
  })
})

test('keeps indented fenced code blocks attached to list items', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('- Run:\n  ```sh\n  pnpm test\n'), {
    stableSegments: [],
    activeSegment: '- Run:\n  ```sh\n  pnpm test\n'
  })
})

test('does not close a fenced code block on a fence line with trailing text', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('Intro.\n\n```ts\n```text\n\nstill code\n'), {
    stableSegments: ['Intro.\n\n'],
    activeSegment: '```ts\n```text\n\nstill code\n'
  })
})

test('promotes a completed fenced code block after the next block starts', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('```ts\nconst value = 1\n```\n\nNext'), {
    stableSegments: ['```ts\nconst value = 1\n```\n\n'],
    activeSegment: 'Next'
  })
})

test('keeps display math blocks with blank lines intact', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('$$\na=1\n\nb=2\n$$\n\nNext'), {
    stableSegments: ['$$\na=1\n\nb=2\n$$\n\n'],
    activeSegment: 'Next'
  })
})

test('keeps unfinished display math blocks in the active streaming tail', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('Intro.\n\n$$\na=1\n\nb=2\n'), {
    stableSegments: ['Intro.\n\n'],
    activeSegment: '$$\na=1\n\nb=2\n'
  })
})

test('bounds long top-level list tails at item boundaries', () => {
  assert.deepEqual(
    splitStreamingMarkdownSegments('- one\n- two\n- three\n- four', {
      maxActiveSegmentChars: 12
    }),
    {
      stableSegments: ['- one\n- two\n'],
      activeSegment: '- three\n- four'
    }
  )
})

test('does not split ordered lists that commonly restart numbering from one', () => {
  assert.deepEqual(
    splitStreamingMarkdownSegments('1. one\n1. two\n1. three\n1. four', {
      maxActiveSegmentChars: 12
    }),
    {
      stableSegments: [],
      activeSegment: '1. one\n1. two\n1. three\n1. four'
    }
  )
})

test('does not split documents with footnote references and definitions', () => {
  assert.deepEqual(splitStreamingMarkdownSegments('Text[^1]\n\n[^1]: note'), {
    stableSegments: [],
    activeSegment: 'Text[^1]\n\n[^1]: note'
  })
})
