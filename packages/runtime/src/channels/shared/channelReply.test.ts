import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CHANNEL_REPLY_IMAGE_AS_IMAGE_MAX_BYTES,
  classifyChannelReplyAttachmentDelivery
} from './channelReply.ts'

describe('classifyChannelReplyAttachmentDelivery', () => {
  it('sends images at or below 10 MiB as image messages', () => {
    assert.equal(
      classifyChannelReplyAttachmentDelivery({
        mediaType: 'image/png',
        sizeBytes: CHANNEL_REPLY_IMAGE_AS_IMAGE_MAX_BYTES
      }),
      'image'
    )
  })

  it('sends images above 10 MiB as regular files', () => {
    assert.equal(
      classifyChannelReplyAttachmentDelivery({
        mediaType: 'image/png',
        sizeBytes: CHANNEL_REPLY_IMAGE_AS_IMAGE_MAX_BYTES + 1
      }),
      'file'
    )
  })

  it('uses image filename extensions when a media type is unavailable', () => {
    assert.equal(
      classifyChannelReplyAttachmentDelivery({ filename: 'chart.jpg', sizeBytes: 1024 }),
      'image'
    )
  })

  it('sends non-image attachments as regular files', () => {
    assert.equal(
      classifyChannelReplyAttachmentDelivery({
        filename: 'report.txt',
        mediaType: 'text/plain',
        sizeBytes: 1024
      }),
      'file'
    )
  })
})
