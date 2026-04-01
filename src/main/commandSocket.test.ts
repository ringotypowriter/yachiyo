import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { existsSync, unlinkSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { startCommandSocket } from './commandSocket.ts'

function sendToSocket(socketPath: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath, () => {
      client.end(data)
    })
    client.on('close', () => resolve())
    client.on('error', reject)
  })
}

const noopSendChannel = (): void => {}
const noopUpdateChannelGroupStatus = (): void => {}
const TEST_ROOT = '/tmp'

test('commandSocket - receives notification (backward compat, no type field)', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: (input) => received.push(input),
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ title: 'Hello', body: 'World' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0]?.title, 'Hello')
    assert.equal(received[0]?.body, 'World')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - receives typed notification', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: (input) => received.push(input),
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ type: 'notification', title: 'Alert' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0]?.title, 'Alert')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - ignores malformed JSON', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: (input) => received.push(input),
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
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

test('commandSocket - ignores notification without title', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const received: Array<{ title: string; body?: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: (input) => received.push(input),
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
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

test('commandSocket - dispatches send-channel', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const calls: Array<{ id: string; message: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: (input) => calls.push(input),
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(
      socketPath,
      JSON.stringify({ type: 'send-channel', id: 'user-1', message: 'hello' })
    )
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.id, 'user-1')
    assert.equal(calls[0]?.message, 'hello')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - ignores send-channel with missing id', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const calls: Array<{ id: string; message: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: (input) => calls.push(input),
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ type: 'send-channel', message: 'hi' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.length, 0)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - ignores send-channel with missing message', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const calls: Array<{ id: string; message: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: (input) => calls.push(input),
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ type: 'send-channel', id: 'user-1' }))
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.length, 0)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - handles multiple sequential messages', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const notifications: Array<{ title: string; body?: string }> = []
    const channels: Array<{ id: string; message: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: (input) => notifications.push(input),
      onSendChannel: (input) => channels.push(input),
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(socketPath, JSON.stringify({ title: 'First' }))
    await sendToSocket(
      socketPath,
      JSON.stringify({ type: 'send-channel', id: 'g-1', message: 'hey' })
    )
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]?.title, 'First')
    assert.equal(channels.length, 1)
    assert.equal(channels[0]?.id, 'g-1')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - close removes socket file', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(socketPath), 'socket file should exist while server is running')

    await handle.close()
    assert.ok(!existsSync(socketPath), 'socket file should be removed after close')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - healthCheck reports healthy listener', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await handle.healthCheck(), true)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - healthCheck fails when socket path disappears', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })

    await new Promise((r) => setTimeout(r, 50))
    unlinkSync(socketPath)

    assert.equal(await handle.healthCheck(200), false)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - cleans up stale socket file on start', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const handle1 = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
    })
    await new Promise((r) => setTimeout(r, 50))
    await handle1.close()

    const received: Array<{ title: string; body?: string }> = []
    const handle2 = startCommandSocket({
      socketPath,
      onNotification: (input) => received.push(input),
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: noopUpdateChannelGroupStatus
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

test('commandSocket - dispatches update-channel-group-status', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const calls: Array<{ id: string; status: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: (input) => calls.push(input)
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(
      socketPath,
      JSON.stringify({ type: 'update-channel-group-status', id: 'group-1', status: 'approved' })
    )
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.id, 'group-1')
    assert.equal(calls[0]?.status, 'approved')

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('commandSocket - ignores update-channel-group-status with invalid status', async () => {
  const root = await mkdtemp(join(TEST_ROOT, 'yachiyo-cmd-'))
  const socketPath = join(root, 'test.sock')

  try {
    const calls: Array<{ id: string; status: string }> = []
    const handle = startCommandSocket({
      socketPath,
      onNotification: () => {},
      onSendChannel: noopSendChannel,
      onUpdateChannelGroupStatus: (input) => calls.push(input)
    })

    await new Promise((r) => setTimeout(r, 50))
    await sendToSocket(
      socketPath,
      JSON.stringify({ type: 'update-channel-group-status', id: 'group-1', status: 'allowed' })
    )
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.length, 0)

    await handle.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
