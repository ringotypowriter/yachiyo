import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAppUpdateController,
  type AppUpdateController
} from '../electron/appUpdateController.ts'
import { createAppUpdateCommandHandler } from './appUpdateCommand.ts'

function createController(events: string[]): AppUpdateController {
  return {
    status: async () => ({ state: 'up-to-date', runningVersion: '1.5.1' }),
    prepareApply: async () => {
      events.push('prepare')
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1'
      }
    },
    runUpdaterOperation: (operation) => operation(),
    tryRunUpdaterOperation: (operation) => operation(),
    hasActiveInstallReservation: () => false,
    reservePreparedInstall: () => ({
      install: () => events.push('install'),
      release: () => events.push('release')
    }),
    installPrepared: () => events.push('install')
  }
}

test('prepare reports active runs without installing the prepared update', async () => {
  const events: string[] = []
  const handler = createAppUpdateCommandHandler({
    controller: createController(events),
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self', 'run-other']
  })

  assert.deepEqual(await handler({ action: 'prepare', initiatorRunId: 'run-self' }), {
    result: {
      state: 'restart-required',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1',
      interruptedRunCount: 2,
      blockingRunCount: 1,
      initiatorRunActive: true
    }
  })
  assert.deepEqual(events, ['prepare'])
})

test('install refuses newly active runs by default and never returns an install callback', async () => {
  const events: string[] = []
  let activeRunIds = ['run-self']
  const handler = createAppUpdateCommandHandler({
    controller: createController(events),
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => activeRunIds
  })

  await handler({ action: 'prepare', initiatorRunId: 'run-self' })
  activeRunIds = ['run-self', 'run-other-1', 'run-other-2']

  await assert.rejects(
    () => handler({ action: 'install', force: false, initiatorRunId: 'run-self' }),
    /2 other active Yachiyo runs.*3 including the initiating run.*not installed.*--force/i
  )
  assert.deepEqual(events, ['prepare'])
})

test('forced install reports the exact interrupted count and starts only after the reply', async () => {
  const events: string[] = []
  const handler = createAppUpdateCommandHandler({
    controller: createController(events),
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self', 'run-other-1', 'run-other-2']
  })

  const reply = await handler({
    action: 'install',
    force: true,
    initiatorRunId: 'run-self'
  })

  assert.deepEqual(reply.result, {
    state: 'installing',
    interruptedRunCount: 3,
    initiatorRunInterrupted: true
  })
  assert.deepEqual(events, [])
  reply.afterReply?.()
  assert.deepEqual(events, ['install'])
})

test('install allows the initiating run alone without force and reports its interruption', async () => {
  const events: string[] = []
  const handler = createAppUpdateCommandHandler({
    controller: createController(events),
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self']
  })

  const reply = await handler({
    action: 'install',
    force: false,
    initiatorRunId: 'run-self'
  })

  assert.deepEqual(reply.result, {
    state: 'installing',
    interruptedRunCount: 1,
    initiatorRunInterrupted: true
  })
  reply.afterReply?.()
  assert.deepEqual(events, ['install'])
})

test('install rejects before replying when a failed replacement prepare invalidated the update', async () => {
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
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => []
  })

  await handler({ action: 'prepare' })
  downloadedVersion = undefined
  await assert.rejects(() => handler({ action: 'prepare' }), /download failed/)

  await assert.rejects(() => handler({ action: 'install', force: false }), /not prepared/i)
  assert.equal(installed, false)
})

test('install reserves the prepared update before replying but quits only after the reply', async () => {
  let installed = false
  const controller = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => '1.6.0-beta.1',
    checkForUpdates: async () => {
      throw new Error('a downloaded update must not be checked again')
    },
    downloadUpdate: async () => {
      throw new Error('a downloaded update must not be downloaded again')
    },
    quitAndInstall: () => {
      installed = true
    }
  })
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => []
  })

  await handler({ action: 'prepare' })
  const firstInstall = await handler({ action: 'install', force: false })

  assert.equal(installed, false)
  await assert.rejects(() => handler({ action: 'install', force: false }), /not prepared/i)
  firstInstall.afterReply?.()
  assert.equal(installed, true)
})

test('install releases its reservation when the reply cannot be delivered', async () => {
  let installed = false
  const controller = createAppUpdateController({
    getRunningVersion: () => '1.5.1',
    getDownloadedVersion: () => '1.6.0-beta.1',
    checkForUpdates: async () => {
      throw new Error('a downloaded update must not be checked again')
    },
    downloadUpdate: async () => {
      throw new Error('a downloaded update must not be downloaded again')
    },
    quitAndInstall: () => {
      installed = true
    }
  })
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => []
  })

  await handler({ action: 'prepare' })
  const failedReply = await handler({ action: 'install', force: false })
  await failedReply.onReplyFailure?.()

  const retry = await handler({ action: 'install', force: false })
  retry.afterReply?.()
  assert.equal(installed, true)
})
