import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppUpdateController } from './appUpdateController.ts'
import { initiateQuitAndInstall } from './autoUpdateInstall.ts'

test('renderer install operation settles after quit initiation returns', async () => {
  const controller = createAppUpdateController({
    getRunningVersion: () => '1.5.3',
    getDownloadedVersion: () => '1.5.4',
    checkForUpdates: async () => {
      throw new Error('a downloaded update must not be checked again')
    },
    downloadUpdate: async () => {
      throw new Error('a downloaded update must not be downloaded again')
    },
    quitAndInstall: () => {}
  })

  await controller.prepareApply()
  let quitInitiated = false
  const operation = controller.runUpdaterOperation(() =>
    initiateQuitAndInstall(() => {
      quitInitiated = true
    })
  )
  const outcome = await Promise.race([
    operation.then(() => 'settled'),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20))
  ])

  assert.equal(quitInitiated, true)
  assert.equal(outcome, 'settled')
  assert.doesNotThrow(() => controller.reservePreparedInstall())
})

test('renderer install operation rejects when quit initiation throws', async () => {
  await assert.rejects(
    () =>
      initiateQuitAndInstall(() => {
        throw new Error('quit failed')
      }),
    /quit failed/
  )
})
