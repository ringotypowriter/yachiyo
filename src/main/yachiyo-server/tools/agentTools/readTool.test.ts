import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { runReadTool } from './readTool.ts'
import { ReadRecordCache } from './readRecordCache.ts'
import type { ReadToolInput } from './shared.ts'
import { DEFAULT_READ_LIMIT } from './shared.ts'

function readInput(partial: { path: string; offset?: number; limit?: number }): ReadToolInput {
  return { offset: 0, limit: DEFAULT_READ_LIMIT, ...partial }
}

async function withWorkspace(fn: (workspacePath: string) => Promise<void>): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-read-tool-'))
  try {
    await fn(workspacePath)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
}

test('runReadTool reads image file as base64 with image-data content block', async () => {
  await withWorkspace(async (workspacePath) => {
    // Minimal 1x1 white PNG (67 bytes)
    const pngBuffer = Buffer.from(
      '89504e470d0a1a0a0000000d494844520000000100000001080200000090' +
        '7753de0000000c4944415408d76360f8cfc000000002' +
        '0001e221bc330000000049454e44ae426082',
      'hex'
    )
    const imagePath = join(workspacePath, 'photo.png')
    await writeFile(imagePath, pngBuffer)

    const result = await runReadTool(readInput({ path: imagePath }), { workspacePath })

    assert.equal(result.error, undefined)
    assert.equal(result.details.mediaType, 'image/png')
    assert.equal(result.details.totalLines, 0)
    assert.equal(result.details.truncated, false)

    const imageBlock = result.content.find((b) => b.type === 'image-data')
    assert.ok(imageBlock, 'should have an image-data block')
    assert.equal(imageBlock?.type, 'image-data')
    if (imageBlock?.type === 'image-data') {
      assert.equal(imageBlock.mediaType, 'image/png')
      assert.equal(imageBlock.data, pngBuffer.toString('base64'))
    }

    const textBlock = result.content.find((b) => b.type === 'text')
    assert.ok(textBlock, 'should have a text summary block')
    if (textBlock?.type === 'text') {
      assert.match(textBlock.text, /photo\.png/)
      assert.match(textBlock.text, /image\/png/)
    }
  })
})

test('runReadTool detects .jpg, .jpeg, .webp extensions', async () => {
  await withWorkspace(async (workspacePath) => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0]) // JPEG magic bytes

    for (const [filename, expectedMime] of [
      ['shot.jpg', 'image/jpeg'],
      ['shot.jpeg', 'image/jpeg'],
      ['shot.webp', 'image/webp']
    ] as const) {
      const filePath = join(workspacePath, filename)
      await writeFile(filePath, data)
      const result = await runReadTool(readInput({ path: filePath }), { workspacePath })
      assert.equal(result.details.mediaType, expectedMime, `${filename} → ${expectedMime}`)
      assert.ok(
        result.content.some((b) => b.type === 'image-data'),
        `${filename} should have image-data block`
      )
    }
  })
})

test('runReadTool falls back to text for non-image extensions', async () => {
  await withWorkspace(async (workspacePath) => {
    const textPath = join(workspacePath, 'hello.txt')
    await writeFile(textPath, 'hello world', 'utf8')

    const result = await runReadTool(readInput({ path: textPath }), { workspacePath })

    assert.equal(result.details.mediaType, undefined)
    assert.ok(
      result.content.every((b) => b.type === 'text'),
      'text file should have only text blocks'
    )
    const textBlock = result.content.find((b) => b.type === 'text')
    if (textBlock?.type === 'text') {
      assert.match(textBlock.text, /hello world/)
    }
  })
})

test('runReadTool returns error result for missing image file', async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await runReadTool(readInput({ path: join(workspacePath, 'missing.png') }), {
      workspacePath
    })
    assert.ok(result.error, 'should have an error for missing file')
  })
})

test('runReadTool resolves Unicode spaces in intermediate directory names', async () => {
  await withWorkspace(async (workspacePath) => {
    // U+202F NARROW NO-BREAK SPACE — used by macOS in CleanShot filenames
    const dirWithNbsp = join(workspacePath, 'my\u202Fnotes')
    await mkdir(dirWithNbsp, { recursive: true })
    await writeFile(join(dirWithNbsp, 'design\u202Fdoc.md'), '# Design Doc\n', 'utf8')

    // LLM sends regular spaces (U+0020) because it normalizes Unicode spaces
    const result = await runReadTool(
      readInput({ path: join(workspacePath, 'my notes', 'design doc.md') }),
      { workspacePath }
    )

    assert.equal(result.error, undefined)
    const textBlock = result.content.find((b) => b.type === 'text')
    assert.ok(textBlock?.type === 'text')
    assert.match(textBlock.text, /# Design Doc/)
  })
})

test('runReadTool resolves Unicode spaces in deeply nested paths', async () => {
  await withWorkspace(async (workspacePath) => {
    const deepPath = join(workspacePath, 'docs\u202Fhere', 'sub\u202Fdir')
    await mkdir(deepPath, { recursive: true })
    await writeFile(join(deepPath, 'file\u202Fname.txt'), 'found it\n', 'utf8')

    const result = await runReadTool(
      readInput({ path: join(workspacePath, 'docs here', 'sub dir', 'file name.txt') }),
      { workspacePath }
    )

    assert.equal(result.error, undefined)
    const textBlock = result.content.find((b) => b.type === 'text')
    assert.ok(textBlock?.type === 'text')
    assert.match(textBlock.text, /found it/)
  })
})

test('runReadTool records an empty file as read so overwrite guard passes', async () => {
  await withWorkspace(async (workspacePath) => {
    const filePath = join(workspacePath, 'empty.txt')
    await writeFile(filePath, '', 'utf8')

    const cache = new ReadRecordCache()
    await runReadTool(readInput({ path: filePath }), { workspacePath, readRecordCache: cache })

    assert.equal(cache.hasRecentRead(filePath), true, 'empty file read should create a record')
  })
})

test('runReadTool does not record a read when offset is past EOF', async () => {
  await withWorkspace(async (workspacePath) => {
    const filePath = join(workspacePath, 'short.txt')
    await writeFile(filePath, 'line1\nline2', 'utf8')

    const cache = new ReadRecordCache()
    await runReadTool(readInput({ path: filePath, offset: 999 }), {
      workspacePath,
      readRecordCache: cache
    })

    assert.equal(
      cache.hasRecentRead(filePath),
      false,
      'empty past-EOF read should not create a record'
    )
  })
})

test('runReadTool does not record a byte-truncated partial first line as read', async () => {
  await withWorkspace(async (workspacePath) => {
    const filePath = join(workspacePath, 'huge-line.txt')
    // Create a single line longer than the 16 KB byte limit
    const hugeLine = 'x'.repeat(20_000)
    await writeFile(filePath, hugeLine, 'utf8')

    const cache = new ReadRecordCache()
    const result = await runReadTool(readInput({ path: filePath }), {
      workspacePath,
      readRecordCache: cache
    })

    // The read should succeed with truncated content
    assert.equal(result.error, undefined)
    assert.equal(result.details.truncated, true)

    // But the cache should NOT record line 1 as read — only a fragment was returned
    assert.equal(
      cache.hasRecentRead(filePath),
      false,
      'byte-truncated partial line should not authorize edits'
    )
    assert.equal(cache.coversLine(filePath, 1), false)
  })
})
