import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Stats } from 'node:fs'

import {
  resolveAssetUrl,
  buildAssetUrl,
  buildAssetCacheHeaders,
  YACHIYO_ASSET_SCHEME
} from './yachiyoAssetProtocol.ts'

describe('yachiyoAssetProtocol.resolveAssetUrl', () => {
  it('resolves a valid absolute png path', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('/Users/alice/pic.png')}`
    const result = resolveAssetUrl(url)
    assert.deepEqual(result, { absPath: '/Users/alice/pic.png', mimeType: 'image/png' })
  })

  it('normalizes `.` and `..` segments for POSIX paths', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('/a/b/../c/./pic.jpg')}`
    const result = resolveAssetUrl(url)
    assert.deepEqual(result, { absPath: '/a/c/pic.jpg', mimeType: 'image/jpeg' })
  })

  it('accepts Windows absolute paths on any host platform', () => {
    // Histories imported or synced from Windows machines must still
    // resolve; we let the filesystem report ENOENT when the file is
    // genuinely missing instead of rejecting the URL upfront.
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('C:\\Users\\alice\\pic.png')}`
    const result = resolveAssetUrl(url)
    assert.ok(result)
    assert.equal(result!.mimeType, 'image/png')
    // win32.normalize collapses backslashes, so the absPath is the
    // canonical Windows form regardless of host OS.
    assert.equal(result!.absPath, 'C:\\Users\\alice\\pic.png')
  })

  it('accepts Windows forward-slash absolute paths', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('C:/Users/alice/pic.png')}`
    const result = resolveAssetUrl(url)
    assert.ok(result)
    assert.equal(result!.mimeType, 'image/png')
  })

  it('collapses `..` segments in Windows paths using win32 normalization', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('C:\\a\\b\\..\\c\\pic.png')}`
    const result = resolveAssetUrl(url)
    assert.ok(result)
    assert.equal(result!.absPath, 'C:\\a\\c\\pic.png')
  })

  it('accepts common image extensions case-insensitively', () => {
    const cases: Array<[string, string]> = [
      ['/x.PNG', 'image/png'],
      ['/x.JPG', 'image/jpeg'],
      ['/x.JPEG', 'image/jpeg'],
      ['/x.webp', 'image/webp'],
      ['/x.svg', 'image/svg+xml'],
      ['/x.gif', 'image/gif'],
      ['/x.avif', 'image/avif']
    ]
    for (const [path, expected] of cases) {
      const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent(path)}`
      assert.equal(resolveAssetUrl(url)?.mimeType, expected, `for ${path}`)
    }
  })

  it('rejects relative paths', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('pic.png')}`
    assert.equal(resolveAssetUrl(url), null)
  })

  it('rejects non-image extensions', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('/etc/passwd')}`
    assert.equal(resolveAssetUrl(url), null)
  })

  it('rejects files without an extension', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://local/?p=${encodeURIComponent('/tmp/binary')}`
    assert.equal(resolveAssetUrl(url), null)
  })

  it('rejects the wrong scheme', () => {
    assert.equal(resolveAssetUrl('https://local/?p=%2Ffoo.png'), null)
    assert.equal(resolveAssetUrl('file:///foo.png'), null)
  })

  it('rejects unknown hosts', () => {
    const url = `${YACHIYO_ASSET_SCHEME}://remote/?p=${encodeURIComponent('/x.png')}`
    assert.equal(resolveAssetUrl(url), null)
  })

  it('rejects missing `p` parameter', () => {
    assert.equal(resolveAssetUrl(`${YACHIYO_ASSET_SCHEME}://local/`), null)
  })

  it('rejects malformed URLs', () => {
    assert.equal(resolveAssetUrl('not-a-url'), null)
  })
})

describe('yachiyoAssetProtocol.buildAssetCacheHeaders', () => {
  function fakeStats(mtimeMs: number, size: number): Stats {
    return { mtime: new Date(mtimeMs), mtimeMs, size } as unknown as Stats
  }

  it('encodes mtime and size into a weak ETag', () => {
    const headers = buildAssetCacheHeaders(fakeStats(1_700_000_000_123, 42))
    assert.equal(headers.etag, 'W/"1700000000123-42"')
  })

  it('floors fractional mtimeMs to avoid ETag churn on unchanged files', () => {
    const headers = buildAssetCacheHeaders(fakeStats(1_700_000_000_123.9, 42))
    assert.equal(headers.etag, 'W/"1700000000123-42"')
  })

  it('changes ETag when mtime changes even if size is the same', () => {
    const a = buildAssetCacheHeaders(fakeStats(1_700_000_000_000, 1024))
    const b = buildAssetCacheHeaders(fakeStats(1_700_000_000_500, 1024))
    assert.notEqual(a.etag, b.etag)
  })

  it('changes ETag when size changes even if mtime is the same', () => {
    const a = buildAssetCacheHeaders(fakeStats(1_700_000_000_000, 1024))
    const b = buildAssetCacheHeaders(fakeStats(1_700_000_000_000, 2048))
    assert.notEqual(a.etag, b.etag)
  })

  it('emits an RFC 7231 HTTP-date for Last-Modified', () => {
    const headers = buildAssetCacheHeaders(fakeStats(Date.UTC(2026, 3, 17, 12, 0, 0), 1))
    assert.equal(headers.lastModified, 'Fri, 17 Apr 2026 12:00:00 GMT')
  })
})

describe('yachiyoAssetProtocol.buildAssetUrl', () => {
  it('round-trips with resolveAssetUrl', () => {
    const input = '/Users/bob/With Spaces & Symbols?.png'
    const url = buildAssetUrl(input)
    assert.ok(url)
    assert.equal(resolveAssetUrl(url!)?.absPath, input)
  })

  it('returns null for relative paths', () => {
    assert.equal(buildAssetUrl('foo/bar.png'), null)
  })
})
