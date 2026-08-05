import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { AppUpdateController } from '../electron/appUpdateController.ts'
import { createAppUpdateCommandHandler } from './appUpdateCommand.ts'
import {
  createAppUpdateReplyFinalizer,
  startCommandSocket,
  type CommandSocketOptions
} from './commandSocket.ts'

function request(socketPath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(JSON.stringify(body))
    })
    let response = ''
    client.setEncoding('utf8')
    client.on('data', (chunk: string) => {
      response += chunk
    })
    client.on('end', () => {
      try {
        resolve(JSON.parse(response))
      } catch (error) {
        reject(error)
      }
    })
    client.on('error', reject)
  })
}

function createOptions(socketPath: string): CommandSocketOptions {
  return {
    socketPath,
    onNotification: () => {},
    onSendChannel: () => {},
    onUpdateChannelGroupStatus: () => {},
    onUpdateChannelGroupLabel: () => {},
    onMarkThreadReviewed: () => {}
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(5)
  }
  assert.ok(predicate(), 'timed out waiting for expected condition')
}

test('commandSocket returns an app-update result over a temporary Unix socket', async () => {
  const root = await mkdtemp('/tmp/yachiyo-update-socket-')
  const socketPath = join(root, 'test.sock')
  const options = createOptions(socketPath)
  options.onAppUpdate = async (input) => {
    assert.deepEqual(input, { action: 'status' })
    return {
      result: {
        state: 'available',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1'
      }
    }
  }
  const handle = startCommandSocket(options)

  try {
    const response = await request(socketPath, { type: 'app-update', action: 'status' })
    assert.deepEqual(response, {
      ok: true,
      result: {
        state: 'available',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1'
      }
    })
  } finally {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket flushes the install reply before starting installation', async () => {
  const root = await mkdtemp('/tmp/yachiyo-update-socket-')
  const socketPath = join(root, 'test.sock')
  const events: string[] = []
  const options = createOptions(socketPath)
  options.onAppUpdate = async (input) => {
    assert.deepEqual(input, {
      action: 'install',
      force: true,
      initiatorRunId: 'run-self'
    })
    return {
      result: {
        state: 'installing',
        interruptedRunCount: 2,
        initiatorRunInterrupted: true
      },
      afterReply: () => {
        events.push('install')
      }
    }
  }
  const handle = startCommandSocket(options)

  try {
    const response = await request(socketPath, {
      type: 'app-update',
      action: 'install',
      force: true,
      initiatorRunId: 'run-self'
    })
    events.unshift('reply')

    assert.deepEqual(response, {
      ok: true,
      result: {
        state: 'installing',
        interruptedRunCount: 2,
        initiatorRunInterrupted: true
      }
    })
    assert.deepEqual(events, ['reply', 'install'])
  } finally {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket finalizes a failed reply exactly once without starting installation', async () => {
  const events: string[] = []
  const finalizer = createAppUpdateReplyFinalizer({
    afterReply: () => {
      events.push('install')
    },
    onReplyFailure: async () => {
      events.push('release')
    }
  })

  finalizer.fail()
  finalizer.fail()
  finalizer.complete()
  await Promise.resolve()

  assert.deepEqual(events, ['release'])
})

test('commandSocket returns updater failures instead of dropping the connection', async () => {
  const root = await mkdtemp('/tmp/yachiyo-update-socket-')
  const socketPath = join(root, 'test.sock')
  const options = createOptions(socketPath)
  options.onAppUpdate = async () => {
    throw new Error('Could not reach the update server.')
  }
  const handle = startCommandSocket(options)

  try {
    const response = await request(socketPath, { type: 'app-update', action: 'status' })
    assert.deepEqual(response, { ok: false, error: 'Could not reach the update server.' })
  } finally {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket reports an install failure before clearing the owed receipt', async () => {
  const root = await mkdtemp('/tmp/yachiyo-update-socket-')
  const socketPath = join(root, 'test.sock')
  const events: string[] = []
  const controller: AppUpdateController = {
    status: async () => ({ state: 'up-to-date', runningVersion: '1.5.1' }),
    prepareApply: async () => ({ state: 'up-to-date', runningVersion: '1.5.1' }),
    runUpdaterOperation: (operation) => operation(),
    tryRunUpdaterOperation: (operation) => operation(),
    hasActiveInstallReservation: () => false,
    reservePreparedInstall: () => {
      events.push('reserve')
      return {
        install: () => {
          events.push('install')
          throw new Error('quit failed')
        },
        release: () => events.push('release')
      }
    },
    getPreparedVersion: () => '1.6.0-beta.1',
    installPrepared: () => {
      throw new Error('legacy install path must not run')
    }
  }
  const receipt = {
    resolveOrigin: async () => {
      events.push('resolve')
      return {
        kind: 'origin' as const,
        origin: { channelId: 'chan-1', threadId: 'thread-1', messageId: 'msg-1' }
      }
    },
    persist: () => events.push('persist'),
    clear: () => events.push('clear'),
    announce: async () => {
      events.push('announce')
    },
    reportInstallFailure: async (origin, error) => {
      assert.match(error instanceof Error ? error.message : String(error), /quit failed/)
      events.push(`report-failure:${origin.channelId}:${origin.threadId}:${origin.messageId}`)
    },
    announceTimeoutMs: 50,
    now: () => 1_760_000_000_000,
    targetVersion: () => '1.6.0-beta.1'
  }
  const options = createOptions(socketPath)
  options.onAppUpdate = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self'],
    receipt
  })
  options.onError = (error) => events.push(`error:${error.message}`)
  const handle = startCommandSocket(options)

  try {
    const response = await request(socketPath, {
      type: 'app-update',
      action: 'install',
      force: false,
      initiatorRunId: 'run-self'
    })
    await waitFor(() => events.some((event) => event.startsWith('error:')))

    assert.deepEqual(response, {
      ok: true,
      result: {
        state: 'installing',
        interruptedRunCount: 1,
        initiatorRunInterrupted: true
      }
    })
    assert.deepEqual(events, [
      'resolve',
      'reserve',
      'persist',
      'announce',
      'install',
      'report-failure:chan-1:thread-1:msg-1',
      'clear',
      'error:quit failed'
    ])
  } finally {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})
