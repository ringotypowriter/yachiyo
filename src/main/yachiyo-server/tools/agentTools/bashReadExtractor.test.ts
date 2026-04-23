import { describe, it } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractBashReadRanges } from './bashReadExtractor.ts'

describe('extractBashReadRanges', () => {
  async function makeWorkspace(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'bash-read-test-'))
  }

  it('returns empty for pipelines', async () => {
    const reads = await extractBashReadRanges('cat file.txt | grep x', '/tmp')
    assert.deepStrictEqual(reads, [])
  })

  it('returns empty for commands with redirects', async () => {
    const reads = await extractBashReadRanges('cat file.txt > other.txt', '/tmp')
    assert.deepStrictEqual(reads, [])
  })

  it('returns empty for sed without -n', async () => {
    const reads = await extractBashReadRanges("sed '195,215p' file.txt", '/tmp')
    assert.deepStrictEqual(reads, [])
  })

  it('returns empty for sed with -i', async () => {
    const reads = await extractBashReadRanges("sed -ni '195,215p' file.txt", '/tmp')
    assert.deepStrictEqual(reads, [])
  })

  it('extracts sed -n range print', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n '2,4p' file.txt", workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.resolvedPath, filePath)
    assert.strictEqual(reads[0]!.startLine, 2)
    assert.strictEqual(reads[0]!.endLine, 4)
  })

  it('extracts sed -n single line print', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n '2p' file.txt", workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 2)
    assert.strictEqual(reads[0]!.endLine, 2)
  })

  it('extracts sed -n relative range (+N)', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n '2,+2p' file.txt", workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 2)
    assert.strictEqual(reads[0]!.endLine, 4)
  })

  it('extracts sed -n to-end ($) capped at file length', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n '2,$p' file.txt", workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 2)
    assert.strictEqual(reads[0]!.endLine, 4) // split gives 4 lines including phantom
  })

  it('returns empty when sed range starts past EOF', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    // Model sees nothing because the file only has 4 lines; the read
    // cache should not be populated for a no-op read.
    const reads = await extractBashReadRanges("sed -n '10,20p' file.txt", workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('returns empty when sed start is past EOF', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n '10p' file.txt", workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('extracts cat as full-file read', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges('cat file.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 1)
    assert.strictEqual(reads[0]!.endLine, 4)
  })

  it('extracts head with -n', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const reads = await extractBashReadRanges('head -n 2 file.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 1)
    assert.strictEqual(reads[0]!.endLine, 2)
  })

  it('extracts head default (10 lines) capped to file size', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges('head file.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 1)
    assert.strictEqual(reads[0]!.endLine, 4)
  })

  it('extracts tail with -n', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\ne\n', 'utf8')

    const reads = await extractBashReadRanges('tail -n 2 file.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 5)
    assert.strictEqual(reads[0]!.endLine, 6)
  })

  it('extracts tail default (10 lines) capped to file size', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges('tail file.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 1)
    assert.strictEqual(reads[0]!.endLine, 4)
  })

  it('rejects head -c (byte mode)', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    // head -c shows bytes, not lines — the model may not see line boundaries.
    const reads = await extractBashReadRanges('head -c 20 file.txt', workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('rejects chained commands (&&)', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    // We cannot know which segments ran due to short-circuit evaluation.
    const reads = await extractBashReadRanges('cat file.txt && echo done', workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('rejects chained commands (;)', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges('cat file.txt; echo done', workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('rejects chained commands (||)', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges('false || cat file.txt', workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('resolves relative paths against cwd', async () => {
    const workspace = await makeWorkspace()
    const sub = join(workspace, 'sub')
    await mkdir(sub, { recursive: true })
    const filePath = join(sub, 'file.txt')
    await writeFile(filePath, 'a\nb\n', 'utf8')

    const reads = await extractBashReadRanges('cat sub/file.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.resolvedPath, filePath)
  })

  it('handles absolute paths', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\n', 'utf8')

    const reads = await extractBashReadRanges(`cat ${filePath}`, workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.resolvedPath, filePath)
  })

  it('handles sed with -e flag', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\nd\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n -e '2,3p' file.txt", workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 2)
    assert.strictEqual(reads[0]!.endLine, 3)
  })

  it('ignores sed with multiple -e scripts', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\nc\n', 'utf8')

    const reads = await extractBashReadRanges("sed -n -e '1p' -e '3p' file.txt", workspace)
    assert.deepStrictEqual(reads, [])
  })

  it('handles quoted file names', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'my file.txt')
    await writeFile(filePath, 'a\nb\n', 'utf8')

    const reads = await extractBashReadRanges("cat 'my file.txt'", workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.resolvedPath, filePath)
  })

  it('handles less / more / bat / nl as full-file reads', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'file.txt')
    await writeFile(filePath, 'a\nb\n', 'utf8')

    for (const cmd of ['less', 'more', 'bat', 'nl']) {
      const reads = await extractBashReadRanges(`${cmd} file.txt`, workspace)
      assert.strictEqual(reads.length, 1, `${cmd} should extract one read`)
      assert.strictEqual(reads[0]!.startLine, 1)
      assert.strictEqual(reads[0]!.endLine, 3)
    }
  })

  it('handles empty files', async () => {
    const workspace = await makeWorkspace()
    const filePath = join(workspace, 'empty.txt')
    await writeFile(filePath, '', 'utf8')

    const reads = await extractBashReadRanges('cat empty.txt', workspace)
    assert.strictEqual(reads.length, 1)
    assert.strictEqual(reads[0]!.startLine, 1)
    assert.strictEqual(reads[0]!.endLine, 0) // empty file → integration uses recordEmptyFileRead
  })
})
