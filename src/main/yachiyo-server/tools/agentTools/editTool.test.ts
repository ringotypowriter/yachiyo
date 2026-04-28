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
import { editToolInputSchema, DEFAULT_SEARCH_LIMIT } from './shared.ts'
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

describe('editTool', () => {
  async function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'edit-tool-test-'))
  }

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

  it('allows edit after the target region was read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 1) // read line 1

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi' },
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
      { mode: 'inline', path: 'file.txt', oldText: 'target text', newText: 'replaced' },
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

  it('allows deletion even when the target region was not read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ntarget text', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 3) // only read lines 1-3

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'target text', newText: '' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb\nc\nd\n')
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

  it('uses oldLines and newLines for multiline inline edits', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await runEditTool(
      {
        mode: 'inline',
        path: 'file.txt',
        oldLines: ['alpha', 'beta'],
        newLines: ['ALPHA', 'BETA']
      },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'ALPHA\nBETA\ngamma\n')
  })

  it('ignores an empty oldLines placeholder when oldText is provided', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha', oldLines: [], newText: 'ALPHA' },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'ALPHA\nbeta\n')
  })

  it('ignores an empty newLines placeholder when newText is provided', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha', newText: 'ALPHA', newLines: [] },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'ALPHA\nbeta\n')
  })

  it('treats a single empty newLines entry as an empty inline replacement', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'alpha\nbeta\n', 'utf8')

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'alpha\n', newLines: [''] },
      { workspacePath: workspace }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 1)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'beta\n')
  })

  it('shifts cached ranges after an edit that adds lines', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 5) // read all 5 lines

    // Edit line 2: replace 'b' with 'b1\nb2\nb3' (adds 2 lines, delta=+2)
    const r1 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'b', newText: 'b1\nb2\nb3' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(r1.error, undefined)

    // Now 'e' is on line 7 (was line 5, shifted by +2). The guard should allow editing it.
    const r2 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'e', newText: 'E' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(r2.error, undefined, 'guard must not block after line-adding edit')
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb1\nb2\nb3\nc\nd\nE')
  })

  it('shifts cached ranges after an edit that removes lines', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\nf\ng', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 7) // all 7 lines

    // Remove lines 2-4 by replacing 'b\nc\nd' with 'X' (delta=-2)
    const r1 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'b\nc\nd', newText: 'X' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(r1.error, undefined)

    // 'g' was on line 7, now on line 5. Guard should allow it.
    const r2 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'g', newText: 'G' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(r2.error, undefined, 'guard must not block after line-removing edit')
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nX\ne\nf\nG')
  })

  it('does not extend coverage beyond original read after line-adding edit', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    // 10 lines: model only reads 1-5
    await writeFile(filePath, '1\n2\n3\n4\n5\n6\n7\n8\n9\n10', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(filePath, 1, 5) // only lines 1-5

    // Edit line 2: 'b' → 'x\ny' (adds 1 line, delta=+1)
    const r1 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: '2', newText: '2a\n2b' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(r1.error, undefined)

    // Original line 5 ('5') is now at line 6. Should be allowed (was within original read).
    const r2 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: '5', newText: 'FIVE' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.strictEqual(r2.error, undefined)

    // Original line 7 ('7') is now at line 8. Was NEVER read. Should be blocked.
    const r3 = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: '7', newText: 'SEVEN' },
      { workspacePath: workspace, readRecordCache: cache }
    )
    assert.ok(r3.error, 'lines beyond original read range must still be blocked after shift')
    assert.match(r3.error!, /did not cover/)
  })

  it('allows edit after multiple reads that together cover the target line', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ntarget text', 'utf8')

    const cache = new ReadRecordCache()
    cache.recordRead(join(workspace, 'file.txt'), 1, 3)
    cache.recordRead(join(workspace, 'file.txt'), 4, 6) // now lines 1-6 covered

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'target text', newText: 'replaced' },
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
      { mode: 'inline', path: 'file.txt', oldText: 'b\nc', newText: 'X' },
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
      { mode: 'inline', path: 'file.txt', oldText: 'b\nc', newText: 'X' },
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
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
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
      { mode: 'inline', path: 'file.txt', oldText: 'hello', newText: 'hi', replace_all: true },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.replacements, 3)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'hi\nworld\nhi\nworld\nhi')
  })

  it('allows edit after grep tool covered the target line', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const cache = new ReadRecordCache()
    const searchService = createSearchService()
    // Grep line 3 with context 1 → covers lines 2-4
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

  it('allows edit after a read-only bash command covered the target line', async () => {
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

  it('rejects edit when bash command only covered a different region', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const cache = new ReadRecordCache()
    await runBashTool(
      { command: "sed -n '1,2p' file.txt", timeout: 30, background: false },
      { workspacePath: workspace, readRecordCache: cache }
    )

    const result = await runEditTool(
      { mode: 'inline', path: 'file.txt', oldText: 'c', newText: 'C' },
      { workspacePath: workspace, readRecordCache: cache }
    )

    assert.ok(result.error)
    assert.match(result.error, /did not cover/)
    assert.strictEqual(result.details.replacements, 0)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'a\nb\nc\nd\ne\n')
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
      cache.recordRead(filePath, 1, 5) // covers the phantom trailing line as well

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

    it('uses newLines for multiline range replacements', async () => {
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
          newLines: ['BETA', 'GAMMA']
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

    it('rejects when the target range was not covered by a recent read', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 2) // only lines 1-2 read

      const result = await runEditTool(
        { mode: 'range', path: 'file.txt', replaceLines: { start: 4, end: 5 }, newText: 'X' },
        { workspacePath: workspace, readRecordCache: cache }
      )
      assert.ok(result.error)
      assert.match(result.error, /lines 4, 5/)
      assert.match(result.error, /did not cover/)
      assert.strictEqual(result.details.replacements, 0)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'a\nb\nc\nd\ne\n')
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

    it('uses line arrays inside batched edits', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldLines: ['alpha', 'beta'], newLines: ['A', 'B'], replace_all: false },
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

    it('accepts equivalent string and line-array fields inside batched edits', async () => {
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
              oldLines: ['line 2: beta'],
              newText: 'line 2: beta edited',
              newLines: ['line 2: beta edited'],
              replace_all: false
            }
          ]
        },
        { workspacePath: workspace }
      )

      assert.strictEqual(result.error, undefined)
      assert.strictEqual(result.details.replacements, 1)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'line 1: alpha\nline 2: beta edited\nline 3: gamma\n')
    })

    it('uses batched newLines when newText is an empty placeholder', async () => {
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
              oldLines: ['line 2: beta'],
              newText: '',
              newLines: ['line 2: beta edited', 'line 2.5: inserted'],
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

    it('preserves synthesized literal backslash-n matches during coverage checks', async () => {
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

    it('rejects batch when an earlier edit disambiguates a later oldText into an unread line', async () => {
      // Regression for P1: in a batch, each edit's coverage must be validated against
      // ALL its occurrences in the original, not just the first one — because an earlier
      // batched edit can consume one occurrence, causing a later edit's "first match"
      // at apply time to fall on an unread line.
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      // 'foo' appears on line 1 and line 5; only lines 1-4 are read.
      await writeFile(filePath, 'foo\na\nb\nc\nfoo\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 4)

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            // Edit 1 uniquely matches line 1's "foo" (via the "\na" context)
            { oldText: 'foo\na', newText: 'FOO\na', replace_all: false },
            // Edit 2 would now match only line 5's "foo" at apply time, but line 5 was never read
            { oldText: 'foo', newText: 'bar', replace_all: false }
          ]
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.ok(result.error, 'expected batch to be rejected')
      assert.match(result.error, /line 5/)
      assert.match(result.error, /did not cover/)
      assert.strictEqual(result.details.replacements, 0)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'foo\na\nb\nc\nfoo\n', 'file must not be edited')
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

    it('read-coverage guard accumulates line requirements across all edits', async () => {
      const workspace = await makeWorkspace()
      const filePath = join(workspace, 'file.txt')
      await writeFile(filePath, 'one\ntwo\nthree\nfour\nfive\n', 'utf8')

      const cache = new ReadRecordCache()
      cache.recordRead(filePath, 1, 2) // only lines 1-2 covered

      const result = await runEditTool(
        {
          mode: 'batch',
          path: 'file.txt',
          edits: [
            { oldText: 'one', newText: '1', replace_all: false }, // line 1 — covered
            { oldText: 'five', newText: '5', replace_all: false } // line 5 — NOT covered
          ]
        },
        { workspacePath: workspace, readRecordCache: cache }
      )

      assert.ok(result.error)
      assert.match(result.error, /line 5/)
      assert.match(result.error, /did not cover/)
      assert.strictEqual(result.details.replacements, 0)
      const content = await readFile(filePath, 'utf8')
      assert.strictEqual(content, 'one\ntwo\nthree\nfour\nfive\n')
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

    it('accepts line arrays for multiline inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldLines: ['hello', 'world'],
        newLines: ['hi', 'there']
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts an empty newLines placeholder when newText is provided', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: 'hi',
        newLines: []
      })
      assert.strictEqual(parsed.success, true)
    })

    it('rejects an empty newLines placeholder without replacement text', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newLines: []
      })
      assert.strictEqual(parsed.success, false)
    })

    it('accepts a single empty newLines entry as an empty replacement', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newLines: ['']
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts equivalent string and line-array fields in inline mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello\nworld',
        oldLines: ['hello', 'world'],
        newText: 'hi\nthere',
        newLines: ['hi', 'there']
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts empty newText as a placeholder when newLines is provided', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        newText: '',
        newLines: ['hi']
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts newLines for range mode', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'range',
        path: 'file.txt',
        replaceLines: { start: 1, end: 2 },
        newLines: ['hi', 'there']
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts line arrays inside batch edits', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'batch',
        path: 'file.txt',
        edits: [{ oldLines: ['x', 'y'], newLines: ['z'] }]
      })
      assert.strictEqual(parsed.success, true)
    })

    it('accepts equivalent string and line-array fields inside batch edits', () => {
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
      assert.strictEqual(parsed.success, true)
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

    it('rejects inline mode with conflicting string and line-array search text', () => {
      const parsed = editToolInputSchema.safeParse({
        mode: 'inline',
        path: 'file.txt',
        oldText: 'hello',
        oldLines: ['goodbye'],
        newText: 'hi'
      })
      assert.strictEqual(parsed.success, false)
    })

    it('rejects inline mode with conflicting string and line-array replacement text', () => {
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
