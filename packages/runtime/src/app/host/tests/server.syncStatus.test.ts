import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveSyncReadiness } from '../syncReadiness.ts'

test('sync readiness treats a saved recommended iCloud path as the default sync path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sync-status-'))
  const originalHome = process.env['HOME']
  const home = join(root, 'home')
  const iCloudRoot = join(home, 'Library/Mobile Documents/com~apple~CloudDocs')
  const recommendedSyncDir = join(iCloudRoot, 'Documents/Yachiyo/Sync')

  process.env['HOME'] = home

  try {
    const status = resolveSyncReadiness(
      { providers: [], sync: { syncDir: recommendedSyncDir } },
      (path) => path === iCloudRoot
    )
    assert.equal(status.syncDir, recommendedSyncDir)
    assert.equal(status.available, true)
    assert.equal(status.initialized, false)
  } finally {
    if (originalHome == null) {
      delete process.env['HOME']
    } else {
      process.env['HOME'] = originalHome
    }
    await rm(root, { recursive: true, force: true })
  }
})
