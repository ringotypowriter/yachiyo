import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runEditTool } from './editTool.ts'
import { runGrepTool } from './grepTool.ts'
import { runBashTool } from './bashTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'
import { createSearchService } from '../../services/search/searchService.ts'
import { DEFAULT_SEARCH_LIMIT } from './shared.ts'
import type { GrepToolInput } from './shared.ts'

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

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'edit-tool-test-'))
}

describe('editTool', () => {
  it('replaces a single occurrence without replace_all', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world\nhello universe', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'world', newText: 'there' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.mode, 'inline')
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello there\nhello universe')
  })

  it('fails on multiple occurrences without replace_all', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello hello hello', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi' },
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
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
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
      { mode: 'inline', path: 'file.txt', oldText: 'missing', newText: 'found', replace_all: true },
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
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /read the file/)
    assert.strictEqual(result.details.replacements, 0)
    // File must remain unchanged
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello world')
  })

  it('allows edit after the file was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 1)

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi world')
  })

  it('rejects edit when the file changed after the read record', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 1, 1)

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /read the file/)
    assert.strictEqual(result.details.replacements, 0)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hello world')
  })

  it('allows deletion (empty newText) without any prior read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world\nkeep this', 'utf8')

    const cache = new ReadRecordCache()
    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello world\n', newText: '' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'keep this')
  })

  it('recovers from an over-escaped multiline inline search when the literal search misses', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha\\nbeta', newText: 'ALPHA\nBETA' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'ALPHA\nBETA\ngamma\n')
  })

  it('does not unwrap a literal backslash-n replacement during search recovery', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha\\nbeta', newText: 'ALPHA\\nBETA' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'ALPHA\\nBETA\ngamma\n')
  })

  it('prefers a literal backslash-n inline match when the file contains one', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'literal alpha\\nbeta\nactual alpha\nbeta\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha\\nbeta', newText: 'escaped' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'literal escaped\nactual alpha\nbeta\n')
  })

  it('uses oldText and newText for multiline inline edits', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await runEditTool(
      {
        mode: 'inline',
        path: 'file.txt',
        oldText: 'alpha\nbeta',
        newText: 'ALPHA\nBETA'
      },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'ALPHA\nBETA\ngamma\n')
  })

  it('rejects an empty search text', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    await assert.rejects(
      () =>
        runEditTool(
          { mode: 'inline', path: 'file.txt', oldText: '', newText: 'ALPHA' },
          { workspacePath: workspace }
        ),
      /requires a non-empty oldText/
    )

    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'alpha\nbeta\n')
  })

  it('uses an empty newText for inline deletion', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha\n', newText: '' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'beta\n')
  })

  it('allows multiline edit after the file was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 1)

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'b\nc', newText: 'X' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nX\nd')
  })

  it('allows replace_all after the file was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello\nworld\nhello\nworld\nhello', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 1)

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 3)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi\nworld\nhi\nworld\nhi')
  })

  it('allows edit after grep tool showed the file content', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    await runGrepTool(
      grepInput({ pattern: 'c', path: workspace, context: 1 }),
      { workspacePath: workspace, readRecordCache: cache },
      { searchService }
    )

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'c', newText: 'C' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb\nC\nd\ne\n')
  })

  it('bypasses guard when no readRecordCache is provided', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    // No cache = no guard (backwards compatible)
    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
  })

  it('allows edit after a read-only bash command showed the file content', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const cache = new ReadRecordCache()
    await runBashTool(
      { command: "sed -n '3,4p' file.txt", timeout: 30, background: false },
      { workspacePath: workspace, readRecordCache: cache }
    )

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'c', newText: 'C' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb\nC\nd\ne\n')
  })

  it('returns a clean "File not found" brief when the target does not exist', async () => {
    const workspace = await makeWorkspace()
    const result = await runEditTool(
      { mode: 'inline', path: 'missing.txt', oldText: 'a', newText: 'b' },
      { workspacePath: workspace }
    )
    assert.ok(result.error)
    assert.match(result.error, /File not found/)
    assert.doesNotMatch(result.error, /ENOENT/)
    assert.strictEqual(result.details.replacements, 0)
  })

  it('returns a clean error when the path is a directory', async () => {
    const workspace = await makeWorkspace()
    const result = await runEditTool(
      { mode: 'inline', path: '.', oldText: 'a', newText: 'b' },
      { workspacePath: workspace }
    )
    assert.ok(result.error)
    assert.match(result.error, /not a regular file/)
    assert.strictEqual(result.details.replacements, 0)
  })

  it('rejects relative paths that escape the workspace', async () => {
    const workspace = await makeWorkspace()
    const result = await runEditTool(
      { mode: 'inline', path: '../etc/passwd', oldText: 'a', newText: 'b' },
      { workspacePath: workspace }
    )
    assert.ok(result.error)
    assert.match(result.error, /escapes the workspace/)
    assert.strictEqual(result.details.replacements, 0)
  })

  it('rejects a relative symlink that points outside the workspace', async () => {
    // Regression for P2: stat/writeFile follow symlinks, so a purely string-based
    // check can't catch a relative symlink that escapes the workspace.
    const workspace = await makeWorkspace()
    const outside = await makeWorkspace()
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'secret\n', 'utf8')
    const linkPath = join(workspace, 'link.txt')
    await symlink(outsideFile, linkPath)

    const result = await runEditTool(
      { mode: 'inline', path: 'link.txt', oldText: 'secret', newText: 'public' },
      { workspacePath: workspace }
    )

    assert.ok(result.error, 'symlink escape must be rejected')
    assert.match(result.error, /symlink/i)
    // External file must stay untouched
    const content = await readFile(outsideFile, 'utf8')
    assert.strictEqual(content, 'secret\n')
  })

  it('allows a relative symlink that stays within the workspace', async () => {
    const workspace = await makeWorkspace()
    const realFile = join(workspace, 'real.txt')
    await writeFile(realFile, 'hello\n', 'utf8')
    const linkPath = join(workspace, 'link.txt')
    await symlink(realFile, linkPath)

    const result = await runEditTool(
      { mode: 'inline', path: 'link.txt', oldText: 'hello', newText: 'bye' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(realFile, 'utf8')
    assert.strictEqual(content, 'bye\n')
  })

  it('allows absolute paths to edit files outside the workspace', async () => {
    const workspace = await makeWorkspace()
    const outside = await makeWorkspace()
    const filePath = join(outside, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: filePath, oldText: 'hello', newText: 'hi' },
      { workspacePath: workspace }
    )
    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi world')
  })

  describe('ranged edit (replaceLines)', () => {
    it('replaces a contiguous line range with new content', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\ndelta\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 5)

      const result = await runEditTool(
        {
          mode: 'range',
          path: 'file.txt',
          replaceLines: { start: 2, end: 3 },
          newText: 'BETA\nGAMMA'
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.mode, 'range')
      assert.strictEqual(result.details.replacements, 1)
      assert.strictEqual(result.details.firstChangedLine, 2)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'alpha\nBETA\nGAMMA\ndelta\n')
    })

    it('collapses a range to fewer lines', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\nd\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 5)

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 2, end: 3 }, newText: 'X' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'a\nX\nd\n')
    })

    it('expands a range to more lines', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 4)

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 2, end: 2 }, newText: 'X\nY\nZ' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'a\nX\nY\nZ\nc\n')
    })

    it('uses newText for multiline range replacements', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\ndelta\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 5)

      const result = await runEditTool(
        {
          mode: 'range',
          path: 'file.txt',
          replaceLines: { start: 2, end: 3 },
          newText: 'BETA\nGAMMA'
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'alpha\nBETA\nGAMMA\ndelta\n')
    })

    it('is indent-agnostic on the find side (the whole point)', async () => {
      // Inline edit with a wrong-whitespace oldText would fail; ranged edit does not care.
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.py')
      const original = 'def foo():\n\treturn 1\n' // tab indent
      await writeFile(filePath, original, 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 3)

      const result = await runEditTool(
        {
          mode: 'range',
          path: 'file.py',
          replaceLines: { start: 2, end: 2 },
          newText: '    return 2' // space indent — model's "drifted" version
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'def foo():\n    return 2\n')
    })

    it('rejects a range that is past end of file', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\n', 'utf8')

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 10, end: 12 }, newText: 'X' },
        { workspacePath: workspace }
      )
      assert.ok(result.error)
      assert.match(result.error, /past end of file/)
      assert.strictEqual(result.details.replacements, 0)
    })

    it('rejects a range where end < start', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\n', 'utf8')

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 3, end: 1 }, newText: 'X' },
        { workspacePath: workspace }
      )
      assert.ok(result.error)
      assert.match(result.error, /Invalid range/)
      assert.strictEqual(result.details.replacements, 0)
    })

    it('allows ranged deletion (empty newText) without any prior read', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

      const cache = new ReadRecordCache()
      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 2, end: 3 }, newText: '' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'a\n\nd\ne\n')
    })

    it('rejects when no read has been recorded at all', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\n', 'utf8')

      const cache = new ReadRecordCache()
      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 1, end: 2 }, newText: 'X' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.ok(result.error)
      assert.match(result.error, /read the file/)
      assert.strictEqual(result.details.replacements, 0)
    })

    it('preserves the file trailing newline when the phantom last line is the target', async () => {
      // Regression for P3: a file ending with \n splits to ['a', 'b', 'c', ''] — the
      // trailing '' is a valid, readable line the model can legitimately target. Earlier
      // code inserted [] when newText === '', which stripped the trailing newline from
      // the whole file.
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\n', 'utf8')
      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 4)

      // Replacing the phantom line (line 4) with empty should no-op cleanly.
      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 4, end: 4 }, newText: '' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      // Expected: no-op rejection (newText is identical to existing empty line); file on disk unchanged.
      assert.ok(result.error)
      assert.match(result.error, /identical/)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'a\nb\nc\n', 'trailing newline must be preserved')
    })

    it('treats an empty newText as a single empty line, not line deletion', async () => {
      // Replacing line 2 with newText='' should leave an empty line 2 (blank), not delete it.
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\n', 'utf8')
      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 4)

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 2, end: 2 }, newText: '' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'a\n\nc\n', 'line 2 should become an empty line')
    })

    it('preserves CRLF line endings on files that use them', async () => {
      // Regression for P2: a ranged edit on a CRLF file must not silently rewrite
      // every untouched line as LF.
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      const crlfContent = 'alpha\r\nbeta\r\ngamma\r\ndelta\r\n'
      await writeFile(filePath, crlfContent, 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 5)

      const result = await runEditTool(
        {
          mode: 'range',
          path: 'file.txt',
          replaceLines: { start: 2, end: 3 },
          // Model emits LF; tool should normalize to the file's CRLF convention.
          newText: 'BETA\nGAMMA'
        },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.strictEqual(result.error, undefined)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(
        content,
        'alpha\r\nBETA\r\nGAMMA\r\ndelta\r\n',
        'untouched lines and new lines must both use CRLF'
      )
    })

    it('rejects a range replacement that would be a no-op', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 4)

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 2, end: 2 }, newText: 'b' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.ok(result.error)
      assert.match(result.error, /identical/)
      assert.strictEqual(result.details.replacements, 0)
    })
  })
})
