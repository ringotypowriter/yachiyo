import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { MessageImageRecord } from '@yachiyo/shared/protocol'
import { describeGroupImages } from './groupImageDescriptions.ts'

describe('describeGroupImages', () => {
  it('does not describe already enriched images again', async () => {
    const images = [{ dataUrl: '', mediaType: 'image/png', altText: 'a cat' }]
    await describeGroupImages({
      server: {
        getChannelsConfig: () => ({ imageToText: { enabled: true } }),
        getImageToTextService: () => ({
          describe: async () => {
            assert.fail('already described')
          }
        })
      },
      text: '',
      images,
      logLabel: 'test-group'
    })
    assert.equal(images[0]?.altText, 'a cat')
  })
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

  it('removes images when image-to-text fails', async () => {
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

    assert.deepEqual(images, [])
  })

  it('removes images when image-to-text is disabled', async () => {
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
    assert.deepEqual(images, [])
  })
})
