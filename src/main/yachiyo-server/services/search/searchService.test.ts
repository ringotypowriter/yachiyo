import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createSearchService, type SearchCommandResult } from './searchService.ts'

async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-search-service-'))

  try {
    await fn(workspacePath)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

// ── rg backend ──────────────────────────────────────────────────────────────

test('rg backend parses JSON match output', async () => {
  const service = createSearchService({
    rgPath: '/usr/bin/rg',
    runCommand: async () => ({
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
        JSON.stringify({ type: 'end', data: { path: { text: '/repo/src/alpha.ts' } } })
      ].join('\n'),
      stderr: ''
    })
  })

  const result = await service.grep({ cwd: '/repo', pattern: 'needle', path: '.' })

  assert.equal(result.backend, 'rg')
  assert.deepEqual(result.matches, [{ path: 'src/alpha.ts', line: 3, text: 'needle one' }])
  assert.equal(result.truncated, false)
})

test('rg backend passes include and context flags', async () => {
  const calls: Array<{ args: string[] }> = []
  const service = createSearchService({
    rgPath: '/usr/bin/rg',
    runCommand: async ({ args }) => {
      calls.push({ args })
      return { exitCode: 1, stdout: '', stderr: '' }
    }
  })

  await service.grep({
    cwd: '/repo',
    pattern: 'needle',
    path: '.',
    include: '*.ts',
    context: 3
  })

  const argsStr = calls[0]?.args.join(' ') ?? ''
  assert.ok(argsStr.includes('--glob *.ts'), `Expected --glob in rg args but got: ${argsStr}`)
  assert.ok(argsStr.includes('--context 3'), `Expected --context in rg args but got: ${argsStr}`)
})

test('rg backend passes --hidden flag', async () => {
  const calls: Array<{ args: string[] }> = []
  const service = createSearchService({
    rgPath: '/usr/bin/rg',
    runCommand: async ({ args }) => {
      calls.push({ args })
      return { exitCode: 1, stdout: '', stderr: '' }
    }
  })

  await service.grep({ cwd: '/repo', pattern: 'needle', path: '.' })

  assert.ok(
    calls[0]?.args.includes('--hidden'),
    `Expected --hidden in rg args but got: ${calls[0]?.args.join(' ')}`
  )
})

test('rg backend parses context events from JSON output', async () => {
  const service = createSearchService({
    rgPath: '/usr/bin/rg',
    runCommand: async () => ({
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: 'begin', data: { path: { text: '/repo/src/app.ts' } } }),
        JSON.stringify({
          type: 'context',
          data: { path: { text: '/repo/src/app.ts' }, line_number: 2, lines: { text: 'before\n' } }
        }),
        JSON.stringify({
          type: 'match',
          data: {
            path: { text: '/repo/src/app.ts' },
            line_number: 3,
            lines: { text: 'needle here\n' }
          }
        }),
        JSON.stringify({
          type: 'context',
          data: { path: { text: '/repo/src/app.ts' }, line_number: 4, lines: { text: 'after\n' } }
        }),
        JSON.stringify({ type: 'end', data: { path: { text: '/repo/src/app.ts' } } })
      ].join('\n'),
      stderr: ''
    })
  })

  const result = await service.grep({ cwd: '/repo', pattern: 'needle', path: '.', context: 1 })

  assert.equal(result.matches.length, 1)
  const match = result.matches[0]!
  assert.equal(match.text, 'needle here')
  assert.deepEqual(match.contextBefore, ['before'])
  assert.deepEqual(match.contextAfter, ['after'])
})

test('rg backend does not mask bad regex errors', async () => {
  const service = createSearchService({
    rgPath: '/usr/bin/rg',
    runCommand: async (): Promise<SearchCommandResult> => ({
      exitCode: 2,
      stdout: '',
      stderr: 'regex parse error:\nmissing )'
    })
  })

  await assert.rejects(
    service.grep({ cwd: '/repo', pattern: '(', path: '.' }),
    /regex parse error/i
  )
})

test('rg backend falls back to typescript when ENOENT', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'file.ts'), 'needle\n', 'utf8')

    const service = createSearchService({
      rgPath: '/nonexistent/rg',
      runCommand: async () => {
        const error = new Error('spawn ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
    })

    const result = await service.grep({ cwd: workspacePath, pattern: 'needle', path: '.' })
    assert.equal(result.backend, 'typescript')
    assert.equal(result.matches.length, 1)
  })
})

// ── bfs backend ─────────────────────────────────────────────────────────────

test('bfs backend parses file discovery output', async () => {
  const service = createSearchService({
    bfsPath: '/usr/bin/bfs',
    runCommand: async () => ({
      exitCode: 0,
      stdout: './src/main.ts\n./src/search/tool.ts\n',
      stderr: ''
    })
  })

  const result = await service.glob({ cwd: '/repo', pattern: 'src/**/*.ts', path: '.' })

  assert.equal(result.backend, 'bfs')
  assert.deepEqual(result.paths, ['src/main.ts', 'src/search/tool.ts'])
})

test('bfs backend handles file path as rootPath', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, '.aerospace.toml'), '[gaps]\n', 'utf8')

    const service = createSearchService({
      bfsPath: '/usr/bin/bfs',
      runCommand: async () => {
        throw new Error('bfs should not be called when rootPath is a file')
      }
    })

    const result = await service.glob({
      cwd: workspacePath,
      pattern: '.aerospace.toml',
      path: join(workspacePath, '.aerospace.toml')
    })

    assert.equal(result.backend, 'bfs')
    assert.deepEqual(result.paths, ['.aerospace.toml'])
  })
})

test('bfs backend treats early termination as truncated', async () => {
  const service = createSearchService({
    bfsPath: '/usr/bin/bfs',
    runCommand: async () => ({
      exitCode: 143,
      stdout: './src/alpha.ts\n',
      stderr: '',
      terminatedEarly: true
    })
  })

  const result = await service.glob({ cwd: '/repo', pattern: 'src/**/*.ts', path: '.', limit: 1 })

  assert.equal(result.backend, 'bfs')
  assert.equal(result.truncated, true)
  assert.deepEqual(result.paths, ['src/alpha.ts'])
})

test('bfs backend falls back to typescript when ENOENT', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'file.ts'), '', 'utf8')

    const service = createSearchService({
      bfsPath: '/nonexistent/bfs',
      runCommand: async () => {
        const error = new Error('spawn ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
    })

    const result = await service.glob({ cwd: workspacePath, pattern: '*.ts', path: '.' })
    assert.equal(result.backend, 'typescript')
    assert.deepEqual(result.paths, ['file.ts'])
  })
})

// ── TypeScript fallback ─────────────────────────────────────────────────────

test('typescript grep supports bounded search', async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'alpha.ts'), 'first line\nneedle here\n', 'utf8')
    await writeFile(join(workspacePath, 'src', 'beta.ts'), 'needle again\n', 'utf8')
    await writeFile(join(workspacePath, 'notes.md'), 'not a match\n', 'utf8')

    const service = createSearchService({})

    const result = await service.grep({
      cwd: workspacePath,
      pattern: 'needle',
      path: 'src',
      limit: 1
    })

    assert.equal(result.backend, 'typescript')
    assert.equal(result.truncated, true)
    assert.deepEqual(result.matches, [{ path: 'alpha.ts', line: 2, text: 'needle here' }])
  })
})

test('typescript glob supports globstar pattern', async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'alpha.ts'), '', 'utf8')
    await writeFile(join(workspacePath, 'src', 'beta.ts'), '', 'utf8')
    await writeFile(join(workspacePath, 'notes.md'), '', 'utf8')

    const service = createSearchService({})

    const result = await service.glob({
      cwd: workspacePath,
      pattern: 'src/**/*.ts',
      path: '.'
    })

    assert.equal(result.backend, 'typescript')
    assert.deepEqual(result.paths, ['src/alpha.ts', 'src/beta.ts'])
  })
})

test('typescript grep supports include filter', async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(join(workspacePath, 'src', 'app.ts'), 'needle in ts\n', 'utf8')
    await writeFile(join(workspacePath, 'src', 'style.css'), 'needle in css\n', 'utf8')
    await writeFile(join(workspacePath, 'src', 'readme.md'), 'needle in md\n', 'utf8')

    const service = createSearchService({})

    const result = await service.grep({
      cwd: workspacePath,
      pattern: 'needle',
      path: 'src',
      include: '*.ts'
    })

    assert.equal(result.backend, 'typescript')
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0]?.path, 'app.ts')
  })
})

test('typescript grep supports context lines', async () => {
  await withWorkspace(async (workspacePath) => {
    await writeFile(join(workspacePath, 'code.ts'), 'line1\nline2\nneedle\nline4\nline5\n', 'utf8')

    const service = createSearchService({})

    const result = await service.grep({
      cwd: workspacePath,
      pattern: 'needle',
      path: 'code.ts',
      context: 2
    })

    assert.equal(result.matches.length, 1)
    const match = result.matches[0]!
    assert.equal(match.line, 3)
    assert.equal(match.text, 'needle')
    assert.deepEqual(match.contextBefore, ['line1', 'line2'])
    assert.deepEqual(match.contextAfter, ['line4', 'line5'])
  })
})

test('typescript grep includes hidden files', async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, '.config'), { recursive: true })
    await writeFile(join(workspacePath, '.env'), 'needle=secret\n', 'utf8')
    await writeFile(join(workspacePath, '.config', 'settings.ts'), 'needle config\n', 'utf8')
    await writeFile(join(workspacePath, 'visible.ts'), 'not a match\n', 'utf8')

    const service = createSearchService({})

    const result = await service.grep({ cwd: workspacePath, pattern: 'needle', path: '.' })

    assert.equal(result.backend, 'typescript')
    const paths = result.matches.map((m) => m.path).sort()
    assert.deepEqual(paths, ['.config/settings.ts', '.env'])
  })
})

test('typescript glob includes hidden files', async () => {
  await withWorkspace(async (workspacePath) => {
    await mkdir(join(workspacePath, '.config'), { recursive: true })
    await writeFile(join(workspacePath, '.env'), '', 'utf8')
    await writeFile(join(workspacePath, '.config', 'settings.ts'), '', 'utf8')
    await writeFile(join(workspacePath, 'visible.ts'), '', 'utf8')

    const service = createSearchService({})

    const result = await service.glob({ cwd: workspacePath, pattern: '**/*.ts', path: '.' })

    assert.equal(result.backend, 'typescript')
    const paths = result.paths.sort()
    assert.deepEqual(paths, ['.config/settings.ts', 'visible.ts'])
  })
})

// ── Capabilities reporting ──────────────────────────────────────────────────

test('capabilities reports rg when rgPath is provided', () => {
  const service = createSearchService({ rgPath: '/usr/bin/rg' })
  assert.equal(service.capabilities.grep.available, 'rg')
})

test('capabilities reports typescript when no binary paths are provided', () => {
  const service = createSearchService({})
  assert.equal(service.capabilities.grep.available, 'typescript')
  assert.equal(service.capabilities.fileDiscovery.available, 'typescript')
})

test('capabilities reports bfs when bfsPath is provided', () => {
  const service = createSearchService({ bfsPath: '/usr/bin/bfs' })
  assert.equal(service.capabilities.fileDiscovery.available, 'bfs')
})
