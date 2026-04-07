import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  createAgentToolSet,
  normalizeToolResult,
  runGlobTool,
  runGrepTool,
  runBashTool,
  runEditTool,
  runReadTool,
  runWebReadTool,
  runWebSearchTool,
  runWriteTool,
  summarizeToolInput,
  summarizeToolOutput,
  streamBashTool
} from './agentTools.ts'
import { createTool as createDelegateCodingTaskTool } from './agentTools/delegateCodingTaskTool.ts'
import { resolveGlobInput } from './agentTools/globTool.ts'
import type { MemoryService } from '../services/memory/memoryService.ts'
import { createTool as createSearchMemoryTool } from './agentTools/searchMemoryTool.ts'

async function withWorkspace(fn: (workspacePath: string) => Promise<void> | void): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-agent-tools-'))

  try {
    await fn(workspacePath)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

function flattenToolContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

test('runReadTool uses offset/limit continuation semantics and returns truncation hints', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive', 'utf8')

    const result = await runReadTool(
      {
        path: 'notes.txt',
        offset: 1,
        limit: 2
      },
      { workspacePath }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.path, join(workspacePath, 'notes.txt'))
    assert.equal(result.details.startLine, 2)
    assert.equal(result.details.endLine, 3)
    assert.equal(result.details.totalLines, 5)
    assert.equal(result.details.truncated, true)
    assert.equal(result.details.nextOffset, 3)
    assert.equal(result.details.remainingLines, 2)
    assert.equal(
      flattenToolContent(result.content),
      'two\nthree\n\n[truncated: continue with offset 3]'
    )
  })
})

test('createAgentToolSet adds searchMemory only when memory is configured', () => {
  const baseMemoryService: MemoryService = {
    hasHiddenSearchCapability: () => true,
    isConfigured: () => true,
    searchMemories: async () => [],
    testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
    recallForContext: async ({ thread }) => ({
      decision: {
        shouldRecall: false,
        score: 0,
        reasons: [],
        messagesSinceLastRecall: 0,
        charsSinceLastRecall: 0,
        idleMs: 0,
        noveltyScore: 0,
        novelTerms: []
      },
      entries: [],
      thread
    }),
    createMemory: async () => ({ savedCount: 0 }),
    validateAndCreateMemory: async () => ({ savedCount: 0 }),
    distillCompletedRun: async () => ({ savedCount: 0 }),
    saveThread: async () => ({ savedCount: 0 })
  }

  const withMemory = createAgentToolSet(
    {
      enabledTools: ['read', 'bash'],
      workspacePath: '/tmp/yachiyo'
    },
    {
      memoryService: baseMemoryService
    }
  )
  const withoutMemory = createAgentToolSet(
    {
      enabledTools: ['read', 'bash'],
      workspacePath: '/tmp/yachiyo'
    },
    {
      memoryService: {
        ...baseMemoryService,
        hasHiddenSearchCapability: () => false,
        isConfigured: () => false
      }
    }
  )

  assert.ok(withMemory)
  assert.ok(withoutMemory)
  assert.equal('searchMemory' in withMemory, true)
  assert.equal('searchMemory' in withoutMemory, false)
  assert.equal('searchMemory' in (withMemory ?? {}), true)
  assert.equal('searchMemory' in (withoutMemory ?? {}), false)
})

test('searchMemory forwards the abort signal to memory service lookups', async () => {
  const abortController = new AbortController()
  let receivedSignal: AbortSignal | undefined
  const searchMemoryTool = createSearchMemoryTool({
    hasHiddenSearchCapability: () => true,
    isConfigured: () => true,
    searchMemories: async ({ signal }) => {
      receivedSignal = signal
      return []
    },
    testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
    recallForContext: async ({ thread }) => ({
      decision: {
        shouldRecall: false,
        score: 0,
        reasons: [],
        messagesSinceLastRecall: 0,
        charsSinceLastRecall: 0,
        idleMs: 0,
        noveltyScore: 0,
        novelTerms: []
      },
      entries: [],
      thread
    }),
    createMemory: async () => ({ savedCount: 0 }),
    validateAndCreateMemory: async () => ({ savedCount: 0 }),
    distillCompletedRun: async () => ({ savedCount: 0 }),
    saveThread: async () => ({ savedCount: 0 })
  })

  assert.equal(typeof searchMemoryTool.execute, 'function')
  const executeOptions: Parameters<NonNullable<typeof searchMemoryTool.execute>>[1] = {
    abortSignal: abortController.signal,
    toolCallId: 'search-memory-tool-call',
    messages: []
  }

  await searchMemoryTool.execute!(
    {
      query: 'deploy workflow'
    },
    executeOptions
  )

  assert.equal(receivedSignal, abortController.signal)
})

test('runWriteTool overwrites existing files by default and reports bytes plus overwrite state', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'draft.txt'), 'first', 'utf8')

    const result = await runWriteTool(
      {
        path: 'draft.txt',
        content: 'second'
      },
      { workspacePath }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.path, join(workspacePath, 'draft.txt'))
    assert.equal(result.details.bytesWritten, 6)
    assert.equal(result.details.created, false)
    assert.equal(result.details.overwritten, true)
    assert.match(flattenToolContent(result.content), /Overwrote 6 bytes/)
    assert.equal(await readFile(join(workspacePath, 'draft.txt'), 'utf8'), 'second')
  })
})

test('runEditTool rejects ambiguous matches and returns diff metadata for a targeted replacement', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'ambiguous.txt'), 'alpha beta alpha', 'utf8')

    const ambiguous = await runEditTool(
      {
        path: 'ambiguous.txt',
        oldText: 'alpha',
        newText: 'omega'
      },
      { workspacePath }
    )

    assert.match(ambiguous.error ?? '', /matched multiple locations/i)
    assert.equal(ambiguous.details.replacements, 0)

    await writeFile(join(workspacePath, 'draft.txt'), 'alpha\nbeta\ngamma', 'utf8')

    const replaced = await runEditTool(
      {
        path: 'draft.txt',
        oldText: 'beta',
        newText: 'omega'
      },
      { workspacePath }
    )

    assert.equal(replaced.error, undefined)
    assert.equal(replaced.details.replacements, 1)
    assert.equal(replaced.details.firstChangedLine, 2)
    assert.match(replaced.details.diff ?? '', /-beta/)
    assert.match(replaced.details.diff ?? '', /\+omega/)
    assert.equal(await readFile(join(workspacePath, 'draft.txt'), 'utf8'), 'alpha\nomega\ngamma')
  })
})

test('streamBashTool emits preliminary updates and runBashTool returns a structured final result', async () => {
  await withWorkspace(async (workspacePath) => {
    const parts: string[] = []

    for await (const result of streamBashTool(
      {
        command: 'pwd',
        timeout: 5
      },
      { workspacePath },
      {
        runCommand: async ({ command, cwd, timeoutSeconds, onStderr, onStdout }) => {
          assert.equal(command, 'pwd')
          assert.equal(cwd, workspacePath)
          assert.equal(timeoutSeconds, 5)

          onStdout?.(`${cwd}\n`)
          onStderr?.('warning\n')

          return {
            exitCode: 0,
            stdout: `${cwd}\n`,
            stderr: 'warning\n'
          }
        }
      }
    )) {
      parts.push(flattenToolContent(result.content))
    }

    assert.equal(parts.length, 3)
    assert.equal(parts[0], `${workspacePath}\n`)
    assert.equal(parts[1], `${workspacePath}\nwarning\n`)
    assert.equal(parts[2], `${workspacePath}\nwarning\n`)

    const finalResult = await runBashTool(
      {
        command: 'pwd',
        timeout: 5
      },
      { workspacePath },
      {
        runCommand: async ({ onStderr, onStdout }) => {
          onStdout?.(`${workspacePath}\n`)
          onStderr?.('warning\n')
          return {
            exitCode: 0,
            stdout: `${workspacePath}\n`,
            stderr: 'warning\n'
          }
        }
      }
    )

    assert.equal(finalResult.error, undefined)
    assert.equal(finalResult.metadata.cwd, workspacePath)
    assert.equal(finalResult.metadata.exitCode, 0)
    assert.equal(finalResult.details.command, 'pwd')
    assert.equal(finalResult.details.cwd, workspacePath)
    assert.equal(finalResult.details.stdout, `${workspacePath}\n`)
    assert.equal(finalResult.details.stderr, 'warning\n')
    assert.equal(flattenToolContent(finalResult.content), `${workspacePath}\nwarning\n`)
  })
})

test('streamBashTool abortSignal stops a long-running command without waiting for bash timeout', async () => {
  await withWorkspace(async (workspacePath) => {
    const controller = new AbortController()
    const started = performance.now()

    const drain = Array.fromAsync(
      streamBashTool(
        {
          command: 'sleep 60',
          timeout: 120
        },
        { workspacePath },
        { abortSignal: controller.signal }
      )
    )

    setTimeout(() => {
      controller.abort()
    }, 25)

    await assert.rejects(
      drain,
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )

    assert.ok(
      performance.now() - started < 8000,
      'expected Stop/cancel to tear down the shell quickly, not after the full sleep'
    )
  })
})

test('delegateCodingTask rethrows aborts so Stop force-kills the delegated agent', async () => {
  await withWorkspace(async (workspacePath) => {
    const controller = new AbortController()
    const lifecycle: string[] = []
    const delegateCodingTaskTool = createDelegateCodingTaskTool({
      workspacePath,
      availableWorkspaces: [],
      profiles: [
        {
          id: 'agent-1',
          name: 'Worker',
          enabled: true,
          description: 'Test worker',
          command: 'fake-agent',
          args: [],
          env: {}
        }
      ],
      onSubagentStarted: (agentName) => {
        lifecycle.push(`started:${agentName}`)
      },
      onSubagentFinished: (agentName, status) => {
        lifecycle.push(`finished:${agentName}:${status}`)
      },
      launchAcpProcess: () =>
        ({
          proc: { stderr: { on: () => undefined } },
          stream: {},
          procExited: Promise.resolve()
        }) as never,
      runAcpSession: async () => {
        controller.abort(new Error('force kill'))
        throw Object.assign(new Error('force kill'), { name: 'AbortError' })
      }
    })

    assert.equal(typeof delegateCodingTaskTool.execute, 'function')
    const executeDelegateCodingTask = delegateCodingTaskTool.execute
    assert.ok(executeDelegateCodingTask)

    await assert.rejects(
      async () => {
        await executeDelegateCodingTask(
          {
            agent_name: 'Worker',
            prompt: 'Investigate and patch the issue.'
          },
          {
            abortSignal: controller.signal,
            toolCallId: 'delegate-coding-task-test',
            messages: []
          }
        )
      },
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )

    assert.deepEqual(lifecycle, ['started:Worker', 'finished:Worker:cancelled'])
  })
})

test('runBashTool maps timeout failures into structured metadata', async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await runBashTool(
      {
        command: 'sleep 10',
        timeout: 1
      },
      { workspacePath },
      {
        runCommand: async () => ({
          exitCode: 124,
          stdout: '',
          stderr: 'timed out',
          timedOut: true
        })
      }
    )

    assert.equal(result.error, 'Command timed out after 1 second.')
    assert.equal(result.metadata.timedOut, true)
    assert.equal(result.details.timedOut, true)
    assert.equal(result.details.exitCode, 124)
    assert.match(flattenToolContent(result.content), /timed out/i)
  })
})

test('runBashTool auto-saves to .yachiyo/tool-output when output exceeds inline limit', async () => {
  await withWorkspace(async (workspacePath) => {
    const largeOutput = 'x'.repeat(25_000)

    const result = await runBashTool(
      { command: 'echo large' },
      { workspacePath },
      {
        runCommand: async () => ({
          exitCode: 0,
          stdout: largeOutput,
          stderr: ''
        })
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.truncated, true)
    assert.ok(result.details.outputFilePath?.includes('.yachiyo/tool-output'))
    assert.equal(await readFile(result.details.outputFilePath!, 'utf8'), largeOutput)
    assert.match(flattenToolContent(result.content), /Output too large to inline/)
    assert.match(flattenToolContent(result.content), /Use the read tool/)
    assert.doesNotMatch(flattenToolContent(result.content), /x{100}/)
  })
})

test('runGrepTool maps normalized search results into structured details and summaries', async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await runGrepTool(
      {
        pattern: 'needle',
        path: '.',
        limit: 5
      },
      { workspacePath },
      {
        searchService: {
          capabilities: {
            grep: { available: 'rg' },
            fileDiscovery: { available: 'fd' }
          },
          grep: async () => ({
            backend: 'rg' as const,
            rootPath: workspacePath,
            matches: [
              {
                path: 'src/example.ts',
                line: 12,
                text: 'const needle = true'
              }
            ],
            truncated: false
          }),
          glob: async () => {
            throw new Error('glob should not be called')
          }
        }
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.backend, 'rg')
    assert.equal(result.details.resultCount, 1)
    assert.equal(summarizeToolInput('grep', { pattern: 'needle' }), 'needle')
    assert.equal(summarizeToolOutput('grep', result), 'found 1 match')
    assert.match(flattenToolContent(result.content), /src\/example\.ts:12: const needle = true/)

    const normalized = normalizeToolResult('grep', result)
    assert.equal(normalized.status, 'completed')
    assert.equal(normalized.outputSummary, 'found 1 match')
  })
})

test('resolveGlobInput splits tilde/absolute patterns into path + basename', () => {
  const home = process.env.HOME ?? '/Users/test'
  const workspace = '/workspace'
  const normalizeDir = (value: string): string => value.replace(/\/+$/, '') || '/'

  // ~/.aerospace* → dir: home, pattern: .aerospace*
  const tildeResult = resolveGlobInput('~/.aerospace*', undefined, workspace)
  assert.equal(normalizeDir(tildeResult.searchPath), normalizeDir(home))
  assert.equal(tildeResult.pattern, '.aerospace*')

  // /Users/foo/.config → dir: /Users/foo, pattern: .config
  const absResult = resolveGlobInput('/Users/foo/.config', undefined, workspace)
  assert.equal(absResult.searchPath, '/Users/foo')
  assert.equal(absResult.pattern, '.config')

  // relative pattern — unchanged, uses explicit path
  const relResult = resolveGlobInput('src/**/*.ts', 'lib', workspace)
  assert.equal(relResult.searchPath, 'lib')
  assert.equal(relResult.pattern, 'src/**/*.ts')

  // relative pattern with no path — defaults to '.' (relative to cwd)
  const noPathResult = resolveGlobInput('**/*.ts', undefined, workspace)
  assert.equal(noPathResult.searchPath, '.')
  assert.equal(noPathResult.pattern, '**/*.ts')
})

test('runGlobTool maps normalized file discovery results into structured details and summaries', async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await runGlobTool(
      {
        pattern: 'src/**/*.ts',
        path: '.',
        limit: 5
      },
      { workspacePath },
      {
        searchService: {
          capabilities: {
            grep: { available: 'rg' },
            fileDiscovery: { available: 'fd' }
          },
          grep: async () => {
            throw new Error('grep should not be called')
          },
          glob: async () => ({
            backend: 'fd' as const,
            rootPath: workspacePath,
            paths: ['src/example.ts', 'src/search/tool.ts'],
            truncated: false
          })
        }
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.backend, 'fd')
    assert.equal(result.details.resultCount, 2)
    assert.equal(summarizeToolInput('glob', { pattern: 'src/**/*.ts' }), 'src/**/*.ts')
    assert.equal(summarizeToolOutput('glob', result), 'found 2 files')
    assert.match(flattenToolContent(result.content), /src\/example\.ts/)

    const normalized = normalizeToolResult('glob', result)
    assert.equal(normalized.status, 'completed')
    assert.equal(normalized.outputSummary, 'found 2 files')
  })
})

test('runWebReadTool maps service results into structured details and summaries', async () => {
  await withWorkspace(async (workspacePath) => {
    const response = new Response('<html><body><article>stub</article></body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    })

    Object.defineProperty(response, 'url', {
      configurable: true,
      value: 'https://example.com/final-article'
    })

    const result = await runWebReadTool(
      {
        url: 'https://example.com/article'
      },
      { workspacePath },
      {
        fetchImpl: async () => response,
        extractReadableContent: async () => ({
          extractor: 'defuddle',
          title: 'Example article',
          author: 'A. Writer',
          siteName: 'Example Site',
          publishedTime: '2026-03-21',
          description: 'Short summary.',
          content: 'First paragraph.\n\nSecond paragraph.'
        })
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.requestedUrl, 'https://example.com/article')
    assert.equal(result.details.finalUrl, 'https://example.com/final-article')
    assert.equal(result.details.httpStatus, 200)
    assert.equal(result.details.extractor, 'defuddle')
    assert.equal(result.details.contentFormat, 'markdown')
    assert.equal(
      summarizeToolInput('webRead', {
        url: 'https://example.com/article'
      }),
      'https://example.com/article'
    )
    assert.equal(summarizeToolOutput('webRead', result), 'read "Example article"')

    const normalized = normalizeToolResult('webRead', result)
    assert.equal(normalized.status, 'completed')
    assert.equal(normalized.outputSummary, 'read "Example article"')
    assert.equal(
      normalized.details && 'extractor' in normalized.details
        ? normalized.details.extractor
        : undefined,
      'defuddle'
    )
    assert.match(flattenToolContent(result.content), /Title: Example article/)
    assert.match(flattenToolContent(result.content), /First paragraph\./)
  })
})

test('runWebReadTool reports raw format for non-HTML responses', async () => {
  await withWorkspace(async (workspacePath) => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: {
        'content-type': 'application/json'
      }
    })

    Object.defineProperty(response, 'url', {
      configurable: true,
      value: 'https://example.com/data'
    })

    const result = await runWebReadTool(
      {
        url: 'https://example.com/data'
      },
      { workspacePath },
      {
        fetchImpl: async () => response
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.requestedUrl, 'https://example.com/data')
    assert.equal(result.details.finalUrl, 'https://example.com/data')
    assert.equal(result.details.contentType, 'application/json')
    assert.equal(result.details.extractor, 'none')
    assert.equal(result.details.contentFormat, 'raw')
    assert.equal(result.details.content, '{"ok":true}')
    assert.match(flattenToolContent(result.content), /Format: raw/)
    assert.match(flattenToolContent(result.content), /Extractor: none/)
  })
})

test('runWebReadTool auto-saves to .yachiyo/tool-result when content exceeds inline limit', async () => {
  await withWorkspace(async (workspacePath) => {
    const longContent = `${'A'.repeat(40_000)}\n\nSecond paragraph.`
    const response = new Response('<html><body><article>stub</article></body></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8'
      }
    })

    Object.defineProperty(response, 'url', {
      configurable: true,
      value: 'https://example.com/final-article'
    })

    const result = await runWebReadTool(
      { url: 'https://example.com/article' },
      { workspacePath },
      {
        fetchImpl: async () => response,
        extractReadableContent: async () => ({
          extractor: 'defuddle',
          title: 'Example article',
          description: 'Short summary.',
          content: longContent
        })
      }
    )

    assert.equal(result.error, undefined)
    assert.equal(result.details.truncated, false)
    assert.equal(result.details.contentChars, longContent.length)
    assert.equal(result.details.savedBytes, Buffer.byteLength(longContent, 'utf8'))
    assert.equal(result.details.content, '')
    assert.ok(result.details.savedFilePath?.includes('.yachiyo/tool-result'))
    assert.ok(result.details.savedFileName?.startsWith('.yachiyo/tool-result/web-'))
    assert.equal(await readFile(result.details.savedFilePath!, 'utf8'), longContent)
    assert.match(summarizeToolOutput('webRead', result), /saved to \.yachiyo\/tool-result\/web-/)
    assert.match(flattenToolContent(result.content), /Content too large to inline/)
    assert.match(flattenToolContent(result.content), /Use the read tool/)
    assert.doesNotMatch(flattenToolContent(result.content), /Second paragraph\./)
  })
})

test('runWebSearchTool maps provider-neutral search results into structured details and summaries', async () => {
  const result = await runWebSearchTool(
    {
      query: 'yachiyo electron search',
      limit: 2
    },
    {
      webSearchService: {
        search: async () => ({
          provider: 'google-browser',
          query: 'yachiyo electron search',
          searchUrl: 'https://www.google.com/search?q=yachiyo+electron+search',
          finalUrl: 'https://www.google.com/search?q=yachiyo+electron+search',
          results: [
            {
              rank: 1,
              title: 'Yachiyo Repo',
              url: 'https://example.com/yachiyo',
              snippet: 'Search result snippet.'
            },
            {
              rank: 2,
              title: 'Electron Search Notes',
              url: 'https://example.com/notes'
            }
          ]
        })
      }
    }
  )

  assert.equal(result.error, undefined)
  assert.equal(result.details.provider, 'google-browser')
  assert.equal(result.details.resultCount, 2)
  assert.equal(
    summarizeToolInput('webSearch', { query: 'yachiyo electron search' }),
    'yachiyo electron search'
  )
  assert.equal(summarizeToolOutput('webSearch', result), 'found 2 results')

  const normalized = normalizeToolResult('webSearch', result)
  assert.equal(normalized.status, 'completed')
  assert.equal(normalized.outputSummary, 'found 2 results')
  assert.match(flattenToolContent(result.content), /1\. Yachiyo Repo/)
  assert.match(flattenToolContent(result.content), /Snippet: Search result snippet\./)
})

test('normalizeToolResult returns background status for background bash output', () => {
  const output = {
    content: [{ type: 'text' as const, text: '{"taskId":"bg-123","logPath":"/tmp/bg.log"}' }],
    details: {
      command: 'sleep 10',
      cwd: '/workspace',
      stdout: '',
      stderr: '',
      background: true,
      taskId: 'bg-123',
      logPath: '/tmp/bg.log'
    },
    metadata: { cwd: '/workspace' }
  }

  const normalized = normalizeToolResult('bash', output)
  assert.equal(normalized.status, 'background')
  assert.equal(normalized.outputSummary, 'background: bg-123')
  assert.equal(normalized.cwd, '/workspace')
  assert.equal(normalized.error, undefined)
})

test('normalizeToolResult returns completed for non-background bash output', () => {
  const output = {
    content: [{ type: 'text' as const, text: 'hello' }],
    details: {
      command: 'echo hello',
      cwd: '/workspace',
      stdout: 'hello',
      stderr: '',
      exitCode: 0
    },
    metadata: { cwd: '/workspace', exitCode: 0 }
  }

  const normalized = normalizeToolResult('bash', output)
  assert.equal(normalized.status, 'completed')
  assert.notEqual(normalized.outputSummary, undefined)
})
