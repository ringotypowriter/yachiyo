import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveCommandEndpoint } from '../config/commandEndpoint.ts'
import { startCommandSocket } from './commandSocket.ts'

test(
  'shutdown closes idle command clients before releasing the listener',
  { timeout: 2000 },
  async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'ya-cmd-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const endpoint = resolveCommandEndpoint({ platform: process.platform, yachiyoHome: home })
    const unexpected = (): never => assert.fail('The idle client did not submit a command')
    const server = startCommandSocket({
      endpoint,
      onNotification: unexpected,
      onSendChannel: unexpected,
      onUpdateChannelGroupStatus: unexpected,
      onUpdateChannelGroupLabel: unexpected,
      onMarkThreadReviewed: unexpected
    })
    assert.equal(await server.healthCheck(), true)
    const socket = connect(endpoint.address)
    t.after(() => socket.destroy())
    await once(socket, 'connect')
    socket.resume()
    const disconnected = once(socket, 'close')
    await server.close()
    await disconnected
    assert.equal(await server.healthCheck(), false)
  }
)
