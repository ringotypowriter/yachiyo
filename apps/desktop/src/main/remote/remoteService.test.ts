import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import WebSocket from 'ws'

import { decodePairingUrl } from '@yachiyo/shared/remote/pairing'
import { createFakeDesktopServer } from '@yachiyo/runtime/app/host/remote/testing/createFakeDesktopServer'

import { createInProcessRemotePorts } from './inProcessPorts.ts'
import { generateKeyPair } from './noise/primitives.ts'
import { plaintextSecretBox } from './pairingStore.ts'
import { RemoteService } from './remoteService.ts'
import { runRemoteScenario } from './testing/remoteScenario.ts'
import { RemoteTestClient } from './testing/remoteTestClient.ts'

async function withService(
  fn: (input: { service: RemoteService; endpoint: string; directory: string }) => Promise<void>
): Promise<void> {
  const fake = await createFakeDesktopServer({ chunkDelayMs: 0 })
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-remote-service-'))
  const ports = createInProcessRemotePorts(fake.server)
  let endpoint = ''
  const service = new RemoteService({
    directory: join(directory, 'remote'),
    uploadsDirectory: join(directory, 'uploads'),
    secretBox: plaintextSecretBox,
    server: ports.server,
    host: ports.host,
    subscribe: (listener) => fake.server.subscribe(listener),
    listen: { host: '127.0.0.1', port: 0 },
    deviceName: () => 'Test Mac',
    appVersion: '0.0.0-test',
    endpoints: () => [{ kind: 'lan', url: endpoint }],
    log: () => undefined
  })
  await service.start()
  endpoint = `ws://127.0.0.1:${service.port}/remote/v1`
  try {
    await fn({ service, endpoint, directory })
  } finally {
    await service.stop()
    await fake.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

test('a phone can pair, stream, answer, disconnect, resume, and resync end to end', async () => {
  await withService(async ({ service }) => {
    assert.equal(service.status()?.hubRunning, false, 'no pairing means no event subscription')
    const { url } = await service.createPairingUrl()
    const log: string[] = []
    await runRemoteScenario({ pairingUrl: url, log: (line) => log.push(line) })
    assert.ok(log.some((line) => line.startsWith('resumed from seq')))
    assert.equal(service.status()?.hubRunning, true)
  })
})

test('the pairing token works once and the mailbox secret is stored through the secret box', async () => {
  await withService(async ({ service, directory }) => {
    const { url } = await service.createPairingUrl()
    const first = await RemoteTestClient.pair(url)
    await first.client.call('remote.hello', {
      protocolVersion: 1,
      client: { app: 'test', version: '1' }
    })
    const secret = Buffer.from(first.client.grant!.mailboxSecret, 'base64url')

    await assert.rejects(RemoteTestClient.pair(url), { name: 'HandshakeRejected' })

    const pairings = JSON.parse(await readFile(join(directory, 'remote', 'pairings.json'), 'utf8'))
    assert.equal(pairings.pairings.length, 1)
    assert.equal(pairings.pairings[0].mailboxSecret, secret.toString('base64'))
    await first.client.close()
  })
})

test('an unpaired phone key cannot complete the reconnect handshake', async () => {
  await withService(async ({ service, endpoint }) => {
    const { url } = await service.createPairingUrl()
    const desktopKey = Buffer.from(decodePairingUrl(url).desktopKey, 'base64url')
    await assert.rejects(
      RemoteTestClient.connect(endpoint, { phoneKeyPair: generateKeyPair(), desktopKey }),
      (error: Error) => error.name === 'HandshakeRejected' && error.message === '4401'
    )
  })
})

test('revoking a pairing closes its connection and stops the event subscription', async () => {
  await withService(async ({ service }) => {
    const { url } = await service.createPairingUrl()
    const { client } = await RemoteTestClient.pair(url)
    await client.call('remote.hello', { protocolVersion: 1, client: { app: 'test', version: '1' } })
    const [pairing] = await service.store.list()

    assert.equal(await service.revoke(pairing!.pairingId), true)
    assert.equal(await client.waitForClose(), 4404)
    assert.equal(service.status()?.hubRunning, false)
  })
})

test('the HTTP surface answers 404 to anything but the WebSocket path', async () => {
  await withService(async ({ service }) => {
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: service.port!, path: '/' }, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
        .on('error', reject)
        .end()
    })
    assert.equal(status, 404)

    const socket = new WebSocket(`ws://127.0.0.1:${service.port}/elsewhere`)
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('open'))
      socket.once('unexpected-response', (_request, response) =>
        resolve(String(response.statusCode))
      )
      socket.once('error', () => resolve('error'))
    })
    assert.notEqual(outcome, 'open')
    socket.terminate()
  })
})
