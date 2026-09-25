import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolCallRecord } from '@yachiyo/shared/protocol'

import {
  buildToolCallDetailsPresentation,
  buildToolCallRowSummary,
  canExpandToolCall,
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

test('failed raw tool output retains its danger state', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'webSearch',
    status: 'failed',
    error: 'Search unavailable',
    rawOutput: { type: 'content', value: [{ type: 'text', text: 'Search unavailable' }] }
  })
  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: 'Search unavailable',
    tone: 'danger'
  })
})

test('delegateTask detail shows the complete request instead of its agent name summary', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'delegateTask',
    inputSummary: 'general',
    rawInput: {
      agent_name: 'general',
      prompt: 'Investigate the failed request and report the cause.',
      workspace: '/workspace'
    }
  })

  assert.deepEqual(JSON.parse(presentation.input!.value), {
    agent_name: 'general',
    prompt: 'Investigate the failed request and report the cause.',
    workspace: '/workspace'
  })
})

test('steerTask detail shows the message sent to the task, not just its ID', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'steerTask',
    inputSummary: 'call-worker-1',
    rawInput: { taskId: 'call-worker-1', message: 'Inspect the failing test and report why.' }
  })

  assert.deepEqual(JSON.parse(presentation.input!.value), {
    taskId: 'call-worker-1',
    message: 'Inspect the failing test and report why.'
  })
})

test('message, memory, schedule, and source tools show their full arguments, not just summaries', () => {
  const calls = [
    {
      toolName: 'sendThreadMessage',
      inputSummary: 'thread-2',
      input: { targetThreadId: 'thread-2', message: 'Full handoff message' }
    },
    {
      toolName: 'remember',
      inputSummary: 'remember',
      input: { note: 'Full source-linked note', sources: ['message-1'] }
    },
    {
      toolName: 'useSentinel',
      inputSummary: 'useSentinel',
      input: {
        action: 'set',
        goal: 'Check build',
        stopCondition: 'Build passes',
        intervalMinutes: 5
      }
    },
    {
      toolName: 'querySource',
      inputSummary: 'querySource',
      input: { text: 'Full search query', limit: 10 }
    }
  ]

  for (const { toolName, inputSummary, input } of calls) {
    const presentation = buildToolCallDetailsPresentation({
      ...BASE_TOOL_CALL,
      toolName,
      inputSummary,
      rawInput: input
    })
    assert.deepEqual(JSON.parse(presentation.input!.value), input, toolName)
  }
})

test('canExpandToolCall cheaply recognizes calls with presentable details', () => {
  assert.equal(canExpandToolCall({ ...BASE_TOOL_CALL, inputSummary: '' }), false)
  assert.equal(canExpandToolCall({ ...BASE_TOOL_CALL, error: 'tool failed' }), true)
  assert.equal(canExpandToolCall({ ...BASE_TOOL_CALL, rawInput: { path: 'notes.txt' } }), true)
  assert.equal(
    canExpandToolCall({
      ...BASE_TOOL_CALL,
      details: {
        path: 'notes.txt',
        startLine: 1,
        endLine: 1,
        totalLines: 1,
        totalBytes: 5,
        truncated: false,
        content: 'notes'
      }
    }),
    true
  )
})

test('canExpandToolCall keeps askUser interactive without persisted detail blocks', () => {
  assert.equal(
    canExpandToolCall({ ...BASE_TOOL_CALL, toolName: 'askUser', inputSummary: '' }),
    true
  )
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

test('read details retain the continuation offset for truncated output', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    details: {
      path: '/workspace/long.txt',
      startLine: 1,
      endLine: 100,
      totalLines: 400,
      totalBytes: 9000,
      truncated: true,
      nextOffset: 101,
      remainingLines: 300,
      content: 'first page'
    }
  })
  assert.deepEqual(JSON.parse(presentation.metadata!.value), {
    truncated: true,
    nextOffset: 101,
    remainingLines: 300
  })
})

test('webRead keeps saved-file and truncation metadata beside recovered output', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'webRead',
    rawOutput: { type: 'content', value: [{ type: 'text', text: 'Page excerpt' }] },
    details: {
      requestedUrl: 'https://example.com',
      extractor: 'none',
      content: 'Page excerpt',
      contentFormat: 'markdown',
      contentChars: 12,
      truncated: true,
      originalContentChars: 30000,
      savedFilePath: '/workspace/page.md'
    }
  })
  assert.deepEqual(JSON.parse(presentation.metadata!.value), {
    truncated: true,
    originalContentChars: 30000,
    savedFilePath: '/workspace/page.md'
  })
  assert.equal(presentation.output?.value, 'Page excerpt')
})

test('write detail-only records show content as an input preview, not tool output', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'write',
    details: {
      path: '/workspace/long.txt',
      contentPreview: 'first lines',
      bytesWritten: 9000,
      created: true,
      overwritten: false
    }
  })
  assert.equal(presentation.input?.label, 'Input preview')
  assert.deepEqual(JSON.parse(presentation.input!.value), {
    path: '/workspace/long.txt',
    contentPreview: 'first lines'
  })
  assert.deepEqual(JSON.parse(presentation.output!.value), {
    bytesWritten: 9000,
    created: true,
    overwritten: false
  })
})

test('write with raw input shows full content once and preserves the tool receipt', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'write',
    rawInput: { path: '/workspace/a.txt', content: 'complete content' },
    rawOutput: { type: 'content', value: [{ type: 'text', text: 'Wrote a.txt' }] },
    details: {
      path: '/workspace/a.txt',
      contentPreview: 'complete content',
      bytesWritten: 16,
      created: false,
      overwritten: true
    }
  })
  assert.deepEqual(JSON.parse(presentation.input!.value), {
    path: '/workspace/a.txt',
    content: 'complete content'
  })
  assert.equal(presentation.output?.value, 'Wrote a.txt')
})

test('buildToolCallDetailsPresentation shows persisted browser snapshot content', () => {
  const content = [
    'Results',
    'https://example.com/results',
    '',
    '@e1 <a> — First result',
    '@e40 <button> — Last result'
  ].join('\n')
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'useBrowser',
    inputSummary: 'snapshot (ssd-price)',
    outputSummary: 'snapshot (40 refs)',
    details: {
      kind: 'useBrowser',
      action: 'snapshot',
      session: 'ssd-price',
      finalUrl: 'https://example.com/results',
      title: 'Results',
      refCount: 40,
      content
    }
  })

  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: content
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

test('bash details keep the command and stdout/stderr readable when response trace is present', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    inputSummary: 'Run checks',
    rawInput: {
      command: 'pnpm lint && pnpm typecheck',
      description: 'Run checks',
      timeout: 90,
      background: false
    },
    rawOutput: { type: 'content', value: [{ type: 'text', text: 'combined model output' }] },
    details: {
      command: 'pnpm lint && pnpm typecheck',
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'lint passed\n',
      stderr: 'warning\n'
    }
  })

  assert.equal(presentation.input?.value, 'pnpm lint && pnpm typecheck')
  assert.deepEqual(JSON.parse(presentation.metadata!.value), {
    cwd: '/workspace',
    timeout: 90,
    background: false,
    exitCode: 0
  })
  assert.equal(presentation.output?.value, 'stdout:\nlint passed\n\nstderr:\nwarning')
})

test('bash and edit retain raw responses when structured details are unavailable', () => {
  for (const toolName of ['bash', 'edit'] as const) {
    const presentation = buildToolCallDetailsPresentation({
      ...BASE_TOOL_CALL,
      toolName,
      outputSummary: 'short summary',
      rawOutput: { type: 'content', value: [{ type: 'text', text: 'Full tool response' }] }
    })
    assert.equal(presentation.output?.value, 'Full tool response')
  }
})

test('buildToolCallDetailsPresentation shows jsRepl display and result output', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'jsRepl',
    inputSummary: 'inspect answer',
    details: {
      code: 'display({ answer: 42 }); "done"',
      title: 'inspect answer',
      displayOutput: '{\n  "answer": 42\n}',
      result: 'done'
    }
  })

  assert.deepEqual(presentation.input, {
    label: 'Input',
    value: 'display({ answer: 42 }); "done"',
    language: 'javascript'
  })
  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: 'display:\n{\n  "answer": 42\n}\n\nresult:\ndone',
    language: 'javascript'
  })
})

test('buildToolCallDetailsPresentation shows pyRepl streams, rich output, and errors', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'pyRepl',
    status: 'failed',
    inputSummary: 'inspect answer',
    rawOutput: { type: 'text', value: 'hydrated model output' },
    details: {
      code: 'print("before"); display({"answer": 42}); raise ValueError("boom")',
      title: 'inspect answer',
      stdout: 'before\n',
      stderr: 'warning\n',
      displayOutput: '{\n  "answer": 42\n}',
      result: '42',
      error: 'ValueError: boom',
      contextReset: true
    }
  })

  assert.deepEqual(presentation.input, {
    label: 'Input',
    value: 'print("before"); display({"answer": 42}); raise ValueError("boom")',
    language: 'python'
  })
  assert.deepEqual(presentation.output, {
    label: 'Output',
    value:
      'stdout:\nbefore\n\nstderr:\nwarning\n\ndisplay:\n{\n  "answer": 42\n}\n\nresult:\n42\n\nerror:\nValueError: boom',
    language: 'python',
    tone: 'danger'
  })
})

test('buildToolCallDetailsPresentation keeps hydrated pyRepl errors structured', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'pyRepl',
    status: 'failed',
    rawOutput: { type: 'error-text', value: 'hydrated error wrapper' },
    details: {
      code: 'raise ValueError("boom")',
      error: 'ValueError: boom'
    }
  })

  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: 'error:\nValueError: boom',
    language: 'python',
    tone: 'danger'
  })
})

test('buildToolCallDetailsPresentation omits hydrated pyRepl image payloads', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'pyRepl',
    rawOutput: {
      type: 'content',
      value: [{ type: 'image', data: 'sensitive-base64', mimeType: 'image/png' }]
    },
    details: {
      code: 'chart',
      result: 'chart'
    }
  })

  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: 'result:\nchart',
    language: 'python'
  })
})

test('pyRepl raw-only text remains visible without exposing image data', () => {
  const call: ToolCallRecord = {
    ...BASE_TOOL_CALL,
    toolName: 'pyRepl',
    status: 'failed',
    inputSummary: '',
    outputSummary: 'short summary',
    rawOutput: {
      type: 'content',
      value: [
        { type: 'text', text: 'answer: 42' },
        { type: 'image', data: 'sensitive-base64', mimeType: 'image/png' }
      ]
    }
  }
  assert.equal(canExpandToolCall(call), true)
  assert.deepEqual(buildToolCallDetailsPresentation(call).output, {
    label: 'Output',
    value: 'answer: 42',
    tone: 'danger',
    language: 'python'
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

test('buildToolCallRowSummary prefers bash description over raw command input', () => {
  const summary = buildToolCallRowSummary({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    inputSummary: 'git add && git commit',
    details: {
      command: 'git add && git commit',
      description: 'Commit staged changes',
      cwd: '/workspace',
      exitCode: 0,
      stdout: '',
      stderr: ''
    }
  })

  assert.equal(summary.inputSummary, 'Commit staged changes')
})

test('buildToolCallRowSummary uses bash description from recovered raw input', () => {
  const summary = buildToolCallRowSummary({
    ...BASE_TOOL_CALL,
    toolName: 'bash',
    inputSummary: 'git diff --stat && git diff',
    rawInput: {
      command: 'git diff --stat && git diff',
      description: 'Review current code changes',
      timeout: 30,
      background: false
    }
  })

  assert.equal(summary.inputSummary, 'Review current code changes')
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

test('applyPatch shows the submitted patch once and the tool receipt as output', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch'
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'applyPatch',
    inputSummary: 'Update src/a.ts',
    rawInput: { patch },
    rawOutput: {
      type: 'content',
      value: [{ type: 'text', text: 'Applied 1 change:\nUpdated src/a.ts' }]
    },
    details: {
      operations: [
        { operation: 'update', path: 'src/a.ts', diff: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new' }
      ]
    }
  })

  assert.equal(presentation.input?.value, patch)
  assert.equal(presentation.output?.value, 'Applied 1 change:\nUpdated src/a.ts')
})

test('buildToolCallDetailsPresentation renders edit output as diff from details', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'edit',
    rawOutput: {
      type: 'content',
      value: [{ type: 'text', text: 'Edited src/a.ts (1 replacement)' }]
    },
    details: {
      path: 'src/a.ts',
      mode: 'inline',
      replacements: 1,
      diff: '--- src/a.ts\n' + '+++ src/a.ts\n' + '@@ -1,1 +1,1 @@\n' + '-old\n' + '+new\n',
      firstChangedLine: 1
    }
  })

  // The diff must render as a colored diff block (label starts with "diff:"),
  // taking precedence over rawOutput — not collapse into a generic JSON dump.
  assert.deepEqual(presentation.output, {
    label: 'diff: src/a.ts',
    value: '--- src/a.ts\n' + '+++ src/a.ts\n' + '@@ -1,1 +1,1 @@\n' + '-old\n' + '+new',
    filePath: 'src/a.ts'
  })
})

test('edit with original request shows its changes once, not a second copy as diff', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'edit',
    inputSummary: 'src/a.ts',
    rawInput: { path: 'src/a.ts', mode: 'inline', oldText: 'old', newText: 'new' },
    rawOutput: {
      type: 'content',
      value: [{ type: 'text', text: 'Updated src/a.ts\n\n-old\n+new' }]
    },
    details: {
      path: 'src/a.ts',
      mode: 'inline',
      replacements: 1,
      firstChangedLine: 1,
      diff: '-old\n+new'
    }
  })

  assert.deepEqual(JSON.parse(presentation.input!.value), {
    path: 'src/a.ts',
    mode: 'inline',
    oldText: 'old',
    newText: 'new'
  })
  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: '{\n  "replacements": 1,\n  "firstChangedLine": 1\n}'
  })
})

test('buildToolCallDetailsPresentation falls back to output when edit has no diff', () => {
  const presentation = buildToolCallDetailsPresentation({
    ...BASE_TOOL_CALL,
    toolName: 'edit',
    details: {
      path: 'src/a.ts',
      mode: 'inline',
      replacements: 1
    }
  })

  assert.deepEqual(presentation.output, {
    label: 'Output',
    value: '{\n  "replacements": 1\n}'
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
