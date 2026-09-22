import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import type { RemoteCommandRequest } from '@yachiyo/shared/remote/command'

import { startCommandSocket } from '../cli/commandSocket.ts'

function request(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let response = ''
    const client = connect(socketPath, () => client.end(JSON.stringify(payload)))
    client.setEncoding('utf8')
    client.on('data', (chunk: string) => (response += chunk))
    client.on('end', () => resolve(JSON.parse(response)))
    client.on('error', reject)
  })
}

test('commandSocket - routes validated remote requests and returns their result', async () => {
  const root = await mkdtemp(join('/tmp', 'yachiyo-cmd-remote-'))
  const socketPath = join(root, 'test.sock')
  const received: RemoteCommandRequest[] = []
  const handle = startCommandSocket({
    socketPath,
    onNotification: () => undefined,
    onSendChannel: () => undefined,
    onUpdateChannelGroupStatus: () => undefined,
    onUpdateChannelGroupLabel: () => undefined,
    onMarkThreadReviewed: () => undefined,
    onRemote: async (input) => {
      received.push(input)
      if (input.action === 'pairings-revoke') throw new Error('Unknown pairing.')
      return { enabled: true }
    }
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(await request(socketPath, { type: 'remote', action: 'status' }), {
      ok: true,
      result: { enabled: true }
    })
    assert.deepEqual(
      await request(socketPath, { type: 'remote', action: 'pairings-revoke', pairingId: 'x' }),
      { ok: false, error: 'Unknown pairing.' }
    )
    assert.deepEqual(await request(socketPath, { type: 'remote', action: 'reboot' }), {
      ok: false,
      error: 'Unsupported remote command.'
    })
    assert.deepEqual(received, [
      { action: 'status' },
      { action: 'pairings-revoke', pairingId: 'x' }
    ])
  } finally {
    await handle.close()
    await rm(root, { recursive: true, force: true })
  }
})
