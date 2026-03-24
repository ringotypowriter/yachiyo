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
import { resolveGlobInput } from './agentTools/globTool.ts'
import type { MemoryService } from '../services/memory/memoryService.ts'
import { createTool as createMemorySearchTool } from './agentTools/memorySearchTool.ts'

async function withWorkspace(fn: (workspacePath: string) => Promise<void> | void): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-agent-tools-'))

  try {
    await fn(workspacePath)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

function flattenToolContent(
  content: Array<{
    type: 'text'
    text: string
  }>
): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
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

test('createAgentToolSet adds hidden memory_search only when memory is configured', () => {
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
  assert.equal('memory_search' in withMemory, true)
  assert.equal('memory_search' in withoutMemory, false)
  assert.equal('memory_search' in (withMemory ?? {}), true)
  assert.equal('memory_search' in (withoutMemory ?? {}), false)
})

test('memory_search forwards the abort signal to memory service lookups', async () => {
  const abortController = new AbortController()
  let receivedSignal: AbortSignal | undefined
  const memorySearchTool = createMemorySearchTool({
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
    distillCompletedRun: async () => ({ savedCount: 0 }),
    saveThread: async () => ({ savedCount: 0 })
  })

  assert.equal(typeof memorySearchTool.execute, 'function')
  const executeOptions: Parameters<NonNullable<typeof memorySearchTool.execute>>[1] = {
    abortSignal: abortController.signal,
    toolCallId: 'memory-search-tool-call',
    messages: []
  }

  await memorySearchTool.execute!(
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
            grep: {
              preferred: 'rg',
              backends: {
                rg: { executable: '/usr/bin/rg' }
              }
            },
            fileDiscovery: {
              preferred: 'fd',
              backends: {
                fd: { executable: '/usr/bin/fd' }
              }
            }
          },
          grep: async () => ({
            backend: 'rg',
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

  // ~/.aerospace* → dir: home, pattern: .aerospace*
  const tildeResult = resolveGlobInput('~/.aerospace*', undefined, workspace)
  assert.equal(tildeResult.searchPath, home)
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
            grep: {
              preferred: 'rg',
              backends: {
                rg: { executable: '/usr/bin/rg' }
              }
            },
            fileDiscovery: {
              preferred: 'fd',
              backends: {
                fd: { executable: '/usr/bin/fd' }
              }
            }
          },
          grep: async () => {
            throw new Error('grep should not be called')
          },
          glob: async () => ({
            backend: 'fd',
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

test('runWebReadTool saves extracted content to a workspace file when filename is provided', async () => {
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
      {
        url: 'https://example.com/article',
        filename: 'captures/example.md'
      },
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

    const savedPath = join(workspacePath, 'captures/example.md')

    assert.equal(result.error, undefined)
    assert.equal(result.details.savedFilePath, savedPath)
    assert.equal(result.details.savedBytes, Buffer.byteLength(longContent, 'utf8'))
    assert.equal(result.details.content, '')
    assert.equal(result.details.truncated, false)
    assert.equal(result.details.contentChars, longContent.length)
    assert.equal(await readFile(savedPath, 'utf8'), longContent)
    assert.equal(summarizeToolOutput('webRead', result), 'saved to captures/example.md')
    assert.match(flattenToolContent(result.content), /Saved readable content to/)
    assert.doesNotMatch(flattenToolContent(result.content), /Second paragraph\./)
  })
})

test('runWebReadTool rejects filenames outside the workspace', async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await runWebReadTool(
      {
        url: 'https://example.com/article',
        filename: '../escape.md'
      },
      { workspacePath },
      {
        fetchImpl: async () => {
          throw new Error('fetch should not be called')
        }
      }
    )

    assert.equal(result.error, 'filename must stay within the current workspace.')
    assert.equal(result.details.failureCode, 'invalid-filename')
    assert.equal(result.details.savedFilePath, undefined)
    assert.equal(result.details.content, '')
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
