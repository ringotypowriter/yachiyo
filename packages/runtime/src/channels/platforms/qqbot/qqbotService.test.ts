import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { MessageImageRecord } from '@yachiyo/shared/protocol'
import { startQQBotImageDownloads } from './qqbotService.ts'

describe('startQQBotImageDownloads', () => {
  it('downloads image attachments from protocol-relative QQ URLs', async () => {
    const image: MessageImageRecord = {
      dataUrl: 'data:image/png;base64,AAA',
      mediaType: 'image/png',
      filename: 'photo.png',
      attachmentIndex: 2
    }
    const calls: Array<{ url: string; options: unknown }> = []

    const downloads = startQQBotImageDownloads(
      [
        {
          contentType: 'application/pdf',
          filename: 'notes.pdf',
          url: '//multimedia.nt.qq.com/download?fileid=file-1'
        },
        {
          contentType: 'image/png',
          filename: 'photo.png',
          url: '//multimedia.nt.qq.com/download?fileid=image-1'
        },
        {
          contentType: 'image/jpeg',
          filename: 'ignored.jpg',
          url: 'https://multimedia.nt.qq.com/download?fileid=image-2'
        }
      ],
      { maxImagesPerBatch: 1, maxImageBytes: 5 * 1024 * 1024 },
      async (url, options) => {
        calls.push({ url, options })
        return image
      }
    )

    assert.deepEqual(await Promise.all(downloads), [{ kind: 'image', image }])
    assert.deepEqual(calls, [
      {
        url: 'https://multimedia.nt.qq.com/download?fileid=image-1',
        options: {
          maxBytes: 5 * 1024 * 1024,
          attachmentIndex: 2,
          filename: 'photo.png'
        }
      }
    ])
  })
})
