import assert from 'node:assert/strict'
import test from 'node:test'

import { buildLegacyQQImageUrl } from './qqImageFallback.ts'

test('buildLegacyQQImageUrl builds the gchatpic URL from a napcat cache path', () => {
  assert.equal(
    buildLegacyQQImageUrl(
      '/app/.config/QQ/nt_qq_7e39cb432a94819c77985edf962d9c4d/nt_data/Pic/2026-07/Ori/89b557b4bc1654492acc5279fadaa2d7.jpeg'
    ),
    'https://gchat.qpic.cn/gchatpic_new/0/0-0-89B557B4BC1654492ACC5279FADAA2D7/0'
  )
})

test('buildLegacyQQImageUrl accepts an uppercase md5 basename without extension', () => {
  assert.equal(
    buildLegacyQQImageUrl('C0A1B2C3D4E5F60718293A4B5C6D7E8F.png'),
    'https://gchat.qpic.cn/gchatpic_new/0/0-0-C0A1B2C3D4E5F60718293A4B5C6D7E8F/0'
  )
})

test('buildLegacyQQImageUrl returns null when the basename is not an md5', () => {
  assert.equal(buildLegacyQQImageUrl('/tmp/some-random-name.jpg'), null)
  assert.equal(buildLegacyQQImageUrl(''), null)
  assert.equal(buildLegacyQQImageUrl('short.jpg'), null)
})
