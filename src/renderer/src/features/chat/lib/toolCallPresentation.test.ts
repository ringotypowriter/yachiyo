import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolCallDetailsPresentation } from './toolCallPresentation.ts'

const BASE_TOOL_CALL = {
  id: 'tool-1',
  runId: 'run-1',
  threadId: 'thread-1',
  toolName: 'read' as const,
  status: 'completed' as const,
  inputSummary: 'notes.txt',
  startedAt: '2026-03-17T00:00:00.000Z',
  finishedAt: '2026-03-17T00:00:01.000Z'
}

test('buildToolCallDetailsPresentation returns no detail content when a tool row has no structured details', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    details: undefined
  })

  assert.deepEqual(presentation.fields, [])
  assert.deepEqual(presentation.codeBlocks, [])
})

test('buildToolCallDetailsPresentation exposes read ranges and continuation hints', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    details: {
      path: '/tmp/notes.txt',
      startLine: 2,
      endLine: 3,
      totalLines: 5,
      totalBytes: 24,
      truncated: true,
      nextOffset: 3,
      remainingLines: 2
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'start line', value: '2' },
    { label: 'end line', value: '3' },
    { label: 'truncated', value: 'yes' },
    { label: 'next offset', value: '3' },
    { label: 'remaining lines', value: '2' }
  ])
  assert.deepEqual(presentation.codeBlocks, [])
})

test('buildToolCallDetailsPresentation exposes edit metadata and diff blocks', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'edit',
    details: {
      path: '/tmp/draft.txt',
      replacements: 1,
      firstChangedLine: 8,
      diff: '@@ -8 +8 @@\n-old line\n+new line\n'
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'replacements', value: '1' },
    { label: 'first changed line', value: '8' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    { label: 'diff', value: '@@ -8 +8 @@\n-old line\n+new line' }
  ])
})

test('buildToolCallDetailsPresentation exposes bash metadata, tails, and explicit errors', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    status: 'failed',
    error: 'Command timed out after 1 second.',
    details: {
      command: 'sleep 10',
      cwd: '/tmp/thread-1',
      exitCode: 124,
      stdout: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'),
      stderr: 'timed out',
      timedOut: true,
      blocked: true,
      outputFilePath: '/tmp/thread-1/bash-output.txt'
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'exit code', value: '124' },
    { label: 'timed out', value: 'yes' },
    { label: 'blocked', value: 'yes' },
    { label: 'output file', value: '/tmp/thread-1/bash-output.txt' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    {
      label: 'error',
      value: 'Command timed out after 1 second.',
      tone: 'danger'
    },
    {
      label: 'stderr',
      value: 'timed out',
      tone: 'danger'
    },
    {
      label: 'stdout tail',
      value:
        'line 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15\nline 16\nline 17\nline 18\nline 19\nline 20'
    }
  ])
})

test('buildToolCallDetailsPresentation exposes webRead metadata and markdown excerpts', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'webRead',
    inputSummary: 'https://example.com/article',
    details: {
      requestedUrl: 'https://example.com/article',
      finalUrl: 'https://example.com/final-article',
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      extractor: 'defuddle',
      title: 'Example article',
      author: 'A. Writer',
      siteName: 'Example Site',
      publishedTime: '2026-03-21T00:00:00.000Z',
      description: 'Short summary.',
      content: '# Example article\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
      contentFormat: 'markdown',
      contentChars: 70,
      truncated: true,
      originalContentChars: 150
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'final url', value: 'https://example.com/final-article' },
    { label: 'http status', value: '200' },
    { label: 'content type', value: 'text/html; charset=utf-8' },
    { label: 'extractor', value: 'defuddle' },
    { label: 'title', value: 'Example article' },
    { label: 'author', value: 'A. Writer' },
    { label: 'site name', value: 'Example Site' },
    { label: 'published', value: '2026-03-21T00:00:00.000Z' },
    { label: 'format', value: 'markdown' },
    { label: 'truncated', value: 'yes' },
    { label: 'original chars', value: '150' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    { label: 'description', value: 'Short summary.' },
    {
      label: 'content',
      value: '# Example article\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    }
  ])
})

test('buildToolCallDetailsPresentation exposes webRead saved-file metadata without content excerpts', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'webRead',
    inputSummary: 'https://example.com/article',
    details: {
      requestedUrl: 'https://example.com/article',
      finalUrl: 'https://example.com/final-article',
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      extractor: 'defuddle',
      title: 'Example article',
      content: '',
      contentFormat: 'markdown',
      contentChars: 40000,
      truncated: false,
      savedFilePath: '/tmp/thread-1/captures/example.md',
      savedBytes: 40000
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'final url', value: 'https://example.com/final-article' },
    { label: 'http status', value: '200' },
    { label: 'content type', value: 'text/html; charset=utf-8' },
    { label: 'extractor', value: 'defuddle' },
    { label: 'title', value: 'Example article' },
    { label: 'format', value: 'markdown' },
    { label: 'truncated', value: 'no' },
    { label: 'saved file', value: '/tmp/thread-1/captures/example.md' },
    { label: 'saved bytes', value: '40000' }
  ])
  assert.deepEqual(presentation.codeBlocks, [])
})

test('buildToolCallDetailsPresentation exposes webRead html excerpts', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'webRead',
    inputSummary: 'https://example.com/article',
    details: {
      requestedUrl: 'https://example.com/article',
      finalUrl: 'https://example.com/final-article',
      httpStatus: 200,
      contentType: 'text/html; charset=utf-8',
      extractor: 'defuddle',
      title: 'Example article',
      content: '<article><p>First paragraph.</p><p>Second paragraph.</p></article>',
      contentFormat: 'html',
      contentChars: 64,
      truncated: false
    }
  })

  assert.deepEqual(presentation.codeBlocks, [
    {
      label: 'content',
      value: '<article><p>First paragraph.</p><p>Second paragraph.</p></article>'
    }
  ])
})
