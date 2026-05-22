import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parsePatch,
  parsePatchStreaming,
  seekSequence,
  runApplyPatchTool,
  type Hunk
} from './applyPatchTool.ts'
import type { AgentToolContext } from './shared.ts'

function assertUpdateHunk(hunk: Hunk): asserts hunk is Extract<Hunk, { kind: 'update' }> {
  assert.strictEqual(hunk.kind, 'update')
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'apply-patch-test-'))
}

function makeContext(workspacePath: string): AgentToolContext {
  return { workspacePath }
}

function makeSnapshotTracker(): {
  paths: string[]
  tracker: AgentToolContext['snapshotTracker']
} {
  const paths: string[] = []
  return {
    paths,
    tracker: {
      trackBeforeWrite: async (path: string) => {
        paths.push(path)
      }
    } as AgentToolContext['snapshotTracker']
  }
}

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

describe('parsePatch', () => {
  it('parses add file hunk', () => {
    const patch = `*** Begin Patch
*** Add File: src/hello.txt
+hello
+world
*** End Patch`
    const result = parsePatch(patch)
    assert.strictEqual(result.hunks.length, 1)
    assert.deepStrictEqual(result.hunks[0], {
      kind: 'add',
      path: 'src/hello.txt',
      contents: 'hello\nworld\n'
    })
  })

  it('parses delete file hunk', () => {
    const patch = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`
    const result = parsePatch(patch)
    assert.strictEqual(result.hunks.length, 1)
    assert.deepStrictEqual(result.hunks[0], { kind: 'delete', path: 'old.txt' })
  })

  it('parses update file hunk with context and diff lines', () => {
    const patch = `*** Begin Patch
*** Update File: config.json
@@ section
-  "old": true
+  "new": true
   "keep": 1
*** End Patch`
    const result = parsePatch(patch)
    assert.strictEqual(result.hunks.length, 1)
    const hunk = result.hunks[0]
    assert.strictEqual(hunk.kind, 'update')
    assert.strictEqual(hunk.path, 'config.json')
    assert.strictEqual(hunk.movePath, undefined)
    assert.strictEqual(hunk.chunks.length, 1)
    assert.strictEqual(hunk.chunks[0].changeContext, 'section')
    assert.deepStrictEqual(hunk.chunks[0].oldLines, ['  "old": true', '  "keep": 1'])
    assert.deepStrictEqual(hunk.chunks[0].newLines, ['  "new": true', '  "keep": 1'])
    assert.strictEqual(hunk.chunks[0].isEndOfFile, false)
  })

  it('parses update file with move to', () => {
    const patch = `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new
*** End Patch`
    const result = parsePatch(patch)
    assert.strictEqual(result.hunks.length, 1)
    const hunk = result.hunks[0]
    assert.strictEqual(hunk.kind, 'update')
    assert.strictEqual(hunk.path, 'old.txt')
    assert.strictEqual(hunk.movePath, 'new.txt')
  })

  it('parses multiple hunks', () => {
    const patch = `*** Begin Patch
*** Add File: a.txt
+alpha
*** Delete File: b.txt
*** Update File: c.txt
@@
 -x
 +y
*** End Patch`
    const result = parsePatch(patch)
    assert.strictEqual(result.hunks.length, 3)
  })

  it('parses end of file marker', () => {
    const patch = `*** Begin Patch
*** Update File: file.txt
@@
-last
*** End of File
*** End Patch`
    const result = parsePatch(patch)
    const hunk = result.hunks[0]
    assertUpdateHunk(hunk)
    assert.strictEqual(hunk.chunks[0].isEndOfFile, true)
  })

  it('allows empty context marker', () => {
    const patch = `*** Begin Patch
*** Update File: file.txt
@@
+new line
*** End Patch`
    const result = parsePatch(patch)
    const hunk = result.hunks[0]
    assertUpdateHunk(hunk)
    assert.strictEqual(hunk.chunks[0].changeContext, undefined)
  })

  it('rejects missing begin marker', () => {
    assert.throws(() => parsePatch('*** End Patch'), /first line/)
  })

  it('rejects missing end marker', () => {
    assert.throws(() => parsePatch('*** Begin Patch\n*** Add File: x\n+y'), /last line/)
  })

  it('reports the patch line number for malformed update hunks', () => {
    assert.throws(
      () =>
        parsePatch(`*** Begin Patch
*** Update File: bad.txt
@@
!bad
*** End Patch`),
      /line 4/
    )
  })

  it('parses streamed partial patches without requiring the end marker', () => {
    const result = parsePatchStreaming(`*** Begin Patch
*** Add File: streamed.txt
+hello
*** Update File: existing.txt
@@
-old
+new`)

    assert.strictEqual(result.hunks.length, 2)
    assert.deepStrictEqual(
      result.hunks.map((hunk) => hunk.kind),
      ['add', 'update']
    )
  })

  it('keeps streamed hunk count monotonic while patch text grows', () => {
    const patch = `*** Begin Patch
*** Add File: one.txt
+one
*** Delete File: two.txt
*** Update File: three.txt
@@
-old
+new
*** End Patch`
    let max = 0
    for (let i = 1; i <= patch.length; i++) {
      try {
        const result = parsePatchStreaming(patch.slice(0, i))
        assert.ok(result.hunks.length >= max)
        max = result.hunks.length
      } catch {
        // Partial text before the begin marker or before the first valid hunk can be invalid.
      }
    }
    assert.strictEqual(max, 3)
  })

  it('rejects empty update hunk', () => {
    assert.throws(
      () =>
        parsePatch(`*** Begin Patch
*** Update File: empty.txt
*** End Patch`),
      /empty/
    )
  })

  it('tolerates leading and trailing whitespace around markers', () => {
    const patch = `  *** Begin Patch
*** Add File: x.txt
+content
*** End Patch  `
    const result = parsePatch(patch)
    assert.strictEqual(result.hunks.length, 1)
  })

  it('tolerates leading and trailing whitespace around all control markers', () => {
    const patch = `  *** Begin Patch
  *** Update File: old.txt  
  *** Move to: new.txt  
  @@ old section  
-old
+new
  *** End of File  
*** End Patch  `
    const result = parsePatch(patch)
    const hunk = result.hunks[0]
    assertUpdateHunk(hunk)
    assert.strictEqual(hunk.path, 'old.txt')
    assert.strictEqual(hunk.movePath, 'new.txt')
    assert.strictEqual(hunk.chunks[0].changeContext, 'old section')
    assert.strictEqual(hunk.chunks[0].isEndOfFile, true)
  })
})

// ---------------------------------------------------------------------------
// seekSequence tests
// ---------------------------------------------------------------------------

describe('seekSequence', () => {
  it('finds exact match', () => {
    const lines = ['foo', 'bar', 'baz']
    const result = seekSequence(lines, ['bar', 'baz'], 0, false)
    assert.strictEqual(result, 1)
  })

  it('finds rstrip match ignoring trailing whitespace', () => {
    const lines = ['foo   ', 'bar\t\t']
    const result = seekSequence(lines, ['foo', 'bar'], 0, false)
    assert.strictEqual(result, 0)
  })

  it('finds trim match ignoring leading and trailing whitespace', () => {
    const lines = ['    foo   ', '   bar\t']
    const result = seekSequence(lines, ['foo', 'bar'], 0, false)
    assert.strictEqual(result, 0)
  })

  it('returns undefined when pattern is longer than input', () => {
    const lines = ['just one line']
    const result = seekSequence(lines, ['too', 'many', 'lines'], 0, false)
    assert.strictEqual(result, undefined)
  })

  it('returns start when pattern is empty', () => {
    const lines = ['a', 'b', 'c']
    const result = seekSequence(lines, [], 2, false)
    assert.strictEqual(result, 2)
  })

  it('respects eof flag to search from end', () => {
    const lines = ['foo', 'bar', 'foo', 'bar']
    const result = seekSequence(lines, ['foo', 'bar'], 0, true)
    assert.strictEqual(result, 2)
  })

  it('matches unicode normalized dashes', () => {
    const lines = ['function \u2013 test']
    const result = seekSequence(lines, ['function - test'], 0, false)
    assert.strictEqual(result, 0)
  })

  it('matches unicode normalized quotes', () => {
    const lines = ['"smart" quotes']
    const result = seekSequence(lines, ['"smart" quotes'], 0, false)
    assert.strictEqual(result, 0)
  })
})

// ---------------------------------------------------------------------------
// Tool execution tests
// ---------------------------------------------------------------------------

describe('runApplyPatchTool', () => {
  it('adds a new file', async () => {
    const workspace = await makeWorkspace()
    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: created.txt
+hello world
+second line
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.operations.length, 1)
    assert.strictEqual(result.details.operations[0].operation, 'add')
    assert.strictEqual(result.details.operations[0].path, 'created.txt')

    const content = await readFile(join(workspace, 'created.txt'), 'utf8')
    assert.strictEqual(content, 'hello world\nsecond line\n')
  })

  it('deletes an existing file', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'remove.txt')
    await writeFile(filePath, 'bye', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Delete File: remove.txt
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.operations[0].operation, 'delete')
  })

  it('updates an existing file', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'update.txt')
    await writeFile(filePath, 'alpha\nbeta\ngamma\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: update.txt
@@
-beta
+DELTA
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.operations[0].operation, 'update')

    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'alpha\nDELTA\ngamma\n')
  })

  it('updates with context marker', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'ctx.txt')
    await writeFile(filePath, 'header\nfoo\nbar\nfooter\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: ctx.txt
@@ header
-foo
+FOO
 bar
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'header\nFOO\nbar\nfooter\n')
  })

  it('moves a file while updating content', async () => {
    const workspace = await makeWorkspace()
    const oldPath = join(workspace, 'old.txt')
    await writeFile(oldPath, 'old content\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-old content
+new content
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.operations[0].operation, 'move')
    assert.strictEqual(result.details.operations[0].movePath, 'new.txt')

    const newContent = await readFile(join(workspace, 'new.txt'), 'utf8')
    assert.strictEqual(newContent, 'new content\n')
  })

  it('applies multiple hunks', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'existing.txt'), 'line\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: new.txt
+brand new
*** Update File: existing.txt
@@
-line
+edited
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    assert.strictEqual(result.details.operations.length, 2)
    assert.strictEqual(result.details.operations[0].operation, 'add')
    assert.strictEqual(result.details.operations[1].operation, 'update')

    const newContent = await readFile(join(workspace, 'new.txt'), 'utf8')
    assert.strictEqual(newContent, 'brand new\n')
    const existingContent = await readFile(join(workspace, 'existing.txt'), 'utf8')
    assert.strictEqual(existingContent, 'edited\n')
  })

  it('fails on invalid patch format', async () => {
    const workspace = await makeWorkspace()
    const result = await runApplyPatchTool({ patch: 'not a patch' }, makeContext(workspace))

    assert.ok(result.error)
    assert.match(result.error!, /first line/)
  })

  it('fails when update target does not exist', async () => {
    const workspace = await makeWorkspace()
    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /missing.txt/)
  })

  it('rejects workspace escape via relative path', async () => {
    const workspace = await makeWorkspace()
    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: ../../escape.txt
+bad
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /escapes the workspace/)
    assert.doesNotMatch(result.error!, /absolute path/i)
  })

  it('rejects absolute paths', async () => {
    const workspace = await makeWorkspace()
    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: /tmp/apply-patch-absolute.txt
+bad
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /only supports relative paths inside the workspace/)
  })

  it('captures every changed path in the snapshot tracker before writing', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'update.txt'), 'old\n', 'utf8')
    await writeFile(join(workspace, 'delete.txt'), 'delete\n', 'utf8')
    await writeFile(join(workspace, 'move.txt'), 'move\n', 'utf8')
    const { tracker, paths } = makeSnapshotTracker()

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: add.txt
+add
*** Update File: update.txt
@@
-old
+new
*** Delete File: delete.txt
*** Update File: move.txt
*** Move to: moved.txt
@@
-move
+moved
*** End Patch`
      },
      { ...makeContext(workspace), snapshotTracker: tracker }
    )

    assert.strictEqual(result.error, undefined)
    assert.deepStrictEqual(
      paths.sort(),
      ['add.txt', 'delete.txt', 'moved.txt', 'move.txt', 'update.txt']
        .map((path) => join(workspace, path))
        .sort()
    )
  })

  it('explains whether anchors and expected lines were found when an update fails', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'diagnostic.txt'), 'anchor\nactual\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: diagnostic.txt
@@ anchor
-missing
+replacement
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /Found anchor 'anchor'/)
    assert.match(result.error!, /but could not find expected lines after it/)
    assert.match(result.error!, /diagnostic.txt/)
  })

  it('creates parent directories for add file', async () => {
    const workspace = await makeWorkspace()
    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: deep/nested/file.txt
+deep content
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(join(workspace, 'deep', 'nested', 'file.txt'), 'utf8')
    assert.strictEqual(content, 'deep content\n')
  })

  it('handles end-of-file updates', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'eof.txt')
    await writeFile(filePath, 'keep\nremove\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: eof.txt
@@ remove
-remove
*** End of File
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'keep\n')
  })

  it('pure addition at end of file', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'append.txt')
    await writeFile(filePath, 'existing\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: append.txt
@@
+appended
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'existing\nappended\n')
  })

  it('pure addition with an anchor inserts after the anchor instead of at end of file', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'anchored-insert.txt')
    await writeFile(filePath, 'header\nbody\nfooter\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: anchored-insert.txt
@@ header
+inserted
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'header\ninserted\nbody\nfooter\n')
  })

  it('preserves missing trailing newline when updating existing files', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'no-trailing-newline.txt')
    await writeFile(filePath, 'alpha\nbeta', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: no-trailing-newline.txt
@@
-beta
+BETA
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'alpha\nBETA')
  })

  it('creates an empty file from an empty add hunk', async () => {
    const workspace = await makeWorkspace()

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: empty.txt
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(join(workspace, 'empty.txt'), 'utf8')
    assert.strictEqual(content, '')
  })

  it('updates the second matching block after a context marker', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'repeated.txt')
    await writeFile(filePath, 'target\nold\nanchor\ntarget\nold\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: repeated.txt
@@ anchor
-target
+TARGET
 old
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.strictEqual(result.error, undefined)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'target\nold\nanchor\nTARGET\nold\n')
  })

  it('rejects move destinations that escape the workspace', async () => {
    const workspace = await makeWorkspace()
    await writeFile(join(workspace, 'move.txt'), 'inside\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: move.txt
*** Move to: ../outside.txt
@@
-inside
+outside
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /move destination.*escapes the workspace/)
    assert.doesNotMatch(result.error!, /absolute path/i)
  })

  it('rejects adding over an existing file', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'existing.txt')
    await writeFile(filePath, 'original\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: existing.txt
+replacement
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /already exists/)
    const content = await readFile(filePath, 'utf8')
    assert.strictEqual(content, 'original\n')
  })

  it('rejects moving over an existing file', async () => {
    const workspace = await makeWorkspace()
    const sourcePath = join(workspace, 'source.txt')
    const targetPath = join(workspace, 'target.txt')
    await writeFile(sourcePath, 'source\n', 'utf8')
    await writeFile(targetPath, 'target\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: target.txt
@@
-source
+moved
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /already exists/)
    const sourceContent = await readFile(sourcePath, 'utf8')
    const targetContent = await readFile(targetPath, 'utf8')
    assert.strictEqual(sourceContent, 'source\n')
    assert.strictEqual(targetContent, 'target\n')
  })

  it('leaves every file unchanged when a later hunk fails', async () => {
    const workspace = await makeWorkspace()
    const existingPath = join(workspace, 'existing.txt')
    await writeFile(existingPath, 'alpha\nbeta\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: created.txt
+created
*** Update File: existing.txt
@@
-missing
+changed
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    await assert.rejects(readFile(join(workspace, 'created.txt'), 'utf8'))
    const content = await readFile(existingPath, 'utf8')
    assert.strictEqual(content, 'alpha\nbeta\n')
  })

  it('keeps deleted files when a later hunk fails', async () => {
    const workspace = await makeWorkspace()
    const deletePath = join(workspace, 'delete.txt')
    const existingPath = join(workspace, 'existing.txt')
    await writeFile(deletePath, 'delete me\n', 'utf8')
    await writeFile(existingPath, 'alpha\nbeta\n', 'utf8')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Delete File: delete.txt
*** Update File: existing.txt
@@
-missing
+changed
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    const deletedContent = await readFile(deletePath, 'utf8')
    const existingContent = await readFile(existingPath, 'utf8')
    assert.strictEqual(deletedContent, 'delete me\n')
    assert.strictEqual(existingContent, 'alpha\nbeta\n')
  })

  it('rejects adding a file through a symlinked directory outside the workspace', async () => {
    const workspace = await makeWorkspace()
    const outside = await makeWorkspace()
    await symlink(outside, join(workspace, 'linked-dir'), 'dir')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Add File: linked-dir/created.txt
+escaped
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /resolves outside the workspace via a symlink/)
    assert.doesNotMatch(result.error!, /absolute path/i)
    await assert.rejects(readFile(join(outside, 'created.txt'), 'utf8'))
  })

  it('rejects moving a file through a symlinked destination directory outside the workspace', async () => {
    const workspace = await makeWorkspace()
    const outside = await makeWorkspace()
    await mkdir(join(workspace, 'safe'), { recursive: true })
    await writeFile(join(workspace, 'source.txt'), 'source\n', 'utf8')
    await symlink(outside, join(workspace, 'safe', 'linked-dir'), 'dir')

    const result = await runApplyPatchTool(
      {
        patch: `*** Begin Patch
*** Update File: source.txt
*** Move to: safe/linked-dir/moved.txt
@@
-source
+moved
*** End Patch`
      },
      makeContext(workspace)
    )

    assert.ok(result.error)
    assert.match(result.error!, /move destination.*resolves outside the workspace via a symlink/)
    assert.doesNotMatch(result.error!, /absolute path/i)
    await assert.rejects(readFile(join(outside, 'moved.txt'), 'utf8'))
  })
})
