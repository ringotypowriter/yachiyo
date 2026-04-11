import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  buildAssetUrl,
  isAbsolutePathLike,
  isAssetUrl,
  isRemoteImageUrl,
  transformImageSrc,
  YACHIYO_ASSET_SCHEME
} from './imageUrl.ts'

describe('imageUrl.isAbsolutePathLike', () => {
  it('accepts POSIX absolute paths', () => {
    assert.equal(isAbsolutePathLike('/foo/bar.png'), true)
  })

  it('accepts Windows drive-prefixed paths', () => {
    assert.equal(isAbsolutePathLike('C:\\foo\\bar.png'), true)
    assert.equal(isAbsolutePathLike('D:/x/y.jpg'), true)
  })

  it('rejects relative paths', () => {
    assert.equal(isAbsolutePathLike('foo.png'), false)
    assert.equal(isAbsolutePathLike('./foo.png'), false)
    assert.equal(isAbsolutePathLike('../foo.png'), false)
  })

  it('rejects empty strings', () => {
    assert.equal(isAbsolutePathLike(''), false)
  })
})

describe('imageUrl.transformImageSrc', () => {
  it('passes https URLs through unchanged', () => {
    const url = 'https://example.com/pic.png'
    assert.equal(transformImageSrc(url), url)
  })

  it('passes http URLs through unchanged', () => {
    const url = 'http://example.com/pic.png'
    assert.equal(transformImageSrc(url), url)
  })

  it('passes data:image/* URLs through unchanged', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    assert.equal(transformImageSrc(url), url)
  })

  it('passes yachiyo-asset:// URLs through unchanged', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=%2Ffoo.png`
    assert.equal(transformImageSrc(url), url)
  })

  it('rewrites absolute paths to the asset scheme', () => {
    const out = transformImageSrc('/Users/alice/pic.png')
    assert.equal(out, buildAssetUrl('/Users/alice/pic.png'))
  })

  it('decodes percent-escaped POSIX paths with spaces', () => {
    // A spaced path like `/Users/alice/with space.png` survives through
    // an angle-bracketed markdown destination as `%2FUsers%2Falice%2F...`
    // or, more commonly, `/Users/alice/with%20space.png`. Both should
    // resolve to the same decoded absolute path.
    const out = transformImageSrc('/Users/alice/with%20space.png')
    assert.equal(out, buildAssetUrl('/Users/alice/with space.png'))
  })

  it('decodes percent-escaped Windows backslash paths', () => {
    // Markdown parsers percent-encode backslashes in angle-bracketed
    // destinations, so `![x](<C:\foo\bar.png>)` arrives here as
    // `C:%5Cfoo%5Cbar.png`. This must still resolve.
    const out = transformImageSrc('C:%5Cfoo%5Cbar.png')
    assert.equal(out, buildAssetUrl('C:\\foo\\bar.png'))
  })

  it('handles Windows forward-slash absolute paths without decoding', () => {
    const out = transformImageSrc('C:/foo/bar.png')
    assert.equal(out, buildAssetUrl('C:/foo/bar.png'))
  })

  it('drops file:// URLs', () => {
    assert.equal(transformImageSrc('file:///Users/alice/pic.png'), null)
  })

  it('drops javascript: URLs', () => {
    assert.equal(transformImageSrc('javascript:alert(1)'), null)
  })

  it('drops relative paths', () => {
    assert.equal(transformImageSrc('pic.png'), null)
    assert.equal(transformImageSrc('./pic.png'), null)
    assert.equal(transformImageSrc('../pic.png'), null)
  })

  it('drops empty input', () => {
    assert.equal(transformImageSrc(''), null)
    assert.equal(transformImageSrc('   '), null)
  })

  it('drops non-image data URLs', () => {
    assert.equal(transformImageSrc('data:text/html;base64,PHNjcmlwdD4='), null)
  })
})

describe('imageUrl.isRemoteImageUrl', () => {
  it('detects http and https', () => {
    assert.equal(isRemoteImageUrl('http://x.com/a.png'), true)
    assert.equal(isRemoteImageUrl('https://x.com/a.png'), true)
    assert.equal(isRemoteImageUrl('HTTP://x.com/a.png'), true)
  })

  it('rejects other schemes', () => {
    assert.equal(isRemoteImageUrl('data:image/png;base64,AAAA'), false)
    assert.equal(isRemoteImageUrl(`${YACHIYO_ASSET_SCHEME}://local/?p=%2Fa.png`), false)
  })
})

describe('imageUrl.isAssetUrl', () => {
  it('detects the scheme', () => {
    assert.equal(isAssetUrl(`${YACHIYO_ASSET_SCHEME}://local/?p=%2Fa.png`), true)
  })

  it('rejects other schemes', () => {
    assert.equal(isAssetUrl('https://x.com/a.png'), false)
  })
})
