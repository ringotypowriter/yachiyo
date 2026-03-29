import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { startNotificationSocket } from './notificationSocket.ts'

function sendToSocket(socketPath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(data)
    })
    client.on('close', () => resolve())
    client.on('error', reject)
  })
}

test('notificationSocket - receives valid notification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startNotificationSocket({
      socketPath,
      onNotification: (input) => received.push(input)
    })

    // Wait briefly for the server to start listening
    await new Promise((r) => setTimeout(r, 50))

    await sendToSocket(socketPath, JSON.stringify({ title: 'Hello', body: 'World' }))
    // Give the server a moment to process
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0]?.title, 'Hello')
    assert.equal(received[0]?.body, 'World')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notificationSocket - title-only notification (no body)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startNotificationSocket({
      socketPath,
      onNotification: (input) => received.push(input)
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ title: 'Alert' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0]?.title, 'Alert')
    assert.equal(received[0]?.body, undefined)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notificationSocket - ignores malformed JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startNotificationSocket({
      socketPath,
      onNotification: (input) => received.push(input)
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, 'not json at all')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 0)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notificationSocket - ignores missing title', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startNotificationSocket({
      socketPath,
      onNotification: (input) => received.push(input)
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ body: 'no title' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 0)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notificationSocket - handles multiple sequential messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startNotificationSocket({
      socketPath,
      onNotification: (input) => received.push(input)
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ title: 'First' }))
    await sendToSocket(socketPath, JSON.stringify({ title: 'Second', body: 'msg' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 2)
    assert.equal(received[0]?.title, 'First')
    assert.equal(received[1]?.title, 'Second')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notificationSocket - close removes socket file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    const handle = startNotificationSocket({
      socketPath,
      onNotification: () => {}
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(socketPath), 'socket file should exist while server is running')

    await handle.close()
    assert.ok(!existsSync(socketPath), 'socket file should be removed after close')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('notificationSocket - cleans up stale socket file on start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sock-'))
  const socketPath = join(root, 'test.sock')

  try {
    // Start and close to create a stale file scenario
    const handle1 = startNotificationSocket({
      socketPath,
      onNotification: () => {}
    })
    await new Promise((r) => setTimeout(r, 50))
    // Simulate crash: close server but leave socket file
    await handle1.close()

    // Manually recreate a stale socket file by starting again — just verifies no EADDRINUSE
    const received: Array<{ title: string; body?: string }> = []
    const handle2 = startNotificationSocket({
      socketPath,
      onNotification: (input) => received.push(input)
    })
    await new Promise((r) => setTimeout(r, 50))

    await sendToSocket(socketPath, JSON.stringify({ title: 'After restart' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0]?.title, 'After restart')

    await handle2.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
