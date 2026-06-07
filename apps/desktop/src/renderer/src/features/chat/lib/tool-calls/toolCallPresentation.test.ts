import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolCallDetailsPresentation,
  compressPath,
  formatToolFilePath,
  formatToolFilePathList,
  stripWorkspacePath
} from './toolCallPresentation.ts'

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
    { label: 'diff', value: '@@ -8 +8 @@\n-old line\n+new line', filePath: '/tmp/draft.txt' }
  ])
})

test('buildToolCallDetailsPresentation keeps applyPatch inline details concise', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'applyPatch',
    details: {
      operations: [
        {
          operation: 'add',
          path: 'src/new.ts',
          diff: '--- /dev/null\n+++ src/new.ts\n@@ -0,0 +1 @@\n+export const value = 1'
        },
        {
          operation: 'update',
          path: 'src/existing.ts',
          diff: '@@ -1 +1 @@\n-old\n+new'
        },
        {
          operation: 'move',
          path: 'src/old.ts',
          movePath: 'src/new-name.ts',
          diff: ''
        }
      ]
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'files', value: '3' },
    { label: 'changes', value: '1 added · 1 updated · 1 moved' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    { label: 'files', value: '+ src/new.ts\n~ src/existing.ts\n→ src/old.ts → src/new-name.ts' },
    {
      label: 'diff · src/new.ts',
      value: '--- /dev/null\n+++ src/new.ts\n@@ -0,0 +1 @@\n+export const value = 1',
      filePath: 'src/new.ts'
    },
    {
      label: 'diff · src/existing.ts',
      value: '@@ -1 +1 @@\n-old\n+new',
      filePath: 'src/existing.ts'
    }
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

test('buildToolCallDetailsPresentation keeps foreground output visible after bash moves to background', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    status: 'background',
    details: {
      command: 'echo before-timeout && sleep 60',
      cwd: '/tmp/thread-1',
      stdout: 'before-timeout\nstill useful',
      stderr: '',
      background: true,
      taskId: 'tool-bash-1',
      logPath: '/tmp/thread-1/.yachiyo/tool-output/tool-bash-1.log',
      liftedAfterTimeout: true
    }
  })

  assert.deepEqual(presentation.fields, [
    { label: 'task id', value: 'tool-bash-1' },
    { label: 'log file', value: '/tmp/thread-1/.yachiyo/tool-output/tool-bash-1.log' }
  ])
  assert.deepEqual(presentation.codeBlocks, [
    { label: 'command', value: 'echo before-timeout && sleep 60' },
    { label: 'stdout', value: 'before-timeout\nstill useful' }
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
      value: 'src/alpha.ts:3: const needle = 1\nsrc/beta.ts:8: needle()'
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
      value: 'src/alpha.ts\nsrc/beta.ts'
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

test('buildToolCallDetailsPresentation shows bash stdout without presentation tiers', () => {
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
  assert.deepEqual(stdoutBlock, { label: 'stdout', value: 'hello' })
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
  assert.deepEqual(stderrBlock, { label: 'stderr', value: 'command not found', tone: 'danger' })
})

test('buildToolCallDetailsPresentation shows grep and glob match lists without presentation tiers', () => {
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

  assert.deepEqual(grepPresentation.codeBlocks, [{ label: 'matches', value: 'a.ts:1: foo' }])
  assert.deepEqual(globPresentation.codeBlocks, [{ label: 'matches', value: 'a.ts' }])
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

test('stripWorkspacePath returns relative paths inside the active workspace', () => {
  assert.equal(
    stripWorkspacePath('/workspace/project/src/file.ts', '/workspace/project'),
    'src/file.ts'
  )
})

test('stripWorkspacePath does not strip sibling absolute paths', () => {
  assert.equal(
    stripWorkspacePath('/workspace/project-other/src/file.ts', '/workspace/project'),
    '/workspace/project-other/src/file.ts'
  )
})

test('formatToolFilePath strips workspace before compressing', () => {
  assert.equal(
    formatToolFilePath(
      '/workspace/project/src/renderer/src/features/chat/components/ToolCallRow.tsx',
      '/workspace/project'
    ),
    'src/renderer/src/f/chat/c/ToolCallRow.tsx'
  )
})

test('formatToolFilePathList keeps the shared directory only on the first path', () => {
  assert.deepEqual(
    formatToolFilePathList(
      ['/workspace/project/src/a.ts', '/workspace/project/src/b.ts'],
      '/workspace/project'
    ),
    ['src/a.ts', 'b.ts']
  )
})

test('formatToolFilePathList keeps a shared parent prefix only on the first path', () => {
  assert.deepEqual(
    formatToolFilePathList(
      [
        '/workspace/project/uncertainty-agent/src/agents/prompts.ts',
        '/workspace/project/uncertainty-agent/src/agents/stage-configs.ts',
        '/workspace/project/uncertainty-agent/src/pipeline.ts'
      ],
      '/workspace/project'
    ),
    ['uncertainty-agent/src/agents/prompts.ts', 'agents/stage-configs.ts', 'pipeline.ts']
  )
})

test('formatToolFilePathList preserves root-level paths mixed with nested paths', () => {
  assert.deepEqual(
    formatToolFilePathList(
      ['/workspace/project/src/a.ts', '/workspace/project/b.ts'],
      '/workspace/project'
    ),
    ['src/a.ts', 'b.ts']
  )
})

test('formatToolFilePathList keeps distinct directories when paths differ', () => {
  assert.deepEqual(
    formatToolFilePathList(
      ['/workspace/project/src/a.ts', '/workspace/project/test/b.ts'],
      '/workspace/project'
    ),
    ['src/a.ts', 'test/b.ts']
  )
})
