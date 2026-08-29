import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import type { AppUpdateController } from '../electron/appUpdateController.ts'
import { createAppUpdateCommandHandler } from './appUpdateCommand.ts'
import {
  createAppUpdateReplyFinalizer,
  startCommandSocket,
  type AppUpdateCommandReply,
  type CommandSocketOptions,
  writeAppUpdateReply
} from './commandSocket.ts'

async function createTestSocketFixture(): Promise<{ root: string; socketPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-socket-'))
  return {
    root,
    socketPath:
      process.platform === 'win32' ? `\\\\.\\pipe\\${basename(root)}` : join(root, 'test.sock')
  }
}

function request(socketPath: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.write(`${JSON.stringify(body)}\n`)
    })
    let response = ''
    client.setEncoding('utf8')
    client.setTimeout(1_000)
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
    client.on('timeout', () => {
      client.destroy()
      reject(new Error('Timed out waiting for command socket response.'))
    })
    client.on('error', reject)
  })
}

function createOptions(socketPath: string): CommandSocketOptions {
  return {
    ...(process.platform === 'win32'
      ? { endpoint: { kind: 'windows-pipe' as const, address: socketPath } }
      : { socketPath }),
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

test('commandSocket returns an app-update result over local IPC', async () => {
  const { root, socketPath } = await createTestSocketFixture()
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
  const { root, socketPath } = await createTestSocketFixture()
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

test('commandSocket does not complete an app-update finalizer when the reply write fails', async () => {
  const events: string[] = []
  const finalizer = createAppUpdateReplyFinalizer({
    afterReply: () => {
      events.push('install')
    },
    onReplyFailure: () => {
      events.push('release')
    }
  })
  const emitter = new EventEmitter()
  const connection = Object.assign(emitter, {
    end(payload: string): void {
      assert.match(payload, /"state":"installing"/u)
      emitter.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    }
  })
  connection.on('error', finalizer.fail)

  writeAppUpdateReply(
    connection,
    {
      ok: true,
      result: {
        state: 'installing',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    },
    finalizer
  )
  await Promise.resolve()

  assert.deepEqual(events, ['release'])
})

test('commandSocket releases a pending install when the framed client disconnects', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const events: string[] = []
  let handlerStarted = false
  let resolveReply!: (reply: AppUpdateCommandReply) => void
  const pendingReply = new Promise<AppUpdateCommandReply>((resolve) => {
    resolveReply = resolve
  })
  const options = createOptions(socketPath)
  options.onAppUpdate = async () => {
    handlerStarted = true
    return pendingReply
  }
  const handle = startCommandSocket(options)
  const client = connect(socketPath, () => {
    client.write(`${JSON.stringify({ type: 'app-update', action: 'install', force: true })}\n`)
  })
  let clientClosed = false
  client.once('close', () => {
    clientClosed = true
  })

  try {
    await waitFor(() => handlerStarted)
    client.destroy()
    await waitFor(() => clientClosed)
    await delay(100)
    resolveReply({
      result: {
        state: 'installing',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      },
      afterReply: () => {
        events.push('install')
      },
      onReplyFailure: () => {
        events.push('release')
      }
    })
    await waitFor(() => events.length > 0)

    assert.deepEqual(events, ['release'])
  } finally {
    client.destroy()
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket returns updater failures instead of dropping the connection', async () => {
  const { root, socketPath } = await createTestSocketFixture()
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
  const { root, socketPath } = await createTestSocketFixture()
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
    reportInstallFailureTimeoutMs: 50,
    announceTimeoutMs: 50,
    now: () => 1_760_000_000_000,
    targetVersion: () => '1.6.0-beta.1'
  }
  const options = createOptions(socketPath)
  options.onAppUpdate = createAppUpdateCommandHandler({
    controller,
    getRunningVersion: () => '1.5.1',
    getActiveRunIds: () => ['run-self'],
    closeRunAdmissionAndGetActiveRunIds: async () => {
      events.push('close-admission')
      return ['run-self']
    },
    openRunAdmission: async () => {
      events.push('open-admission')
    },
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
      'close-admission',
      'resolve',
      'reserve',
      'persist',
      'announce',
      'install',
      'open-admission',
      'report-failure:chan-1:thread-1:msg-1',
      'clear',
      'error:quit failed'
    ])
  } finally {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})
