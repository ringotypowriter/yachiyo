import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEditTool } from './editTool.ts'

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
})
