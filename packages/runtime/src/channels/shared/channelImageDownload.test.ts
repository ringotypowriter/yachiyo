import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectMediaTypeFromBytes,
  fetchFileAsDataUrl,
  fetchImageAsDataUrl,
  fileBufferToAttachment,
  imageBufferToRecord
} from './channelImageDownload.ts'

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

describe('imageBufferToRecord', () => {
  it('infers HEIC and HEIF media types from filenames when content type is missing', async () => {
    const buffer = Buffer.from('not-inspected-for-vision-safe-types')

    assert.equal(
      (await imageBufferToRecord({ buffer, filename: 'photo.heic' })).mediaType,
      'image/heic'
    )
    assert.equal(
      (await imageBufferToRecord({ buffer, filename: 'photo.heif' })).mediaType,
      'image/heif'
    )
  })
})

describe('fetchFileAsDataUrl', () => {
  it('downloads an extensionless fallback filename using its supported media type', async (t) => {
    const originalFetch = globalThis.fetch
    t.after(() => {
      globalThis.fetch = originalFetch
    })
    globalThis.fetch = async () =>
      new Response(Buffer.from('PDF'), {
        status: 200,
        headers: { 'content-length': '3' }
      })

    assert.deepEqual(
      await fetchFileAsDataUrl('https://multimedia.nt.qq.com/download?fileid=file-1', {
        filename: 'qqbot-file-1',
        mediaType: 'application/pdf',
        attachmentIndex: 1
      }),
      {
        filename: 'qqbot-file-1',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,UERG',
        attachmentIndex: 1
      }
    )
  })
})

describe('fileBufferToAttachment', () => {
  it('accepts composer-supported extensions and resolves media type from filename', () => {
    assert.deepEqual(
      fileBufferToAttachment({ buffer: Buffer.from('hello'), filename: 'notes.md' }),
      {
        filename: 'notes.md',
        mediaType: 'text/markdown',
        dataUrl: 'data:text/markdown;base64,aGVsbG8='
      }
    )
  })

  it('accepts zip archives so skill bundles remain available by workspace path', () => {
    assert.deepEqual(fileBufferToAttachment({ buffer: Buffer.from('PK'), filename: 'skill.zip' }), {
      filename: 'skill.zip',
      mediaType: 'application/zip',
      dataUrl: 'data:application/zip;base64,UEs='
    })
  })

  it('accepts a fallback filename when the platform supplies a supported media type', () => {
    assert.deepEqual(
      fileBufferToAttachment({
        buffer: Buffer.from('PDF'),
        filename: 'qqbot-file-1',
        mediaType: 'application/pdf',
        attachmentIndex: 1
      }),
      {
        filename: 'qqbot-file-1',
        mediaType: 'application/pdf',
        dataUrl: 'data:application/pdf;base64,UERG',
        attachmentIndex: 1
      }
    )
  })

  it('does not let a supported media type override an unsupported extension', () => {
    assert.throws(
      () =>
        fileBufferToAttachment({
          buffer: Buffer.from('PDF'),
          filename: 'archive.exe',
          mediaType: 'application/pdf'
        }),
      /Unsupported attachment file type/
    )
  })

  it('rejects unsupported extensions even when bytes are available', () => {
    assert.throws(
      () => fileBufferToAttachment({ buffer: Buffer.from('Rar!'), filename: 'archive.rar' }),
      /Unsupported attachment file type/
    )
  })
})
