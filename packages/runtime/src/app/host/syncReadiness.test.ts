import assert from 'node:assert/strict'
import { win32 } from 'node:path'
import test from 'node:test'

import { resolveRecommendedSyncDir, resolveSyncReadiness } from './syncReadiness.ts'

test('Windows recommends a Yachiyo sync folder under the active OneDrive root', () => {
  assert.equal(
    resolveRecommendedSyncDir({
      platform: 'win32',
      homeDir: 'C:\\Users\\Yuki',
      env: { OneDrive: 'D:\\OneDrive - Yachiyo' }
    }),
    win32.join('D:\\OneDrive - Yachiyo', 'Yachiyo', 'Sync')
  )
})

test('Windows accepts OneDriveCommercial and OneDriveConsumer when OneDrive is absent', () => {
  assert.equal(
    resolveRecommendedSyncDir({
      platform: 'win32',
      homeDir: 'C:\\Users\\Yuki',
      env: { OneDriveCommercial: 'C:\\Users\\Yuki\\Contoso' }
    }),
    win32.join('C:\\Users\\Yuki\\Contoso', 'Yachiyo', 'Sync')
  )
  assert.equal(
    resolveRecommendedSyncDir({
      platform: 'win32',
      homeDir: 'C:\\Users\\Yuki',
      env: { OneDriveConsumer: 'C:\\Users\\Yuki\\OneDrive' }
    }),
    win32.join('C:\\Users\\Yuki\\OneDrive', 'Yachiyo', 'Sync')
  )
})

test('custom Windows sync folder remains usable when OneDrive is unavailable', () => {
  const customDir = 'E:\\Shared & Synced\\Yachiyo'
  const report = resolveSyncReadiness(
    { providers: [], sync: { syncDir: customDir } },
    {
      platform: 'win32',
      homeDir: 'C:\\Users\\Yuki',
      env: {},
      pathExists: (path) => path === customDir || path === win32.join(customDir, 'universe.json')
    }
  )

  assert.deepEqual(report, {
    syncDir: customDir,
    recommendedSyncDir: '',
    available: true,
    initialized: true
  })
})
