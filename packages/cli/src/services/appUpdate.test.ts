import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { defaultApplyAppUpdate, defaultGetAppUpdateStatus } from './appUpdate.ts'

const NO_REPLY = Symbol('no reply')

async function createTestSocketFixture(): Promise<{ root: string; socketPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-update-client-'))
  return {
    root,
    socketPath:
      process.platform === 'win32' ? `\\\\.\\pipe\\${basename(root)}` : join(root, 'test.sock')
  }
}

async function startReplyServer(
  socketPath: string,
  reply: (request: { action?: string; force?: boolean; initiatorRunId?: string }) => unknown
): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (connection) => {
    let body = ''
    let handled = false

    const handleRequest = (): void => {
      if (handled) return
      handled = true
      const result = reply(
        JSON.parse(body) as { action?: string; force?: boolean; initiatorRunId?: string }
      )
      if (result === undefined) {
        connection.end()
        return
      }
      if (result === NO_REPLY) {
        setTimeout(() => connection.destroy(), 50)
        return
      }
      connection.end(JSON.stringify({ ok: true, result }))
    }

    connection.setEncoding('utf8')
    connection.setTimeout(1_000, () => connection.destroy())
    connection.on('data', (chunk: string) => {
      body += chunk
      if (body.endsWith('\n')) handleRequest()
    })
    connection.on('end', () => {
      if (handled) return
      if (process.platform === 'win32') {
        connection.destroy()
        return
      }
      handleRequest()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return server
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

test('defaultGetAppUpdateStatus reads the running App response from local IPC', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const server = await startReplyServer(socketPath, (request) => {
    assert.equal(request.action, 'status')
    return {
      state: 'ready',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1'
    }
  })

  try {
    assert.deepEqual(await defaultGetAppUpdateStatus(socketPath), {
      state: 'ready',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1'
    })
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate succeeds only after the relaunched process reports the target version', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  let snapshotCount = 0
  const actions: string[] = []
  const server = await startReplyServer(socketPath, (request) => {
    actions.push(request.action ?? '')
    if (request.action === 'prepare') {
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 1,
        blockingRunCount: 1,
        initiatorRunActive: false
      }
    }
    if (request.action === 'install') {
      assert.equal(request.force, true)
      assert.equal(request.initiatorRunId, undefined)
      return {
        state: 'installing',
        interruptedRunCount: 2,
        initiatorRunInterrupted: false
      }
    }
    snapshotCount++
    return { runningVersion: snapshotCount === 1 ? '1.5.1' : '1.6.0-beta.1' }
  })

  try {
    assert.deepEqual(
      await defaultApplyAppUpdate(socketPath, {
        force: true,
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1
      }),
      {
        state: 'updated',
        previousVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        runningVersion: '1.6.0-beta.1',
        interruptedRunCount: 2,
        initiatorRunInterrupted: false
      }
    )
    assert.equal(snapshotCount, 2)
    assert.deepEqual(actions, ['prepare', 'install', 'snapshot', 'snapshot'])
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate fails when the restarted process never reaches the target version', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const server = await startReplyServer(socketPath, (request) => {
    if (request.action === 'prepare') {
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        blockingRunCount: 0,
        initiatorRunActive: false
      }
    }
    if (request.action === 'install') {
      return {
        state: 'installing',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    }
    return { runningVersion: '1.5.1' }
  })

  try {
    await assert.rejects(
      () =>
        defaultApplyAppUpdate(socketPath, {
          restartTimeoutMs: 20,
          pollIntervalMs: 1
        }),
      /did not restart on target version 1\.6\.0-beta\.1/i
    )
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate retries an empty socket reply while the App is restarting', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  let snapshotCount = 0
  const server = await startReplyServer(socketPath, (request) => {
    if (request.action === 'prepare') {
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        blockingRunCount: 0,
        initiatorRunActive: false
      }
    }
    if (request.action === 'install') {
      return {
        state: 'installing',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    }
    snapshotCount++
    return snapshotCount === 1 ? undefined : { runningVersion: '1.6.0-beta.1' }
  })

  try {
    assert.deepEqual(
      await defaultApplyAppUpdate(socketPath, {
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1
      }),
      {
        state: 'updated',
        previousVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        runningVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    )
    assert.equal(snapshotCount, 2)
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate retries a snapshot timeout while the App is restarting', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  let snapshotCount = 0
  const server = await startReplyServer(socketPath, (request) => {
    if (request.action === 'prepare') {
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        blockingRunCount: 0,
        initiatorRunActive: false
      }
    }
    if (request.action === 'install') {
      return {
        state: 'installing',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    }
    snapshotCount++
    return snapshotCount === 1 ? NO_REPLY : { runningVersion: '1.6.0-beta.1' }
  })

  try {
    assert.deepEqual(
      await defaultApplyAppUpdate(socketPath, {
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1,
        snapshotRequestTimeoutMs: 20
      }),
      {
        state: 'updated',
        previousVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        runningVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    )
    assert.equal(snapshotCount, 2)
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate refuses active runs without force and never requests installation', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const actions: string[] = []
  const server = await startReplyServer(socketPath, (request) => {
    actions.push(request.action ?? '')
    return {
      state: 'restart-required',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1',
      interruptedRunCount: 3,
      blockingRunCount: 3,
      initiatorRunActive: false
    }
  })

  try {
    await assert.rejects(
      () => defaultApplyAppUpdate(socketPath),
      /3 active Yachiyo runs.*not installed.*--force/i
    )
    assert.deepEqual(actions, ['prepare'])
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate allows the initiating run alone without force', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const actions: string[] = []
  const server = await startReplyServer(socketPath, (request) => {
    actions.push(request.action ?? '')
    if (request.action === 'prepare') {
      assert.equal(request.initiatorRunId, 'run-self')
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 1,
        blockingRunCount: 0,
        initiatorRunActive: true
      }
    }
    if (request.action === 'install') {
      assert.equal(request.initiatorRunId, 'run-self')
      assert.equal(request.force, false)
      return {
        state: 'installing',
        interruptedRunCount: 1,
        initiatorRunInterrupted: true
      }
    }
    return { runningVersion: '1.6.0-beta.1' }
  })

  try {
    assert.deepEqual(
      await defaultApplyAppUpdate(socketPath, {
        initiatorRunId: 'run-self',
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1
      }),
      {
        state: 'restart-started',
        previousVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 1,
        initiatorRunInterrupted: true
      }
    )
    assert.deepEqual(actions, ['prepare', 'install'])
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate keeps internal background updates honest after the initiating run ends', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const actions: string[] = []
  const server = await startReplyServer(socketPath, (request) => {
    actions.push(request.action ?? '')
    if (request.action === 'prepare') {
      assert.equal(request.initiatorRunId, 'run-finished')
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        blockingRunCount: 0,
        initiatorRunActive: false
      }
    }
    if (request.action === 'install') {
      return {
        state: 'installing',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    }
    return { runningVersion: '1.6.0-beta.1' }
  })

  try {
    assert.deepEqual(
      await defaultApplyAppUpdate(socketPath, {
        initiatorRunId: 'run-finished',
        restartTimeoutMs: 1_000,
        pollIntervalMs: 1
      }),
      {
        state: 'restart-started',
        previousVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 0,
        initiatorRunInterrupted: false
      }
    )
    assert.deepEqual(actions, ['prepare', 'install'])
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate still refuses other active runs when an initiator is present', async () => {
  const { root, socketPath } = await createTestSocketFixture()
  const actions: string[] = []
  const server = await startReplyServer(socketPath, (request) => {
    actions.push(request.action ?? '')
    return {
      state: 'restart-required',
      runningVersion: '1.5.1',
      targetVersion: '1.6.0-beta.1',
      interruptedRunCount: 2,
      blockingRunCount: 1,
      initiatorRunActive: true
    }
  })

  try {
    await assert.rejects(
      () => defaultApplyAppUpdate(socketPath, { initiatorRunId: 'run-self' }),
      /1 other active Yachiyo run.*2 including the initiating run.*not installed.*--force/i
    )
    assert.deepEqual(actions, ['prepare'])
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})
