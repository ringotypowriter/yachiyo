import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEditTool } from './editTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'
import { editToolInputSchema } from './shared.ts'

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'edit-tool-test-'))
}

describe('editTool', () => {
  describe('batched edits', () => {
    it('applies multiple edits in order within a single call', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'alpha', newText: 'A', replace_all: false },
            { oldText: 'gamma', newText: 'G', replace_all: false }
          ]
        },
        { workspacePath: workspace }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.mode, 'batch')
      assert.strictEqual(result.details.replacements, 2)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'A\nbeta\nG\n')
    })

    it('uses multiline text inside batched edits', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'alpha\nbeta', newText: 'A\nB', replace_all: false },
            { oldText: 'gamma', newText: 'G', replace_all: false }
          ]
        },
        { workspacePath: workspace }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.replacements, 2)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'A\nB\nG\n')
    })

    it('uses batched multiline replacement text', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'line 1: alpha\nline 2: beta\nline 3: gamma\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            {
              oldText: 'line 2: beta',
              newText: 'line 2: beta edited\nline 2.5: inserted',
              replace_all: false
            }
          ]
        },
        { workspacePath: workspace }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.replacements, 1)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(
        content,
        'line 1: alpha\nline 2: beta edited\nline 2.5: inserted\nline 3: gamma\n'
      )
    })

    it('aborts the batch and writes nothing when one edit fails', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'alpha', newText: 'A', replace_all: false },
            { oldText: 'does-not-exist', newText: 'X', replace_all: false }
          ]
        },
        { workspacePath: workspace }
      )

      assert.ok(result.error)
      assert.match(result.error, /Edit 2/)
      assert.strictEqual(result.details.replacements, 0)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'alpha\nbeta\n', 'file must remain unchanged on batch abort')
    })

    it('rejects a batched edit that matches multiple locations without replace_all', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'x\nx\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [{ oldText: 'x', newText: 'y', replace_all: false }]
        },
        { workspacePath: workspace }
      )
      assert.ok(result.error)
      assert.match(result.error, /multiple locations/)
      assert.strictEqual(result.details.replacements, 0)
    })

    it('lets a later edit consume content produced by an earlier edit', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'foo\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'foo', newText: 'bar', replace_all: false },
            { oldText: 'bar', newText: 'baz', replace_all: false }
          ]
        },
        { workspacePath: workspace }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.replacements, 2)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'baz\n')
    })

    it('preserves synthesized literal backslash-n matches during batch edits', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'seed\nsafe\noutside\nalpha\nbeta\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 1)

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'seed', newText: 'alpha\\nbeta', replace_all: false },
            { oldText: 'alpha\\nbeta', newText: 'literal replaced', replace_all: false }
          ]
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.replacements, 2)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'literal replaced\nsafe\noutside\nalpha\nbeta\n')
    })

    it('rejects the batch when edits collectively no-op (safety net)', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'foo\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'foo', newText: 'bar', replace_all: false },
            { oldText: 'bar', newText: 'foo', replace_all: false }
          ]
        },
        { workspacePath: workspace }
      )

      assert.ok(result.error)
      assert.match(result.error, /No net changes/)
      assert.strictEqual(result.details.replacements, 0)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'foo\n', 'file must remain unchanged when batch is a no-op')
    })

    it('allows batch of pure deletions without any prior read', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

      const cache = new ReadRecordCache()
      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'alpha\n', newText: '', replace_all: false },
            { oldText: 'gamma\n', newText: '', replace_all: false }
          ]
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.replacements, 2)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'beta\n')
    })

    it('enforces guard for non-deletion edits in a mixed batch', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

      const cache = new ReadRecordCache()
      // No read recorded — should fail because one edit is a non-deletion
      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'alpha\n', newText: '', replace_all: false },
            { oldText: 'gamma', newText: 'GAMMA', replace_all: false }
          ]
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.ok(result.error)
      assert.match(result.error, /read the file/)
      assert.strictEqual(result.details.replacements, 0)
    })
  })

  describe('input schema validation', () => {
    it('requires mode for inline edits', () => {
      const parsed = editToolInputSchema.safeParse({
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi'
      })
      assert.strictEqual(parsed.success, false)
    })

    it('requires mode for ranged edits', () => {
      const parsed = editToolInputSchema.safeParse({
        path: 'file.txt',
        replaceLines: { start: 1, end: 1 },
        newText: 'hi'
      })
      assert.strictEqual(parsed.success, false)
    })

    it('requires mode for batched edits', () => {
      const parsed = editToolInputSchema.safeParse({
        path: 'file.txt',
        edits: [{ oldText: 'x', newText: 'y' }]
      })
      assert.strictEqual(parsed.success, false)
    })

    it('accepts empty placeholders from other modes for inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        replaceLines: null,
        edits: []
      })
      assert.strictEqual(parsed.success, true)
    })

    it('rejects line arrays for inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldLines: ['hello', 'world'],
        newLines: ['hi', 'there']
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects newLines placeholders when newText is provided', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        newLines: []
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects newLines without replacement text', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newLines: []
      })
      assert.strictEqual(parsed.success, false)
    })

    it('accepts empty newText as an empty replacement', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: ''
      })
      assert.strictEqual(parsed.success, true)
    })

    it('rejects line-array fields even when text fields are present in inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello\nworld',
        oldLines: ['hello', 'world'],
        newText: 'hi\nthere',
        newLines: ['hi', 'there']
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects newLines as the replacement source', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newLines: ['hi']
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects newLines for range mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'range',
        path: 'file.txt',
        replaceLines: { start: 1, end: 2 },
        newLines: ['hi', 'there']
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects line arrays inside batch edits', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'batch',
        path: 'file.txt',
        edits: [{ oldLines: ['x', 'y'], newLines: ['z'] }]
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects line-array fields even when text fields are present inside batch edits', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'batch',
        path: 'file.txt',
        edits: [
          {
            oldText: 'x\ny',
            oldLines: ['x', 'y'],
            newText: 'z',
            newLines: ['z']
          }
        ]
      })
      assert.strictEqual(parsed.success, false)
    })

    it('accepts empty placeholders from other modes for range mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'range',
        path: 'file.txt',
        oldText: '',
        newText: 'hi',
        replace_all: false,
        replaceLines: { start: 1, end: 1 },
        edits: []
      })
      assert.strictEqual(parsed.success, true)
    })

    it('rejects oldLines in inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        oldLines: ['goodbye'],
        newText: 'hi'
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects newLines in inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        newLines: ['bye']
      })
      assert.strictEqual(parsed.success, false)
    })

    it('accepts empty placeholders from other modes for batch mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'batch',
        path: 'file.txt',
        oldText: '',
        newText: '',
        replace_all: false,
        replaceLines: null,
        edits: [{ oldText: 'x', newText: 'y' }]
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts stray inline and range fields for batch mode when edits are present', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'batch',
        path: 'file.txt',
        oldText: 'stale inline field',
        newText: 'stale top-level replacement',
        replace_all: true,
        replaceLines: { start: 1, end: 1 },
        edits: [{ oldText: 'x', newText: 'y' }]
      })
      assert.strictEqual(parsed.success, true)
    })

    it('rejects non-empty ranged fields for inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        replaceLines: { start: 1, end: 1 }
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects non-empty batched fields for inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        edits: [{ oldText: 'x', newText: 'y' }]
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects non-empty batched fields for range mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'range',
        path: 'file.txt',
        replaceLines: { start: 1, end: 1 },
        newText: 'hi',
        edits: [{ oldText: 'x', newText: 'y' }]
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects batch mode when edits are missing even if stray inline fields are present', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'batch',
        path: 'file.txt',
        oldText: 'hello',
        newText: '',
        replaceLines: { start: 1, end: 1 }
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects unknown top-level fields', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        bogus: true
      })
      assert.strictEqual(parsed.success, false)
    })

    it('accepts each of the three valid shapes on its own', () => {
      assert.strictEqual(
        editToolInputSchema.safeParse({
          mode: 'inline',
          path: 'a',
          oldText: 'x',
          newText: 'y'
        }).success,
        true
      )
      assert.strictEqual(
        editToolInputSchema.safeParse({
          mode: 'range',
          path: 'a',
          replaceLines: { start: 1, end: 2 },
          newText: 'y'
        }).success,
        true
      )
      assert.strictEqual(
        editToolInputSchema.safeParse({
          mode: 'batch',
          path: 'a',
          edits: [{ oldText: 'x', newText: 'y' }]
        }).success,
        true
      )
    })
  })
})
