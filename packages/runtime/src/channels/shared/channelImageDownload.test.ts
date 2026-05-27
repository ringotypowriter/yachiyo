import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectMediaTypeFromBytes, fetchImageAsDataUrl } from './channelImageDownload.ts'

describe('detectMediaTypeFromBytes', () => {
  it('detects JPEG from magic bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
    assert.equal(detectMediaTypeFromBytes(jpeg), 'image/jpeg')
  })

  it('detects PNG from magic bytes', () => {
    // Real PNG 1x1 pixel
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    assert.equal(detectMediaTypeFromBytes(png), 'image/png')
  })

  it('detects GIF from magic bytes', () => {
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    assert.equal(detectMediaTypeFromBytes(gif), 'image/gif')
  })

  it('detects WebP from magic bytes', () => {
    // RIFF....WEBP
    const webp = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
    ])
    assert.equal(detectMediaTypeFromBytes(webp), 'image/webp')
  })

  it('returns null for unknown bytes', () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03])
    assert.equal(detectMediaTypeFromBytes(unknown), null)
  })

  it('returns null for empty buffer', () => {
    assert.equal(detectMediaTypeFromBytes(Buffer.alloc(0)), null)
  })
})

describe('fetchImageAsDataUrl', () => {
  it('returns null for non-existent URLs', async () => {
    // Use a port that's almost certainly not listening
    const result = await fetchImageAsDataUrl('http://127.0.0.1:1/__nonexistent', {
      timeoutMs: 1000
    })
    assert.equal(result, null)
  })
})
