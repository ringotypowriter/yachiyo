import assert from 'node:assert/strict'
import { posix } from 'node:path'
import test from 'node:test'
import { resolveSyncReadiness } from '../syncReadiness.ts'

test('sync readiness treats a saved recommended iCloud path as the default sync path', () => {
  const home = '/Users/tester'
  const iCloudRoot = posix.join(home, 'Library/Mobile Documents/com~apple~CloudDocs')
  const recommendedSyncDir = posix.join(iCloudRoot, 'Documents/Yachiyo/Sync')

  const status = resolveSyncReadiness(
    { providers: [], sync: { syncDir: recommendedSyncDir } },
    {
      platform: 'darwin',
      homeDir: home,
      pathExists: (path) => path === iCloudRoot
    }
  )
  assert.equal(status.syncDir, recommendedSyncDir)
  assert.equal(status.available, true)
  assert.equal(status.initialized, false)
})
