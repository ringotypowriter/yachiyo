import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachmentToImageRecord,
  detectMediaTypeFromBytes,
  fetchImageAsDataUrl
} from './channelImageDownload.ts'

describe('attachmentToImageRecord', () => {
  it('converts a buffer attachment to a data URL record', async () => {
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    const attachment = {
      type: 'image' as const,
      data: pixel,
      name: 'photo.png'
    }

    const result = await attachmentToImageRecord(attachment)
    assert.ok(result)
    assert.equal(result.mediaType, 'image/png')
    assert.ok(result.dataUrl.startsWith('data:image/png;base64,'))
    assert.equal(result.filename, 'photo.png')
  })

  it('uses fetchData when data is not present', async () => {
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    const attachment = {
      type: 'image' as const,
      fetchData: async () => pixel,
      name: 'fetched.png'
    }

    const result = await attachmentToImageRecord(attachment)
    assert.ok(result)
    assert.equal(result.mediaType, 'image/png') // magic bytes detect PNG
    assert.equal(result.filename, 'fetched.png')
  })

  it('returns null when attachment exceeds max bytes', async () => {
    const big = Buffer.alloc(100)
    const attachment = {
      type: 'image' as const,
      data: big,
      name: 'big.png'
    }

    const result = await attachmentToImageRecord(attachment, { maxBytes: 50 })
    assert.equal(result, null)
  })

  it('returns null early if size field exceeds limit', async () => {
    const attachment = {
      type: 'image' as const,
      data: Buffer.alloc(10),
      size: 10_000_000,
      name: 'huge.png'
    }

    const result = await attachmentToImageRecord(attachment, { maxBytes: 5_000_000 })
    assert.equal(result, null)
  })

  it('returns null when no data and no fetchData', async () => {
    const attachment = { type: 'image' as const, name: 'empty.png' }
    const result = await attachmentToImageRecord(attachment)
    assert.equal(result, null)
  })

  it('returns null when fetchData throws', async () => {
    const attachment = {
      type: 'image' as const,
      fetchData: async () => {
        throw new Error('network error')
      },
      name: 'broken.png'
    }
    const result = await attachmentToImageRecord(attachment)
    assert.equal(result, null)
  })

  it('defaults to image/jpeg when extension is unknown', async () => {
    const pixel = Buffer.from('fake')
    const attachment = { type: 'image' as const, data: pixel }

    const result = await attachmentToImageRecord(attachment)
    assert.ok(result)
    assert.equal(result.mediaType, 'image/jpeg')
  })
})

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

  it('converts GIF to PNG (first frame) for vision model compatibility', async () => {
    // Minimal valid 1x1 GIF89a
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    const attachment = {
      type: 'image' as const,
      data: gif,
      name: 'sticker.gif'
    }
    const result = await attachmentToImageRecord(attachment)
    assert.ok(result)
    assert.equal(result.mediaType, 'image/png') // converted from GIF → PNG
    assert.ok(result.dataUrl.startsWith('data:image/png;base64,'))
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
