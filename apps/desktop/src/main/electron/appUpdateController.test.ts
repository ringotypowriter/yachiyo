import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppUpdateController } from './appUpdateController.ts'

test('appUpdateController reports available, ready, and up-to-date as distinct terminal states', async () => {
  const available = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => undefined,
    checkForUpdates: async () => ({ available: true, version: '1.6.0-beta.1' }),
    downloadUpdate: async () => {},
    quitAndInstall: () => {}
  })
  assert.deepEqual(await available.status(), {
    state: 'available',
    runningVersion: '1.5.1',
    targetVersion: '1.6.0-beta.1'
  })

  const ready = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => '1.6.0-beta.1',
    checkForUpdates: async () => {
      throw new Error('a downloaded update must not be downgraded to merely available')
    },
    downloadUpdate: async () => {},
    quitAndInstall: () => {}
  })
  assert.deepEqual(await ready.status(), {
    state: 'ready',
    runningVersion: '1.5.1',
    targetVersion: '1.6.0-beta.1'
  })

  const current = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => undefined,
    checkForUpdates: async () => ({ available: false, version: '1.5.1' }),
    downloadUpdate: async () => {},
    quitAndInstall: () => {}
  })
  assert.deepEqual(await current.status(), { state: 'up-to-date', runningVersion: '1.5.1' })
})

test('appUpdateController prepares the update before permitting quit-and-install', async () => {
  const events: string[] = []
  const controller = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => undefined,
    checkForUpdates: async () => {
      events.push('check')
      return { available: true, version: '1.6.0-beta.1' }
    },
    downloadUpdate: async () => {
      events.push('download')
    },
    quitAndInstall: () => events.push('install')
  })

  assert.deepEqual(await controller.prepareApply(), {
    state: 'restart-required',
    runningVersion: '1.5.1',
    targetVersion: '1.6.0-beta.1'
  })
  assert.deepEqual(events, ['check', 'download'])

  controller.installPrepared()
  assert.deepEqual(events, ['check', 'download', 'install'])
  assert.throws(() => controller.installPrepared(), /not prepared/i)
})

test('appUpdateController never downloads or installs when the running process is current', async () => {
  let downloaded = false
  let installed = false
  const controller = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => undefined,
    checkForUpdates: async () => ({ available: false, version: '1.5.1' }),
    downloadUpdate: async () => {
      downloaded = true
    },
    quitAndInstall: () => {
      installed = true
    }
  })

  assert.deepEqual(await controller.prepareApply(), {
    state: 'up-to-date',
    runningVersion: '1.5.1'
  })
  assert.equal(downloaded, false)
  assert.throws(() => controller.installPrepared(), /not prepared/i)
  assert.equal(installed, false)
})

test('appUpdateController clears an older prepared update before a failed replacement download', async () => {
  let downloadedVersion: string | undefined = '1.6.0-beta.1'
  let installed = false
  const controller = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => downloadedVersion,
    checkForUpdates: async () => ({ available: true, version: '1.6.0-beta.2' }),
    downloadUpdate: async () => {
      throw new Error('download failed')
    },
    quitAndInstall: () => {
      installed = true
    }
  })

  await controller.prepareApply()
  downloadedVersion = undefined

  await assert.rejects(() => controller.prepareApply(), /download failed/)
  assert.throws(() => controller.installPrepared(), /not prepared/i)
  assert.equal(installed, false)
})
