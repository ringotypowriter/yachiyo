import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGrepTool } from './grepTool.ts'
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
})
