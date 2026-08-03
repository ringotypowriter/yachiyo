import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { defaultApplyAppUpdate, defaultGetAppUpdateStatus } from './appUpdate.ts'

async function startReplyServer(
  socketPath: string,
  reply: (request: { action?: string }) => unknown
): Promise<Server> {
  const server = createServer((connection) => {
    let body = ''
    connection.setEncoding('utf8')
    connection.on('data', (chunk: string) => {
      body += chunk
    })
    connection.on('end', () => {
      const result = reply(JSON.parse(body) as { action?: string })
      connection.end(JSON.stringify({ ok: true, result }))
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

test('defaultGetAppUpdateStatus reads the running App response from a Unix socket', async () => {
  const root = await mkdtemp('/tmp/yachiyo-update-client-')
  const socketPath = join(root, 'test.sock')
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
  const root = await mkdtemp('/tmp/yachiyo-update-client-')
  const socketPath = join(root, 'test.sock')
  let snapshotCount = 0
  const server = await startReplyServer(socketPath, (request) => {
    if (request.action === 'apply') {
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 1
      }
    }
    snapshotCount++
    return { runningVersion: snapshotCount === 1 ? '1.5.1' : '1.6.0-beta.1' }
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
        interruptedRunCount: 1
      }
    )
    assert.equal(snapshotCount, 2)
  } finally {
    await closeServer(server)
    await rm(root, { recursive: true, force: true })
  }
})

test('defaultApplyAppUpdate fails when the restarted process never reaches the target version', async () => {
  const root = await mkdtemp('/tmp/yachiyo-update-client-')
  const socketPath = join(root, 'test.sock')
  const server = await startReplyServer(socketPath, (request) => {
    if (request.action === 'apply') {
      return {
        state: 'restart-required',
        runningVersion: '1.5.1',
        targetVersion: '1.6.0-beta.1',
        interruptedRunCount: 0
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
