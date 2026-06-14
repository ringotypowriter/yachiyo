import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildToolCallDetailsPresentation,
  buildToolCallRowSummary,
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

test('buildToolCallDetailsPresentation uses recovered raw input and output when available', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'write',
    rawInput: { path: 'notes.txt', content: 'full input' },
    rawOutput: { type: 'content', value: [{ type: 'text', text: 'full output' }] }
  })

  assert.deepEqual(presentation.input, {
    label: 'Input',
    value: '{\n  "path": "notes.txt",\n  "content": "full input"\n}'
  })
  assert.deepEqual(presentation.output, { label: 'Output', value: 'full output' })
})

test('buildToolCallDetailsPresentation shows read content excerpt from details when raw output is absent', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    details: {
      path: '/workspace/notes.txt',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      totalBytes: 16,
      truncated: false,
      content: '1➔alpha\n2➔omega'
    }
  })

  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: '1➔alpha\n2➔omega'
  })
})

test('buildToolCallDetailsPresentation shows complete bash command and output from details', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    inputSummary: 'printf lines',
    outputSummary: 'line 1',
    details: {
      command: 'printf "line 1\\nline 2"',
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'line 1\nline 2\n',
      stderr: ''
    }
  })

  assert.deepEqual(presentation.input, {
    label: 'Input',
    value: 'printf "line 1\\nline 2"'
  })
  assert.deepEqual(presentation.metadata, {
    label: 'Metadata',
    value: '{\n  "cwd": "/workspace",\n  "exitCode": 0\n}'
  })
  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: 'stdout:\nline 1\nline 2'
  })
})

test('buildToolCallDetailsPresentation keeps failed bash stderr complete and dangerous', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    status: 'failed',
    error: 'command failed',
    details: {
      command: 'pnpm test',
      cwd: '/workspace',
      exitCode: 1,
      stdout: '',
      stderr: 'first error\nsecond error\n'
    }
  })

  assert.equal(presentation.output?.tone, 'danger')
  assert.equal(
    presentation.output?.value,
    'stderr:\nfirst error\nsecond error\n\nerror:\ncommand failed'
  )
  assert.deepEqual(presentation.metadata, {
    label: 'Metadata',
    value: '{\n  "cwd": "/workspace",\n  "exitCode": 1\n}'
  })
})

test('buildToolCallRowSummary uses fixed bash status instead of output in the collapsed row', () => {
  const summary = buildToolCallRowSummary({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    inputSummary: 'pnpm lint',
    outputSummary: 'massive stdout that should only appear after expanding details'
  })

  assert.deepEqual(summary, {
    inputSummary: 'pnpm lint',
    outputSummary: 'completed'
  })
})

test('buildToolCallDetailsPresentation separates grep input, metadata, and output', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'grep',
    inputSummary: 'needle',
    outputSummary: 'found 1 match',
    details: {
      backend: 'rg',
      pattern: 'needle',
      path: 'src',
      resultCount: 1,
      truncated: false,
      matches: [{ path: 'src/a.ts', line: 1, text: 'needle' }]
    }
  })

  assert.deepEqual(presentation.input, {
    label: 'Input',
    value: '{\n  "pattern": "needle",\n  "path": "src"\n}'
  })
  assert.deepEqual(presentation.metadata, {
    label: 'Metadata',
    value: '{\n  "backend": "rg",\n  "resultCount": 1,\n  "truncated": false\n}'
  })
  assert.ok(presentation.output?.value.includes('"matches"'))
  assert.ok(presentation.output?.value.includes('src/a.ts'))
  assert.ok(!presentation.output?.value.includes('"backend"'))
})

test('buildToolCallDetailsPresentation renders applyPatch output as diff from operation details', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'applyPatch',
    rawOutput: {
      type: 'content',
      value: [{ type: 'text', text: 'Applied 1 change:\nUpdated src/a.ts' }]
    },
    details: {
      operations: [
        {
          path: 'src/a.ts',
          operation: 'update',
          diff:
            'Index: src/a.ts\n' +
            '===================================================================\n' +
            '--- src/a.ts\n' +
            '+++ src/a.ts\n' +
            '@@ -1,1 +1,1 @@\n' +
            '-old\n' +
            '+new\n'
        }
      ]
    }
  })

  assert.deepEqual(presentation.output, {
    label: 'diff: src/a.ts',
    value:
      'Index: src/a.ts\n' +
      '===================================================================\n' +
      '--- src/a.ts\n' +
      '+++ src/a.ts\n' +
      '@@ -1,1 +1,1 @@\n' +
      '-old\n' +
      '+new',
    filePath: 'src/a.ts'
  })
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
