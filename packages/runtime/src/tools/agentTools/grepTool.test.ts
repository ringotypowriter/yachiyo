import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGrepTool } from './grepTool.ts'
import { runGlobTool } from './globTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'
import { createSearchService } from '../../services/search/searchService.ts'
import type { GrepToolInput } from './shared.ts'
import { DEFAULT_SEARCH_LIMIT } from './shared.ts'

function grepInput(partial: Partial<GrepToolInput> & { pattern: string }): GrepToolInput {
  return {
    limit: DEFAULT_SEARCH_LIMIT,
    literal: false,
    caseSensitive: true,
    context: 0,
    filesOnly: false,
    ...partial
  }
}

describe('grepTool', () => {
  async function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'grep-tool-test-'))
  }

  it('records a file read when matched content is shown', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'one\ntwo\nthree\nfour\nfive\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      grepInput({ pattern: 'three', path: workspace, context: 1 }),
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.hasRecentRead(filePath), true)
  })

  it('does not record reads for filesOnly mode', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      grepInput({ pattern: 'hello', path: workspace, filesOnly: true }),
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.hasRecentRead(filePath), false)
  })

  it('records reads spanning multiple files', async () => {
    const workspace = await makeWorkspace()
    const fileA = join(workspace, 'a.txt')
    const fileB = join(workspace, 'b.txt')
    await writeFile(fileA, 'alpha\nbeta\n', 'utf8')
    await writeFile(fileB, 'gamma\ndelta\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      grepInput({ pattern: 'alpha|delta', path: workspace }),
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.hasRecentRead(fileA), true)
    assert.strictEqual(cache.hasRecentRead(fileB), true)
  })

  it('records one file read across multiple matches in the same file', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      grepInput({ pattern: 'two|six', path: workspace, context: 1 }),
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.hasRecentRead(filePath), true)
  })

  it('searches space-separated path lists', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'src', 'main'), { recursive: true })
    await mkdir(join(workspace, 'src', 'shared'), { recursive: true })
    await mkdir(join(workspace, 'src', 'renderer', 'src', 'app'), { recursive: true })
    await writeFile(join(workspace, 'src', 'main', 'main.ts'), 'needle main\n', 'utf8')
    await writeFile(join(workspace, 'src', 'shared', 'shared.ts'), 'needle shared\n', 'utf8')
    await writeFile(
      join(workspace, 'src', 'renderer', 'src', 'app', 'app.ts'),
      'needle app\n',
      'utf8'
    )

    const searchService = createSearchService()
    const result = await runGrepTool(
      grepInput({ pattern: 'needle', path: 'src/main src/shared src/renderer/src/app' }),
      { workspacePath: workspace },
      { searchService }
    )

    assert.deepStrictEqual(result.details.matches.map((match) => match.path).sort(), [
      'src/main/main.ts',
      'src/renderer/src/app/app.ts',
      'src/shared/shared.ts'
    ])
  })

  it('keeps an existing path containing spaces as one search root', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'space dir'), { recursive: true })
    await writeFile(join(workspace, 'space dir', 'file.ts'), 'needle in spaced path\n', 'utf8')

    const searchService = createSearchService()
    const result = await runGrepTool(
      grepInput({ pattern: 'needle', path: 'space dir' }),
      { workspacePath: workspace },
      { searchService }
    )

    assert.deepStrictEqual(
      result.details.matches.map((match) => match.path),
      ['space dir/file.ts']
    )
  })

  it('finds files across space-separated glob path lists', async () => {
    const workspace = await makeWorkspace()
    await mkdir(join(workspace, 'src', 'main'), { recursive: true })
    await mkdir(join(workspace, 'src', 'shared'), { recursive: true })
    await writeFile(join(workspace, 'src', 'main', 'main.ts'), '', 'utf8')
    await writeFile(join(workspace, 'src', 'shared', 'shared.ts'), '', 'utf8')

    const searchService = createSearchService()
    const result = await runGlobTool(
      { pattern: '**/*.ts', path: 'src/main src/shared', limit: DEFAULT_SEARCH_LIMIT },
      { workspacePath: workspace },
      { searchService }
    )

    assert.deepStrictEqual(result.details.matches.sort(), [
      'src/main/main.ts',
      'src/shared/shared.ts'
    ])
  })
})
