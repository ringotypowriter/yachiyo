import assert from 'node:assert/strict'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { selectStaleReleaseKeys } from './sync-release-to-r2.mjs'

test('keeps the newest nightly versions and returns older keys for deletion', () => {
  const keys = [
    'nightly/latest-mac.yml',
    'nightly/Yachiyo-1.4.2-beta.202607140000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607140000-arm64-mac.zip.blockmap',
    'nightly/Yachiyo-1.4.2-beta.202607150000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607150000-arm64-mac.zip.blockmap',
    'nightly/Yachiyo-1.4.2-beta.202607160000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607170000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607180000-arm64-mac.zip'
  ]
  const stale = selectStaleReleaseKeys(keys, 3)
  assert.deepEqual(stale.sort(), [
    'nightly/Yachiyo-1.4.2-beta.202607140000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607140000-arm64-mac.zip.blockmap',
    'nightly/Yachiyo-1.4.2-beta.202607150000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607150000-arm64-mac.zip.blockmap'
  ])
})

test('a version patch bump outranks an older timestamp grouping', () => {
  const keys = [
    'nightly/Yachiyo-1.4.3-beta.202607010000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607180000-arm64-mac.zip'
  ]
  // a 1.4.3 nightly is always newer than the 1.4.2 line, whatever the timestamps say
  const stale = selectStaleReleaseKeys(keys, 1)
  assert.deepEqual(stale, ['nightly/Yachiyo-1.4.2-beta.202607180000-arm64-mac.zip'])
})

test('keeps only the newest stable version when keep is 1', () => {
  const keys = [
    'stable/latest-mac.yml',
    'stable/Yachiyo-1.4.0-arm64-mac.zip',
    'stable/Yachiyo-1.4.1-arm64-mac.zip',
    'stable/Yachiyo-1.4.1-arm64-mac.zip.blockmap'
  ]
  const stale = selectStaleReleaseKeys(keys, 1)
  assert.deepEqual(stale, ['stable/Yachiyo-1.4.0-arm64-mac.zip'])
})

test('never selects keys without a parsable version', () => {
  const keys = ['nightly/latest-mac.yml', 'nightly/README.txt']
  assert.deepEqual(selectStaleReleaseKeys(keys, 1), [])
})

test('returns nothing when versions fit within the keep budget', () => {
  const keys = [
    'nightly/Yachiyo-1.4.2-beta.202607170000-arm64-mac.zip',
    'nightly/Yachiyo-1.4.2-beta.202607180000-arm64-mac.zip'
  ]
  assert.deepEqual(selectStaleReleaseKeys(keys, 5), [])
})
