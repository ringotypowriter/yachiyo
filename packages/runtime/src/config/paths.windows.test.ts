import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveYachiyoDataDir } from './paths.ts'

test('Windows default Yachiyo home uses the native user profile path', () => {
  assert.equal(
    resolveYachiyoDataDir({
      platform: 'win32',
      env: {},
      homeDir: 'C:\\Users\\Yuki'
    }),
    'C:\\Users\\Yuki\\.yachiyo'
  )
})

test('YACHIYO_HOME overrides the Windows default without rewriting the configured path', () => {
  assert.equal(
    resolveYachiyoDataDir({
      platform: 'win32',
      env: { YACHIYO_HOME: 'D:\\Portable & Synced\\Yachiyo Home' },
      homeDir: 'C:\\Users\\Yuki'
    }),
    'D:\\Portable & Synced\\Yachiyo Home'
  )
})
