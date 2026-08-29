import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import {
  createAppUpdateController,
  type AppUpdateController
} from '../electron/appUpdateController.ts'
import { createAppUpdateCommandHandler as createAppUpdateCommandHandlerImpl } from './appUpdateCommand.ts'

type AppUpdateCommandHandlerInput = Omit<
  Parameters<typeof createAppUpdateCommandHandlerImpl>[0],
  'closeRunAdmissionAndGetActiveRunIds' | 'openRunAdmission'
> &
  Partial<
    Pick<
      Parameters<typeof createAppUpdateCommandHandlerImpl>[0],
      'closeRunAdmissionAndGetActiveRunIds' | 'openRunAdmission'
    >
  >

function createAppUpdateCommandHandler(
  input: AppUpdateCommandHandlerInput
): ReturnType<typeof createAppUpdateCommandHandlerImpl> {
  return createAppUpdateCommandHandlerImpl({
    closeRunAdmissionAndGetActiveRunIds: async () => input.getActiveRunIds(),
    openRunAdmission: async () => {},
    ...input
  })
}

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
    getPreparedVersion: () => '1.1.0',
    installPrepared: () => events.push('install')
  }
}

function createReceipt(): NonNullable<
  Parameters<typeof createAppUpdateCommandHandler>[0]['receipt']
> {
  return {
    resolveOrigin: async () => ({ kind: 'no-channel' as const }),
    persist: () => {},
    clear: () => {},
    announce: async () => {},
    reportInstallFailure: async () => {},
    reportInstallFailureTimeoutMs: 50,
    announceTimeoutMs: 50,
    now: () => 1_760_000_000_000,
    targetVersion: () => '1.6.0-beta.1'
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

test('install closes runtime admission atomically before reserving and keeps it closed after successful quit', async () => {
  const events: string[] = []
  let admissionOpen = true
  const controller = createController(events)
  controller.reservePreparedInstall = () => {
    assert.equal(admissionOpen, false, 'reservation must happen after runtime admission closes')
    events.push('reserve')
    return {
      install: () => events.push('install'),
      release: () => events.push('release')
    }
  }
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => [],
    closeRunAdmissionAndGetActiveRunIds: async () => {
      admissionOpen = false
      events.push('close-admission')
      return []
    },
    openRunAdmission: async () => {
      admissionOpen = true
      events.push('open-admission')
    }
  })

  const reply = await handler({ action: 'install', force: false })
  assert.equal(admissionOpen, false, 'new work stays rejected while the socket reply is pending')
  await reply.afterReply?.()
  assert.equal(admissionOpen, false, 'successful quit keeps admission closed until process exit')
  assert.deepEqual(events, ['close-admission', 'reserve', 'install'])
})

test('install restores runtime admission for blockers, reservation failure, reply failure, and quit failure', async () => {
  const scenarios: Array<{
    name: string
    activeRunIds: string[]
    reserve?: () => never
    finish: (
      reply: Awaited<ReturnType<ReturnType<typeof createAppUpdateCommandHandler>>>
    ) => Promise<void>
  }> = [
    {
      name: 'blockers',
      activeRunIds: ['run-other'],
      finish: async () => {}
    },
    {
      name: 'reservation failure',
      activeRunIds: [],
      reserve: () => {
        throw new Error('reservation failed')
      },
      finish: async () => {}
    },
    {
      name: 'reply failure',
      activeRunIds: [],
      finish: async (reply) => {
        await reply.onReplyFailure?.()
      }
    },
    {
      name: 'synchronous quit failure',
      activeRunIds: [],
      finish: async (reply) => {
        await assert.rejects(() => Promise.resolve(reply.afterReply?.()), /quit failed/)
      }
    }
  ]

  for (const scenario of scenarios) {
    let admissionOpen = true
    let admissionCloseCount = 0
    const controller = createController([])
    if (scenario.reserve) controller.reservePreparedInstall = scenario.reserve
    if (scenario.name === 'synchronous quit failure') {
      controller.reservePreparedInstall = () => ({
        install: () => {
          throw new Error('quit failed')
        },
        release: () => {}
      })
    }
    const handler = createAppUpdateCommandHandler({
      controller,
      getRunningVersion: () => '1.5.1',
      getActiveRunIds: () => scenario.activeRunIds,
      closeRunAdmissionAndGetActiveRunIds: async () => {
        admissionCloseCount += 1
        admissionOpen = false
        return scenario.activeRunIds
      },
      openRunAdmission: async () => {
        admissionOpen = true
      }
    })

    if (scenario.name === 'blockers' || scenario.name === 'reservation failure') {
      await assert.rejects(() => handler({ action: 'install', force: false }))
    } else {
      const reply = await handler({ action: 'install', force: false })
      await scenario.finish(reply)
    }
    assert.equal(admissionCloseCount, 1, `${scenario.name} must use the atomic runtime gate`)
    assert.equal(admissionOpen, true, `${scenario.name} must reopen runtime admission`)
  }
})

test('install keeps the atomic admission snapshot while resolving its receipt origin', async () => {
  const events: string[] = []
  let activeRunIds = ['run-self']
  const controller = createController(events)
  controller.reservePreparedInstall = () => {
    events.push('reserve')
    return {
      install: () => events.push('install'),
      release: () => events.push('release')
    }
  }
  const receipt = createReceipt()
  receipt.resolveOrigin = async () => {
    activeRunIds = ['run-self', 'run-other']
    return {
      kind: 'origin',
      origin: { channelId: 'channel-1', threadId: 'thread-1', messageId: 'message-1' }
    }
  }

  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => activeRunIds,
    receipt
  })

  const reply = await handler({ action: 'install', force: false, initiatorRunId: 'run-self' })
  assert.deepEqual(reply.result, {
    state: 'installing',
    interruptedRunCount: 1,
    initiatorRunInterrupted: true
  })
  assert.deepEqual(events, ['reserve'])
})

test('forced install reports the latest interrupted count and starts only after the reply', async () => {
  const events: string[] = []
  const activeRunIds = ['run-self', 'run-other-1', 'run-other-2']
  const receipt = createReceipt()
  receipt.resolveOrigin = async () => {
    return { kind: 'no-channel' }
  }
  const handler = createAppUpdateCommandHandler({
    controller: createController(events),
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => activeRunIds,
    receipt
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
    getActiveRunIds: () => ['run-self'],
    receipt: createReceipt()
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

test('an initiated install fails before reserving when receipt wiring is missing', async () => {
  let reserved = false
  const controller = createController([])
  controller.reservePreparedInstall = () => {
    reserved = true
    return {
      install: () => {},
      release: () => {}
    }
  }
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self']
  })

  await assert.rejects(
    () => handler({ action: 'install', force: false, initiatorRunId: 'run-self' }),
    /receipt wiring/i
  )
  assert.equal(reserved, false, 'missing production wiring must not claim the install slot')
})

test('a failed command reply withdraws the announcement before clearing its receipt', async () => {
  const events: string[] = []
  const controller = createController(events)
  const receipt = {
    ...createReceipt(),
    resolveOrigin: async () => ({
      kind: 'origin' as const,
      origin: { channelId: 'chan-1', threadId: 'thread-1', messageId: 'msg-1' }
    }),
    persist: () => events.push('persist'),
    announce: async () => {
      events.push('announce')
    },
    reportInstallFailure: async (origin) => {
      events.push(`report-failure:${origin.channelId}:${origin.threadId}:${origin.messageId}`)
    },
    clear: () => events.push('clear')
  }
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self'],
    receipt
  })

  const reply = await handler({ action: 'install', force: false, initiatorRunId: 'run-self' })
  await reply.onReplyFailure?.()

  assert.deepEqual(events, [
    'persist',
    'announce',
    'release',
    'report-failure:chan-1:thread-1:msg-1',
    'clear'
  ])
})

test('a hung install failure correction is bounded and leaves the receipt pending', async () => {
  const events: string[] = []
  const controller = createController(events)
  controller.reservePreparedInstall = () => ({
    install: () => {
      events.push('install')
      throw new Error('quit failed')
    },
    release: () => events.push('release')
  })
  const receipt = {
    ...createReceipt(),
    resolveOrigin: async () => ({
      kind: 'origin' as const,
      origin: { channelId: 'chan-1', threadId: 'thread-1', messageId: 'msg-1' }
    }),
    persist: () => events.push('persist'),
    announce: async () => {
      events.push('announce')
    },
    reportInstallFailure: () => {
      events.push('report-failure')
      return new Promise<void>(() => {})
    },
    reportInstallFailureTimeoutMs: 20,
    clear: () => events.push('clear')
  }
  const handler = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self'],
    receipt
  })

  const reply = await handler({ action: 'install', force: false, initiatorRunId: 'run-self' })
  assert.ok(reply.afterReply)
  await assert.rejects(
    Promise.race([
      Promise.resolve(reply.afterReply()),
      delay(200).then(() => {
        throw new Error('the correction RPC remained pending')
      })
    ]),
    /reporting.*timed out/i
  )
  assert.deepEqual(events, ['persist', 'announce', 'install', 'report-failure'])
})
