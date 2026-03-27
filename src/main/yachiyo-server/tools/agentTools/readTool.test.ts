import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { runReadTool } from './readTool.ts'

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

    const result = await runReadTool({ path: imagePath }, { workspacePath })

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
      const result = await runReadTool({ path: filePath }, { workspacePath })
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

    const result = await runReadTool({ path: textPath }, { workspacePath })

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
    const result = await runReadTool(
      { path: join(workspacePath, 'missing.png') },
      { workspacePath }
    )
    assert.ok(result.error, 'should have an error for missing file')
  })
})
