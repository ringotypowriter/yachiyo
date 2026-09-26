import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import WebSocket, { WebSocketServer } from 'ws'

import { decodePairingUrl } from '@yachiyo/shared/remote/pairing'
import { REMOTE_NOISE_PROLOGUE } from '@yachiyo/shared/remote/wire'
import { createFakeDesktopServer } from '@yachiyo/runtime/app/host/remote/testing/createFakeDesktopServer'

import { createInProcessRemotePorts } from './inProcessPorts.ts'
import { generateKeyPair } from './noise/primitives.ts'
import { HandshakeState } from './noise/handshake.ts'
import { NoiseTransport } from './noise/transport.ts'
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
    mailboxRoot: null,
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

test('a phone offering every feature runs the same scenario over batches and stream deflate', async () => {
  await withService(async ({ service }) => {
    const { url } = await service.createPairingUrl()
    const log: string[] = []
    await runRemoteScenario({
      pairingUrl: url,
      features: ['handshake-hello', 'event-batch', 'stream-deflate'],
      log: (line) => log.push(line)
    })
    assert.ok(log.some((line) => line.startsWith('resumed from seq')))

    const probe = await RemoteTestClient.pair((await service.createPairingUrl()).url, {
      features: ['handshake-hello', 'event-batch', 'stream-deflate']
    })
    assert.deepEqual(probe.client.features, ['handshake-hello', 'event-batch', 'stream-deflate'])
    assert.equal(probe.client.handshake?.hello?.deviceName, 'Test Mac')
    await probe.client.close()
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

for (const compression of [false, true]) {
  test(`large RPC messages survive pairing and reconnect with compression ${compression ? 'enabled' : 'disabled'}`, async () => {
    await withService(async ({ service }) => {
      const paired = await RemoteTestClient.pair((await service.createPairingUrl()).url, {
        compression
      })
      let client = paired.client
      try {
        assert.equal(client.compression, compression ? 'gzip' : undefined)
        await client.call('remote.hello', {
          protocolVersion: 1,
          client: { app: 'test', version: '1' }
        })
        assert.ok(client.grant)
        const content = 'Remote compression preserves UTF-8: 八千代 🌸\n'.repeat(1000).trim()
        const { thread, accepted } = await client.call<{
          thread: { id: string }
          accepted: { userMessage: { content: string } }
        }>('chat.startThread', {
          content
        })
        assert.equal(accepted.userMessage.content, content)
        const largeFrames = client.frames.filter((frame) => frame.jsonBytes > 10_000)
        for (const direction of ['sent', 'received']) {
          const frame = largeFrames.find((frame) => frame.direction === direction)
          assert.ok(frame, `missing large ${direction} frame`)
          if (compression) assert.ok(frame.encodedBytes < frame.jsonBytes / 2)
          else assert.equal(frame.encodedBytes, frame.jsonBytes)
        }
        await client.close()
        client = await RemoteTestClient.connect(paired.endpoint, { ...paired, compression })
        assert.equal(client.compression, compression ? 'gzip' : undefined)
        const [detail, hello] = await Promise.all([
          client.call<{ messages: Array<{ content: string }> }>('threads.load', {
            threadId: thread.id
          }),
          client.call<{ protocolVersion: number }>('remote.hello', {
            protocolVersion: 1,
            client: { app: 'test', version: '1' }
          })
        ])
        assert.ok(detail.messages.some((message) => message.content === content))
        assert.equal(hello.protocolVersion, 1)
        assert.equal(client.closeCode, null)
      } finally {
        if (client.closeCode === null) await client.close()
      }
    })
  })
}

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

test('a compression-capable client falls back to unchanged JSON with a legacy desktop', async () => {
  const keyPair = generateKeyPair()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  server.on('connection', (socket) => {
    const handshake = HandshakeState.responder({
      pattern: 'IK',
      prologue: Buffer.from(REMOTE_NOISE_PROLOGUE),
      staticKeyPair: keyPair
    })
    let noise: NoiseTransport | undefined
    socket.on('message', (frame: Buffer) => {
      if (!noise) {
        const offer = JSON.parse(handshake.readMessage(frame.subarray(1)).toString())
        assert.deepEqual(offer.compression, ['gzip'])
        socket.send(handshake.writeMessage(Buffer.alloc(0)))
        noise = new NoiseTransport(handshake.split())
        return
      }
      const plaintext = noise.decrypt(frame)
      assert.equal(plaintext[0], 0x7b, 'legacy peer must receive original JSON')
      const request = JSON.parse(plaintext.toString())
      socket.send(
        noise.encrypt(
          Buffer.from(
            JSON.stringify({
              kind: 'rpc:response',
              id: request.id,
              ok: true,
              value: request.args[0]
            })
          )
        )
      )
    })
  })
  let client: RemoteTestClient | undefined
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    client = await RemoteTestClient.connect(`ws://127.0.0.1:${address.port}`, {
      phoneKeyPair: generateKeyPair(),
      desktopKey: keyPair.publicKey
    })
    assert.equal(client.compression, undefined)
    const input = { content: 'legacy UTF-8 🌸'.repeat(1000) }
    assert.deepEqual(await client.call('legacy.echo', input), input)
    assert.ok(client.frames.every((frame) => frame.jsonBytes === frame.encodedBytes))
  } finally {
    if (client) await client.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
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
