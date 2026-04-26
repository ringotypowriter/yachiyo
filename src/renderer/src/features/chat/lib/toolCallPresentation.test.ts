import assert from 'node:assert/strict'
import test from 'node:test'

import { buildToolCallDetailsPresentation, compressPath } from './toolCallPresentation.ts'

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
      mode: 'range',
      replacements: 1,
      firstChangedLine: 8,
      diff: '@@ -8 +8 @@\n-old line\n+new line\n'
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'mode', value: 'range' },
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
    { label: 'exit code', value: '124', tone: 'danger' },
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
    { label: 'command', value: 'sleep 10' },
    // stderr with danger tone stays secondary (shown inline in chat)
    {
      label: 'stderr',
      value: 'timed out',
      tone: 'danger'
    },
    { label: 'stdout', value: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') }
  ])
})

test('buildToolCallDetailsPresentation exposes grep metadata and normalized matches', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'grep',
    inputSummary: 'needle',
    details: {
      backend: 'rg',
      pattern: 'needle',
      path: '/tmp/thread-1',
      resultCount: 2,
      truncated: true,
      matches: [
        { path: 'src/alpha.ts', line: 3, text: 'const needle = 1' },
        { path: 'src/beta.ts', line: 8, text: 'needle()' }
      ]
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'backend', value: 'rg' },
    { label: 'path', value: '/tmp/thread-1' },
    { label: 'results', value: '2' },
    { label: 'truncated', value: 'yes' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    {
      label: 'matches',
      value: 'src/alpha.ts:3: const needle = 1\nsrc/beta.ts:8: needle()',
      displayTier: 'inspection'
    }
  ])
})

test('buildToolCallDetailsPresentation exposes glob metadata and normalized file matches', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'glob',
    inputSummary: 'src/**/*.ts',
    details: {
      backend: 'fd',
      pattern: 'src/**/*.ts',
      path: '/tmp/thread-1',
      resultCount: 2,
      truncated: false,
      matches: ['src/alpha.ts', 'src/beta.ts']
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'backend', value: 'fd' },
    { label: 'path', value: '/tmp/thread-1' },
    { label: 'results', value: '2' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    {
      label: 'matches',
      value: 'src/alpha.ts\nsrc/beta.ts',
      displayTier: 'inspection'
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
    // Full web content is inspection-only; chat shows only description + metadata
    {
      label: 'content',
      value: '# Example article\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.',
      displayTier: 'inspection'
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
      value: '<article><p>First paragraph.</p><p>Second paragraph.</p></article>',
      displayTier: 'inspection'
    }
  ])
})

test('buildToolCallDetailsPresentation marks bash stdout as inspection-tier regardless of success', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    status: 'completed',
    details: {
      command: 'echo hello',
      cwd: '/tmp',
      exitCode: 0,
      stdout: 'hello',
      stderr: ''
    }
  })

  const stdoutBlock = presentation.codeBlocks.find((b) => b.label === 'stdout')
  assert.ok(stdoutBlock, 'stdout block should be present')
  // stdout is shown inline (no displayTier) so the user can see command output directly
  assert.equal(stdoutBlock.displayTier, undefined)
})

test('buildToolCallDetailsPresentation keeps bash stderr secondary when it carries danger signal', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    status: 'failed',
    details: {
      command: 'bad-cmd',
      cwd: '/tmp',
      exitCode: 1,
      stdout: '',
      stderr: 'command not found'
    }
  })

  const stderrBlock = presentation.codeBlocks.find((b) => b.label === 'stderr')
  assert.ok(stderrBlock, 'stderr block should be present')
  assert.equal(stderrBlock.tone, 'danger')
  assert.equal(stderrBlock.displayTier, undefined)
})

test('buildToolCallDetailsPresentation marks grep and glob match lists as inspection-tier', () => {
  const grepPresentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'grep',
    details: {
      backend: 'rg',
      pattern: 'foo',
      path: '/src',
      resultCount: 1,
      truncated: false,
      matches: [{ path: 'a.ts', line: 1, text: 'foo' }]
    }
  })

  const globPresentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'glob',
    details: {
      backend: 'fd',
      pattern: '**/*.ts',
      path: '/src',
      resultCount: 1,
      truncated: false,
      matches: ['a.ts']
    }
  })

  assert.equal(grepPresentation.codeBlocks[0].displayTier, 'inspection')
  assert.equal(globPresentation.codeBlocks[0].displayTier, 'inspection')
})

test('compressPath returns short paths unchanged', () => {
  assert.equal(compressPath('/a/b/c.txt'), '/a/b/c.txt')
  assert.equal(compressPath('src/file.ts'), 'src/file.ts')
})

test('compressPath returns shallow paths unchanged', () => {
  assert.equal(compressPath('/root/deep/file.txt'), '/root/deep/file.txt')
})

test('compressPath abbreviates long middle segments', () => {
  assert.equal(
    compressPath('/a/verylong-folder/deeply-nested/pathway/toward/file.txt'),
    '/a/verylong-folder/d/p/t/file.txt'
  )
})

test('compressPath keeps short middle segments intact', () => {
  assert.equal(
    compressPath('/a/b/srcfolder/core/lib/utils/helpers/helper.ts'),
    '/a/b/s/core/lib/utils/h/helper.ts'
  )
})

test('compressPath handles relative deep paths', () => {
  assert.equal(
    compressPath('src/renderer/src/features/chat/components/ToolCallRow.tsx'),
    'src/renderer/src/f/chat/c/ToolCallRow.tsx'
  )
})

test('compressPath preserves leading slash on absolute paths', () => {
  const result = compressPath('/home/user/projects/myapp/src/lib/util/file.ts')
  assert.ok(result.startsWith('/'), 'absolute path should start with /')
  assert.ok(result.endsWith('/file.ts'), 'tail filename should be intact')
})

test('compressPath result is never longer than original', () => {
  const cases = [
    '/a/b/c/d/e/f/g/h/i/j/k/file.txt',
    'very/long/relative/path/chain/that/goes/deep/file.ts',
    '/short/path.txt'
  ]
  for (const p of cases) {
    const result = compressPath(p)
    assert.ok(
      result.length <= p.length,
      `compressed "${p}" (${p.length}) → "${result}" (${result.length}) should not be longer`
    )
  }
})
