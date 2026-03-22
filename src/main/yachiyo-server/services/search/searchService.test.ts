import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  createSearchService,
  resolveSearchBackendCapabilities,
  type SearchBackendCapabilities,
  type SearchCommandResult
} from './searchService.ts'

async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-search-service-'))

  try {
    await fn(workspacePath)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

test('resolveSearchBackendCapabilities prefers rg/fd when available', () => {
  const capabilities = resolveSearchBackendCapabilities({
    resolveCommand: (command) =>
      ({
        rg: '/opt/homebrew/bin/rg',
        grep: '/usr/bin/grep',
        fd: '/opt/homebrew/bin/fd',
        find: '/usr/bin/find'
      })[command]
  })

  assert.equal(capabilities.grep.preferred, 'rg')
  assert.equal(capabilities.grep.backends.rg?.executable, '/opt/homebrew/bin/rg')
  assert.equal(capabilities.fileDiscovery.preferred, 'fd')
  assert.equal(capabilities.fileDiscovery.backends.fd?.executable, '/opt/homebrew/bin/fd')
})

test('resolveSearchBackendCapabilities falls back to grep/find/typescript in order', () => {
  const grepAndFind = resolveSearchBackendCapabilities({
    resolveCommand: (command) =>
      ({
        grep: '/usr/bin/grep',
        find: '/usr/bin/find'
      })[command]
  })

  assert.equal(grepAndFind.grep.preferred, 'grep')
  assert.equal(grepAndFind.fileDiscovery.preferred, 'find')

  const fallbackOnly = resolveSearchBackendCapabilities({
    resolveCommand: () => undefined
  })

  assert.equal(fallbackOnly.grep.preferred, 'typescript')
  assert.equal(fallbackOnly.fileDiscovery.preferred, 'typescript')
})

test('createSearchService falls back from an unavailable rg backend to grep', async () => {
  await withWorkspace(async (workspacePath) => {
    const calls: Array<{ command: string; args: string[] }> = []
    const service = createSearchService({
      capabilities: {
        grep: {
          preferred: 'rg',
          backends: {
            rg: { executable: '/missing/rg' },
            grep: { executable: '/usr/bin/grep' }
          }
        },
        fileDiscovery: {
          preferred: 'find',
          backends: {
            find: { executable: '/usr/bin/find' }
          }
        }
      },
      runCommand: async ({ command, args }) => {
        calls.push({ command, args })

        if (command === '/missing/rg') {
          const error = new Error('spawn ENOENT') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }

        return {
          exitCode: 0,
          stdout: `${join(workspacePath, 'src', 'example.ts')}:3:hello world\n`,
          stderr: ''
        }
      }
    })

    const result = await service.grep({
      cwd: workspacePath,
      pattern: 'hello',
      path: '.'
    })

    assert.equal(result.backend, 'grep')
    assert.equal(result.matches.length, 1)
    assert.deepEqual(result.matches[0], {
      path: 'src/example.ts',
      line: 3,
      text: 'hello world'
    })
    assert.equal(calls[0]?.command, '/missing/rg')
    assert.equal(calls[1]?.command, '/usr/bin/grep')
  })
})

test('createSearchService does not hide real grep execution failures behind fallback', async () => {
  const service = createSearchService({
    capabilities: {
      grep: {
        preferred: 'rg',
        backends: {
          rg: { executable: '/usr/bin/rg' },
          grep: { executable: '/usr/bin/grep' }
        }
      },
      fileDiscovery: {
        preferred: 'typescript',
        backends: {}
      }
    },
    runCommand: async ({ command }): Promise<SearchCommandResult> => {
      if (command === '/usr/bin/rg') {
        return {
          exitCode: 2,
          stdout: '',
          stderr: 'regex parse error:\nmissing )'
        }
      }

      throw new Error('grep should not be attempted after a real rg failure')
    }
  })

  await assert.rejects(
    service.grep({
      cwd: '/repo',
      pattern: '(',
      path: '.'
    }),
    /regex parse error/i
  )
})

test('createSearchService normalizes fd output for file discovery', async () => {
  const calls: Array<{ args: string[] }> = []
  const service = createSearchService({
    capabilities: {
      grep: {
        preferred: 'typescript',
        backends: {}
      },
      fileDiscovery: {
        preferred: 'fd',
        backends: {
          fd: { executable: '/usr/bin/fd' }
        }
      }
    },
    runCommand: async ({ args }) => {
      calls.push({ args })

      return {
        exitCode: 0,
        stdout: './src/main.ts\n./src/search/tool.ts\n',
        stderr: ''
      }
    }
  })

  const result = await service.glob({
    cwd: '/repo',
    pattern: 'src/**/*.ts',
    path: '.'
  })

  assert.equal(result.backend, 'fd')
  assert.deepEqual(result.paths, ['src/main.ts', 'src/search/tool.ts'])
  assert.doesNotMatch(calls[0]?.args.join(' ') ?? '', /--full-path/)
})

test('createSearchService treats early-terminated find output as truncated instead of failed', async () => {
  const service = createSearchService({
    capabilities: {
      grep: {
        preferred: 'typescript',
        backends: {}
      },
      fileDiscovery: {
        preferred: 'find',
        backends: {
          find: { executable: '/usr/bin/find' }
        }
      }
    },
    runCommand: async () => ({
      exitCode: 143,
      stdout: './src/alpha.ts\n',
      stderr: '',
      terminatedEarly: true
    })
  })

  const result = await service.glob({
    cwd: '/repo',
    pattern: 'src/**/*.ts',
    path: '.',
    limit: 1
  })

  assert.equal(result.backend, 'find')
  assert.equal(result.truncated, true)
  assert.deepEqual(result.paths, ['src/alpha.ts'])
})

test('createSearchService preserves globstar semantics in the find backend by post-filtering results', async () => {
  const service = createSearchService({
    capabilities: {
      grep: {
        preferred: 'typescript',
        backends: {}
      },
      fileDiscovery: {
        preferred: 'find',
        backends: {
          find: { executable: '/usr/bin/find' }
        }
      }
    },
    runCommand: async () => ({
      exitCode: 0,
      stdout: './src/main.ts\n./src/nested/tool.ts\n./src/notes.md\n',
      stderr: ''
    })
  })

  const result = await service.glob({
    cwd: '/repo',
    pattern: 'src/**/*.ts',
    path: '.'
  })

  assert.equal(result.backend, 'find')
  assert.deepEqual(result.paths, ['src/main.ts', 'src/nested/tool.ts'])
})

test('createSearchService does not truncate ripgrep by JSON event count', async () => {
  const calls: Array<{ maxLines?: number }> = []
  const service = createSearchService({
    capabilities: {
      grep: {
        preferred: 'rg',
        backends: {
          rg: { executable: '/usr/bin/rg' }
        }
      },
      fileDiscovery: {
        preferred: 'typescript',
        backends: {}
      }
    },
    runCommand: async ({ maxLines }) => {
      calls.push({ maxLines })

      return {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'begin', data: { path: { text: '/repo/src/alpha.ts' } } }),
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: '/repo/src/alpha.ts' },
              line_number: 3,
              lines: { text: 'needle one\n' }
            }
          }),
          JSON.stringify({ type: 'end', data: { path: { text: '/repo/src/alpha.ts' } } }),
          JSON.stringify({ type: 'begin', data: { path: { text: '/repo/src/beta.ts' } } }),
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: '/repo/src/beta.ts' },
              line_number: 8,
              lines: { text: 'needle two\n' }
            }
          }),
          JSON.stringify({ type: 'end', data: { path: { text: '/repo/src/beta.ts' } } }),
          JSON.stringify({ type: 'summary', data: { elapsed_total: { human: '0.01s' } } })
        ].join('\n'),
        stderr: ''
      }
    }
  })

  const result = await service.grep({
    cwd: '/repo',
    pattern: 'needle',
    path: '.',
    limit: 2
  })

  assert.equal(result.backend, 'rg')
  assert.deepEqual(result.matches, [
    { path: 'src/alpha.ts', line: 3, text: 'needle one' },
    { path: 'src/beta.ts', line: 8, text: 'needle two' }
  ])
  assert.equal(result.truncated, false)
  assert.equal(calls[0]?.maxLines, undefined)
})

test('typescript fallback supports bounded grep and glob behavior', async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'alpha.ts'), 'first line\nneedle here\n', 'utf8')
    await writeFile(join(workspacePath, 'src', 'beta.ts'), 'needle again\n', 'utf8')
    await writeFile(join(workspacePath, '.hidden.ts'), 'needle hidden\n', 'utf8')
    await writeFile(join(workspacePath, 'notes.md'), 'not a match\n', 'utf8')

    const capabilities: SearchBackendCapabilities = {
      grep: {
        preferred: 'typescript',
        backends: {}
      },
      fileDiscovery: {
        preferred: 'typescript',
        backends: {}
      }
    }
    const service = createSearchService({ capabilities })

    const grepResult = await service.grep({
      cwd: workspacePath,
      pattern: 'needle',
      path: '.',
      limit: 1
    })
    const globResult = await service.glob({
      cwd: workspacePath,
      pattern: 'src/**/*.ts',
      path: '.'
    })

    assert.equal(grepResult.backend, 'typescript')
    assert.equal(grepResult.truncated, true)
    assert.deepEqual(grepResult.matches, [
      {
        path: 'src/alpha.ts',
        line: 2,
        text: 'needle here'
      }
    ])

    assert.equal(globResult.backend, 'typescript')
    assert.deepEqual(globResult.paths, ['src/alpha.ts', 'src/beta.ts'])
  })
})
