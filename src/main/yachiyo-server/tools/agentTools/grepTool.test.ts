import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runGrepTool } from './grepTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'
import { createSearchService } from '../../services/search/searchService.ts'

describe('grepTool', () => {
  async function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'grep-tool-test-'))
  }

  it('records read ranges for matched lines including context', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'one\ntwo\nthree\nfour\nfive\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      { pattern: 'three', path: workspace, context: 1 },
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.coversLine(filePath, 2), true, 'context before should be covered')
    assert.strictEqual(cache.coversLine(filePath, 3), true, 'match line should be covered')
    assert.strictEqual(cache.coversLine(filePath, 4), true, 'context after should be covered')
    assert.strictEqual(cache.coversLine(filePath, 1), false, 'line 1 should not be covered')
    assert.strictEqual(cache.coversLine(filePath, 5), false, 'line 5 should not be covered')
  })

  it('does not record reads for filesOnly mode', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      { pattern: 'hello', path: workspace, filesOnly: true },
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
      { pattern: 'alpha|delta', path: workspace },
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.coversLine(fileA, 1), true)
    assert.strictEqual(cache.coversLine(fileB, 2), true)
  })

  it('preserves disjoint line ranges per file across multiple matches', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      { pattern: 'two|six', path: workspace, context: 1 },
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    assert.strictEqual(cache.coversLine(filePath, 1), true, 'context around line 2 covers line 1')
    assert.strictEqual(cache.coversLine(filePath, 3), true, 'context around line 2 covers line 3')
    assert.strictEqual(cache.coversLine(filePath, 5), true, 'context around line 6 covers line 5')
    assert.strictEqual(cache.coversLine(filePath, 7), true, 'context around line 6 covers line 7')
    // Line 4 lies in the gap between the two match contexts and must NOT be covered
    assert.strictEqual(cache.coversLine(filePath, 4), false, 'gap line 4 must not be covered')
  })
})
