import assert from 'node:assert/strict'
import test from 'node:test'

// @ts-expect-error plain .mjs script module without type declarations
import { selectReleaseArtifacts, selectStaleReleaseKeys } from './sync-release-to-r2.mjs'

test('selects all platform updater artifacts with manifests last and ignores unrelated files', () => {
  assert.deepEqual(
    selectReleaseArtifacts([
      'yachiyo-1.5.2-setup.exe',
      'yachiyo-1.5.2-setup.exe.blockmap',
      'latest.yml',
      'Yachiyo-1.5.2-arm64-mac.zip',
      'Yachiyo-1.5.2-arm64-mac.zip.blockmap',
      'latest-mac.yml',
      'yachiyo-1.5.2.AppImage',
      'yachiyo-1.5.2.deb',
      'latest-linux.yml',
      'builder-debug.yml',
      'win-unpacked',
      'linux-unpacked',
      'README.txt'
    ]),
    [
      'Yachiyo-1.5.2-arm64-mac.zip',
      'Yachiyo-1.5.2-arm64-mac.zip.blockmap',
      'yachiyo-1.5.2-setup.exe',
      'yachiyo-1.5.2-setup.exe.blockmap',
      'yachiyo-1.5.2.AppImage',
      'yachiyo-1.5.2.deb',
      'latest-mac.yml',
      'latest.yml',
      'latest-linux.yml'
    ]
  )
})

test('selects Linux packages and the Linux updater manifest for a Linux-only sync', () => {
  assert.deepEqual(
    selectReleaseArtifacts(
      [
        'yachiyo-1.5.2.AppImage',
        'yachiyo-1.5.2.deb',
        'latest-linux.yml',
        'yachiyo-1.5.2-setup.exe',
        'latest.yml',
        'Yachiyo-1.5.2-arm64-mac.zip',
        'latest-mac.yml',
        'builder-debug.yml'
      ],
      'linux'
    ),
    ['yachiyo-1.5.2.AppImage', 'yachiyo-1.5.2.deb', 'latest-linux.yml']
  )
})

test('the legacy both selection still means macOS and Windows only', () => {
  assert.deepEqual(
    selectReleaseArtifacts(
      [
        'yachiyo-1.5.2.AppImage',
        'yachiyo-1.5.2.deb',
        'latest-linux.yml',
        'yachiyo-1.5.2-setup.exe',
        'latest.yml',
        'Yachiyo-1.5.2-arm64-mac.zip',
        'latest-mac.yml'
      ],
      'both'
    ),
    ['Yachiyo-1.5.2-arm64-mac.zip', 'yachiyo-1.5.2-setup.exe', 'latest-mac.yml', 'latest.yml']
  )
})

test('selects only macOS updater artifacts for a macOS mirror sync', () => {
  assert.deepEqual(
    selectReleaseArtifacts(
      [
        'yachiyo-1.5.2-setup.exe',
        'yachiyo-1.5.2-setup.exe.blockmap',
        'latest.yml',
        'Yachiyo-1.5.2-arm64-mac.zip',
        'Yachiyo-1.5.2-arm64-mac.zip.blockmap',
        'latest-mac.yml'
      ],
      'macos'
    ),
    ['Yachiyo-1.5.2-arm64-mac.zip', 'Yachiyo-1.5.2-arm64-mac.zip.blockmap', 'latest-mac.yml']
  )
})

test('selects only Windows updater artifacts for a Windows mirror sync', () => {
  assert.deepEqual(
    selectReleaseArtifacts(
      [
        'yachiyo-1.5.2-setup.exe',
        'yachiyo-1.5.2-setup.exe.blockmap',
        'latest.yml',
        'Yachiyo-1.5.2-arm64-mac.zip',
        'Yachiyo-1.5.2-arm64-mac.zip.blockmap',
        'latest-mac.yml'
      ],
      'windows'
    ),
    ['yachiyo-1.5.2-setup.exe', 'yachiyo-1.5.2-setup.exe.blockmap', 'latest.yml']
  )
})

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

test('release retention removes all platform artifacts for the same stale version', () => {
  const keys = [
    'stable/latest-mac.yml',
    'stable/latest.yml',
    'stable/latest-linux.yml',
    'stable/Yachiyo-1.4.0-arm64-mac.zip',
    'stable/Yachiyo-1.4.0-arm64-mac.zip.blockmap',
    'stable/yachiyo-1.4.0-setup.exe',
    'stable/yachiyo-1.4.0-setup.exe.blockmap',
    'stable/yachiyo-1.4.0.AppImage',
    'stable/yachiyo-1.4.0.deb',
    'stable/Yachiyo-1.4.1-arm64-mac.zip',
    'stable/yachiyo-1.4.1-setup.exe',
    'stable/yachiyo-1.4.1.AppImage',
    'stable/yachiyo-1.4.1.deb'
  ]

  assert.deepEqual(selectStaleReleaseKeys(keys, 1).sort(), [
    'stable/Yachiyo-1.4.0-arm64-mac.zip',
    'stable/Yachiyo-1.4.0-arm64-mac.zip.blockmap',
    'stable/yachiyo-1.4.0-setup.exe',
    'stable/yachiyo-1.4.0-setup.exe.blockmap',
    'stable/yachiyo-1.4.0.AppImage',
    'stable/yachiyo-1.4.0.deb'
  ])
})

test('a Linux-only sync never prunes the other platforms unchanged updater binaries', () => {
  assert.deepEqual(
    selectStaleReleaseKeys(
      [
        'nightly/latest-linux.yml',
        'nightly/yachiyo-1.4.0.AppImage',
        'nightly/yachiyo-1.4.0.deb',
        'nightly/yachiyo-1.4.1.AppImage',
        'nightly/yachiyo-1.4.1.deb',
        'nightly/Yachiyo-1.4.0-arm64-mac.zip',
        'nightly/yachiyo-1.4.0-setup.exe',
        'nightly/notes-1.4.0.txt'
      ],
      1,
      'linux'
    ),
    ['nightly/yachiyo-1.4.0.AppImage', 'nightly/yachiyo-1.4.0.deb']
  )
})

test('a legacy both sync preserves Linux artifacts and does not count Linux-only versions', () => {
  assert.deepEqual(
    selectStaleReleaseKeys(
      [
        'nightly/yachiyo-1.4.0.AppImage',
        'nightly/yachiyo-1.4.2.AppImage',
        'nightly/yachiyo-1.4.0-setup.exe',
        'nightly/yachiyo-1.4.1-setup.exe',
        'nightly/Yachiyo-1.4.0-arm64-mac.zip',
        'nightly/Yachiyo-1.4.1-arm64-mac.zip'
      ],
      1,
      'both'
    ),
    ['nightly/yachiyo-1.4.0-setup.exe', 'nightly/Yachiyo-1.4.0-arm64-mac.zip']
  )
})

test('rejects unsupported release platforms', () => {
  assert.throws(() => selectReleaseArtifacts([], 'freebsd'), /Unsupported platform/u)
  assert.throws(() => selectStaleReleaseKeys([], 1, 'freebsd'), /Unsupported platform/u)
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
