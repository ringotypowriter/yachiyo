import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEditTool } from './editTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'

describe('editTool', () => {
  async function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'edit-tool-test-'))
  }

  it('replaces a single occurrence without replace_all', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world\nhello universe', 'utf8')

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'world', newText: 'there' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello there\nhello universe')
  })

  it('fails on multiple occurrences without replace_all', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello hello hello', 'utf8')

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace }
    )

    assert.ok(result.error)
    assert.strictEqual(result.details.replacements, 0)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello hello hello')
  })

  it('replaces all occurrences when replace_all is true', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello hello hello', 'utf8')

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 3)
    assert.strictEqual(result.details.firstChangedLine, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi hi hi')
  })

  it('returns error when oldText is not found', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'missing', newText: 'found', replace_all: true },
      { workspacePath: workspace }
    )

    assert.ok(result.error)
    assert.strictEqual(result.details.replacements, 0)
  })

  it('rejects edit when file was not read first (read-before-edit guard)', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /read the file/)
    assert.strictEqual(result.details.replacements, 0)
    // File must remain unchanged
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello world')
  })

  it('allows edit after the target region was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 1) // read line 1

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi world')
  })

  it('rejects edit when only a different region was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    // 5 lines: target text is on line 5
    await writeFile(filePath, 'a\nb\nc\nd\ntarget text', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 3) // only read lines 1-3

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'target text', newText: 'replaced' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /line 5/)
    assert.match(result.error, /did not cover/)
    assert.strictEqual(result.details.replacements, 0)
    // File must remain unchanged
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb\nc\nd\ntarget text')
  })

  it('allows edit after multiple reads that together cover the target line', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ntarget text', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 3)
    cache.recordRead(join(workspace, 'file.txt'), 4, 6) // now lines 1-6 covered

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'target text', newText: 'replaced' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
  })

  it('rejects multiline edit when only the start line was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    // oldText "b\nc" spans lines 2–3
    await writeFile(filePath, 'a\nb\nc\nd', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 2) // only read lines 1-2; line 3 not covered

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'b\nc', newText: 'X' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /line/)
    assert.match(result.error, /did not cover/)
    assert.strictEqual(result.details.replacements, 0)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb\nc\nd')
  })

  it('allows multiline edit when all spanned lines were read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 4) // all lines read

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'b\nc', newText: 'X' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nX\nd')
  })

  it('rejects replace_all when some match lines were not read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    // "hello" appears on lines 1, 3, and 5
    await writeFile(filePath, 'hello\nworld\nhello\nworld\nhello', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 2) // only read lines 1-2

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /did not cover/)
    assert.strictEqual(result.details.replacements, 0)
    // File must remain unchanged
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello\nworld\nhello\nworld\nhello')
  })

  it('allows replace_all when all match lines were read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello\nworld\nhello\nworld\nhello', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 5) // read all 5 lines

    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 3)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi\nworld\nhi\nworld\nhi')
  })

  it('bypasses guard when no readRecordCache is provided', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    // No cache = no guard (backwards compatible)
    const result = await runEditTool(
      { path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
  })
})
