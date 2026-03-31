import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { MessageImageRecord } from '../../../shared/yachiyo/protocol.ts'
import { describeGroupImages } from './groupImageDescriptions.ts'

describe('describeGroupImages', () => {
  it('fills alt text when image-to-text succeeds', async () => {
    const images: MessageImageRecord[] = [
      { dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png' }
    ]

    await describeGroupImages({
      server: {
        getChannelsConfig: () => ({ imageToText: { enabled: true } }),
        getImageToTextService: () => ({
          describe: async () => ({ altText: 'a cat' })
        })
      },
      text: 'look',
      images,
      logLabel: 'test-group'
    })

    assert.equal(images[0].altText, 'a cat')
  })

  it('keeps images intact when image-to-text fails', async () => {
    const images: MessageImageRecord[] = [
      { dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png' }
    ]

    await describeGroupImages({
      server: {
        getChannelsConfig: () => ({ imageToText: { enabled: true } }),
        getImageToTextService: () => ({
          describe: async () => {
            throw new Error('timeout')
          }
        })
      },
      text: 'look',
      images,
      logLabel: 'test-group'
    })

    assert.equal(images[0].altText, undefined)
  })

  it('skips description when image-to-text is disabled', async () => {
    const images: MessageImageRecord[] = [
      { dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png' }
    ]
    let called = false

    await describeGroupImages({
      server: {
        getChannelsConfig: () => ({ imageToText: { enabled: false } }),
        getImageToTextService: () => ({
          describe: async () => {
            called = true
            return { altText: 'unused' }
          }
        })
      },
      text: 'look',
      images,
      logLabel: 'test-group'
    })

    assert.equal(called, false)
    assert.equal(images[0].altText, undefined)
  })
})
