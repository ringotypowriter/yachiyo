import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { decodePairingUrl } from '@yachiyo/shared/remote/pairing'
import { createFakeDesktopServer } from '@yachiyo/runtime/app/host/remote/testing/createFakeDesktopServer'

import { createInProcessRemotePorts } from './inProcessPorts.ts'
import { plaintextSecretBox } from './pairingStore.ts'
import { RelayActivation } from './relayActivation.ts'
import { RemoteService } from './remoteService.ts'
import { RemoteTestClient } from './testing/remoteTestClient.ts'

/** Opt-in real Bun backend: RELAY_BACKEND_DIR=<relay checkout> pnpm run test:remote. */
test(
  'real relay invitation, Noise pairing, permanent reconnect and revoke',
  {
    skip: !process.env.RELAY_BACKEND_DIR
  },
  async () => {
    const backend = process.env.RELAY_BACKEND_DIR!
    const holder = createServer()
    holder.listen(0, '127.0.0.1')
    await once(holder, 'listening')
    const port = (holder.address() as { port: number }).port
    await new Promise<void>((resolve) => holder.close(() => resolve()))
    const origin = `http://127.0.0.1:${port}`
    const server = 'https://relay.example'
    const hostKey = randomBytes(32).toString('base64url')
    const invite = randomBytes(32).toString('base64url')
    const child = spawn('bun', ['src/main.ts'], {
      cwd: backend,
      env: {
        ...process.env,
        PORT: String(port),
        RELAY_HOSTS: JSON.stringify([{ id: 'mac-1', key: hostKey }]),
        RELAY_INVITES: JSON.stringify([{ code: invite, hostId: 'mac-1' }])
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const dir = await mkdtemp(join(tmpdir(), 'yachiyo-relay-acceptance-'))
    let service: RemoteService | null = null
    let fake: Awaited<ReturnType<typeof createFakeDesktopServer>> | null = null
    let deferPermanentPut = false
    let putStarted: (() => void) | null = null
    const putGate: { release?: () => void } = {}
    const localFetch: typeof fetch = async (url, init) => {
      if (
        deferPermanentPut &&
        init?.method === 'PUT' &&
        /\/phones\/[0-9a-f-]{36}$/.test(String(url))
      ) {
        putStarted?.()
        await new Promise<void>((resolve) => {
          putGate.release = resolve
        })
      }
      return fetch(String(url).replace(server, origin), init)
    }
    try {
      for (let i = 0; i < 50; i++) {
        try {
          if ((await fetch(`${origin}/health`)).ok) break
        } catch {
          /* startup */
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.equal((await fetch(`${origin}/health`)).status, 200, 'real Bun relay started')
      const activation = new RelayActivation(join(dir, 'remote'), plaintextSecretBox, localFetch)
      assert.deepEqual(await activation.redeem(server, invite), { hostId: 'mac-1' })
      const credential = await activation.load()
      assert.equal(credential?.key, hostKey)
      fake = await createFakeDesktopServer({ chunkDelayMs: 0 })
      const ports = createInProcessRemotePorts(fake.server)
      let lanEndpoint = ''
      service = new RemoteService({
        directory: join(dir, 'remote'),
        uploadsDirectory: join(dir, 'uploads'),
        secretBox: plaintextSecretBox,
        server: ports.server,
        host: ports.host,
        subscribe: (listener) => fake!.server.subscribe(listener),
        listen: { host: '127.0.0.1', port: 0 },
        deviceName: () => 'Relay Mac',
        appVersion: 'test',
        endpoints: () => (lanEndpoint ? [{ kind: 'lan', url: lanEndpoint }] : []),
        mailboxRoot: null,
        log: () => undefined,
        relayCredential: credential,
        relayTestTransport: {
          fetch: localFetch,
          connect: (url, headers) =>
            new WebSocket(url.replace('wss://relay.example', `ws://127.0.0.1:${port}`), { headers })
        }
      })
      await service.start()
      lanEndpoint = `ws://127.0.0.1:${service.port}/remote/v1`
      assert.equal(service.relayConnected, true)
      const pairingUrl = (await service.createPairingUrl()).url
      const qr = decodePairingUrl(pairingUrl)
      const bootstrap = qr.endpoints[0]!
      assert.equal(bootstrap.kind, 'relay')
      if (bootstrap.kind !== 'relay') throw new Error('Missing relay endpoint')
      const localPhone = (endpoint: typeof bootstrap): string =>
        endpoint.url
          .replace('wss://relay.example', `ws://127.0.0.1:${port}`)
          .replace(/\/ws$/, `/${randomUUID()}/ws`)
      const paired = await RemoteTestClient.pair(pairingUrl, {
        endpoint: localPhone(bootstrap),
        endpointHeaders: { Authorization: `Bearer ${bootstrap.token}` },
        waitForRelayOpen: true
      })
      const hello = await paired.client.call<{ deviceName: string }>('remote.hello', {
        protocolVersion: 1,
        client: { app: 'test', version: '1' }
      })
      assert.equal(hello.deviceName, 'Relay Mac')
      const grant = paired.client.grant?.relayEndpoint
      assert.equal(grant?.kind, 'relay')
      if (!grant) throw new Error('Missing permanent relay grant')
      assert.notEqual(grant.token, bootstrap.token)
      await paired.client.close()
      const resumed = await RemoteTestClient.connect(localPhone(grant), {
        phoneKeyPair: paired.phoneKeyPair,
        desktopKey: paired.desktopKey,
        endpointHeaders: { Authorization: `Bearer ${grant.token}` },
        waitForRelayOpen: true
      })
      assert.equal(
        (
          await resumed.call<{ deviceName: string }>('remote.hello', {
            protocolVersion: 1,
            client: { app: 'test', version: '1' }
          })
        ).deviceName,
        'Relay Mac'
      )
      assert.equal(await service.revoke(paired.client.grant!.pairingId), true)
      await resumed.waitForClose()
      await assert.rejects(
        RemoteTestClient.connect(localPhone(grant), {
          phoneKeyPair: paired.phoneKeyPair,
          desktopKey: paired.desktopKey,
          endpointHeaders: { Authorization: `Bearer ${grant.token}` },
          waitForRelayOpen: true
        })
      )
      // A direct/LAN pairing path receives its own permanent relay grant when Relay is active.
      const directQr = (await service.createPairingUrl()).url
      const direct = await RemoteTestClient.pair(directQr, { endpoint: lanEndpoint })
      await direct.client.call('remote.hello', {
        protocolVersion: 1,
        client: { app: 'test', version: '1' }
      })
      assert.equal(direct.client.grant?.relayEndpoint?.kind, 'relay')
      await direct.client.close()
      assert.equal(await service.revoke(direct.client.grant!.pairingId), true)
      // Revoke while the relay PUT for an already-authenticated pairing is delayed.
      deferPermanentPut = true
      const registered = new Promise<void>((resolve) => {
        putStarted = resolve
      })
      const pendingQr = (await service.createPairingUrl()).url
      const pendingEndpoint = decodePairingUrl(pendingQr).endpoints[0]!
      if (pendingEndpoint.kind !== 'relay') throw new Error('Missing bootstrap')
      const pending = await RemoteTestClient.pair(pendingQr, {
        endpoint: localPhone(pendingEndpoint),
        endpointHeaders: { Authorization: `Bearer ${pendingEndpoint.token}` },
        waitForRelayOpen: true
      })
      const pendingCall = pending.client
        .call('remote.hello', {
          protocolVersion: 1,
          client: { app: 'test', version: '1' }
        })
        .catch(() => undefined)
      await registered
      const pendingId = (await service.store.list())[0]!.pairingId
      assert.equal(await service.revoke(pendingId), true)
      putGate.release?.()
      await pending.client.waitForClose()
      await pendingCall
      assert.deepEqual(await service.store.list(), [])
      deferPermanentPut = false
      const abandoned = decodePairingUrl((await service.createPairingUrl()).url).endpoints[0]!
      assert.equal(abandoned.kind, 'relay')
      await service.stop()
      assert.deepEqual(await service.store.relayGrantIds(), [])
      service = null
    } finally {
      await service?.stop()
      await fake?.dispose()
      await rm(dir, { recursive: true, force: true })
      child.kill('SIGTERM')
      if (child.exitCode === null) await once(child, 'exit').catch(() => undefined)
    }
  }
)
