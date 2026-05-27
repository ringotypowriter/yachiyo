import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWriteTool } from './writeTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'

describe('writeTool', () => {
  async function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'write-tool-test-'))
  }

  it('creates a new file without requiring a prior read', async () => {
    const workspace = await makeWorkspace()
    const cache = new ReadRecordCache()
    const result = await runWriteTool(
      { path: 'new.txt', content: 'hello' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.created, true)
    const content = await readFile(join(workspace, 'new.txt'), 'utf8')
    assert.strictEqual(content, 'hello')
  })

  it('rejects overwrite when file was not read first', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'existing.txt')
    await writeFile(filePath, 'original', 'utf8')

    const cache = new ReadRecordCache()
    const result = await runWriteTool(
      { path: 'existing.txt', content: 'overwritten' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /read the file/)
    // File must remain unchanged
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'original')
  })

  it('allows overwrite after file was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'existing.txt')
    await writeFile(filePath, 'original', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 1)

    const result = await runWriteTool(
      { path: 'existing.txt', content: 'overwritten' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.overwritten, true)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'overwritten')
  })

  it('allows overwrite of an empty file after reading it', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'empty.txt')
    await writeFile(filePath, '', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordEmptyFileRead(filePath) // simulate readTool seeing an empty file

    const result = await runWriteTool(
      { path: 'empty.txt', content: 'now has content' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.overwritten, true)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'now has content')
  })

  it('rejects overwrite after an empty past-EOF read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'existing.txt')
    await writeFile(filePath, 'original', 'utf8')

    const cache = new ReadRecordCache()
    // Simulate reading past EOF: startLine > endLine → empty range
    cache.recordRead(filePath, 999, 998)

    const result = await runWriteTool(
      { path: 'existing.txt', content: 'overwritten' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /read the file/)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'original')
  })

  it('allows consecutive writes to the same file without intermediate read', async () => {
    const workspace = await makeWorkspace()
    const cache = new ReadRecordCache()

    const first = await runWriteTool(
      { path: 'file.txt', content: 'first version' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(first.error, undefined)
    assert.strictEqual(first.details.created, true)

    const second = await runWriteTool(
      { path: 'file.txt', content: 'second version' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(second.error, undefined)
    assert.strictEqual(second.details.overwritten, true)
    const content = await readFile(join(workspace, 'file.txt'), 'utf8')
    assert.strictEqual(content, 'second version')
  })

  it('bypasses guard when no readRecordCache is provided', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'existing.txt')
    await writeFile(filePath, 'original', 'utf8')

    const result = await runWriteTool(
      { path: 'existing.txt', content: 'overwritten' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.overwritten, true)
  })
  it('redirects Plan Mode fallback paths to the restricted plan document', async () => {
    const workspace = await makeWorkspace()
    const planPath = join(workspace, '.yachiyo', 'plan-thread-1.md')
    const mistakenHomePath = join(tmpdir(), '.yachiyo', 'plan-thread-1.md')

    const result = await runWriteTool(
      { path: mistakenHomePath, content: '# Execution Plan' },
      {
        workspacePath: workspace,
        writeRestriction: {
          absolutePath: planPath,
          relativePath: '.yachiyo/plan-thread-1.md',
          fallbackAbsolutePaths: [mistakenHomePath],
          skipReadBeforeOverwrite: true
        }
      }
    )

    assert.strictEqual(result.error, undefined)
    const resultText = result.content[0]?.type === 'text' ? result.content[0].text : ''
    assert.match(resultText, /Plan Mode is still active/)
    assert.match(resultText, /exitPlanMode/)
    assert.match(resultText, /user approval/)
    assert.strictEqual(await readFile(planPath, 'utf8'), '# Execution Plan')
  })
})
