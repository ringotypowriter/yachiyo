import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import { resolveMarkdownImageSrc } from './markdownImageState.ts'

describe('resolveMarkdownImageSrc', () => {
  it('keeps a resolved local URL only for the remote source that produced it', () => {
    const resolved = {
      sourceSrc: 'https://old.example/image.png',
      resolvedSrc: 'yachiyo-asset://local/?p=%2Ftmp%2Fold.png'
    }

    assert.equal(
      resolveMarkdownImageSrc('https://old.example/image.png', resolved),
      'yachiyo-asset://local/?p=%2Ftmp%2Fold.png'
    )
    assert.equal(
      resolveMarkdownImageSrc('https://new.example/image.png', resolved),
      'https://new.example/image.png'
    )
  })
})
