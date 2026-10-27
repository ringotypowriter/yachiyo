import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { createFakeDesktopServer } from './createFakeDesktopServer.ts'

test('the Remote fixture keeps sync away from the real cloud drive', async () => {
  const fake = await createFakeDesktopServer()
  try {
    assert.equal((await fake.server.getConfig()).sync?.syncDir, join(fake.root, 'disabled-sync'))
  } finally {
    await fake.dispose()
  }
})
