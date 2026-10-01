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

import { YACHIYO_CONNECT_SERVER } from '@yachiyo/shared/protocol'
import type { RemoteChatAccepted } from '@yachiyo/shared/remote/methods'
import { decodePairingUrl } from '@yachiyo/shared/remote/pairing'
import { createFakeDesktopServer } from '@yachiyo/runtime/app/host/remote/testing/createFakeDesktopServer'

import { createInProcessRemotePorts } from './inProcessPorts.ts'
import { plaintextSecretBox } from './pairingStore.ts'
import { RelayActivation } from './relayActivation.ts'
import { RemoteService } from './remoteService.ts'
import { RemoteTestClient } from './testing/remoteTestClient.ts'

interface PushObservation {
  payload: Record<string, unknown>
  status: number
  apple: { payload: Record<string, unknown>; headers: Record<string, string> }
}

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
    const server = YACHIYO_CONNECT_SERVER
    const adminToken = randomBytes(32).toString('base64url')
    const signingKey = randomBytes(32).toString('base64url')
    // Real HTTP/WS Relay; only the final Apple transport is replaced with a recorder.
    const child = spawn(
      'bun',
      [
        '-e',
        `
      import { createApp } from './src/app';
      import { generateKeyPairSync } from 'node:crypto';
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' } });
      createApp({ signingKey: process.env.INVITATION_SIGNING_KEY, adminToken: process.env.ADMIN_TOKEN,
        push: { privateKey, teamId: 'TEAM123456', keyId: 'KEY1234567',
          topic: 'sh.ringo.yachiyo.remote', environment: 'sandbox' },
        transport: async (_url, init) => Response.json({ payload: JSON.parse(init.body), headers: init.headers })
      }).listen(Number(process.env.PORT));
    `
      ],
      {
        cwd: backend,
        env: {
          ...process.env,
          PORT: String(port),
          ADMIN_TOKEN: adminToken,
          INVITATION_SIGNING_KEY: signingKey
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    const dir = await mkdtemp(join(tmpdir(), 'yachiyo-relay-acceptance-'))
    let service: RemoteService | null = null
    let fake: Awaited<ReturnType<typeof createFakeDesktopServer>> | null = null
    let deferPermanentPut = false
    let putStarted: (() => void) | null = null
    const putGate: { release?: () => void } = {}
    let resolvePush: ((value: PushObservation) => void) | undefined
    const pushed = new Promise<PushObservation>((resolve) => {
      resolvePush = resolve
    })
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
      const response = await fetch(String(url).replace(server, origin), init)
      if (String(url).endsWith('/push')) {
        resolvePush?.({
          payload: JSON.parse(init!.body as string),
          status: response.status,
          apple: await response.clone().json()
        })
      }
      return response
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
      const minted = await fetch(`${origin}/v1/admin/invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: 1 })
      })
      assert.equal(
        minted.status,
        200,
        'administrator can mint an invitation without a device registry'
      )
      const invitation = (await minted.json()) as { code: string; expiresAt: string }
      const activation = new RelayActivation(join(dir, 'remote'), plaintextSecretBox, localFetch)
      const redeemed = await activation.redeem(invitation.code)
      const credential = await activation.load()
      assert.equal(credential?.hostId, redeemed.hostId)
      assert.match(redeemed.hostId, /^[A-Za-z0-9_-]{22}$/)
      assert.ok(credential?.key.includes('.'), 'redeemed host credential is signed and expiring')
      assert.deepEqual(await activation.redeem(invitation.code), redeemed)
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
            new WebSocket(
              url.replace(server.replace(/^https:/, 'wss:'), `ws://127.0.0.1:${port}`),
              { headers }
            )
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
          .replace(server.replace(/^https:/, 'wss:'), `ws://127.0.0.1:${port}`)
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
      const deviceToken = 'a'.repeat(64)
      assert.deepEqual(await paired.client.call('remote.push.register', { token: deviceToken }), {
        ok: true
      })
      assert.equal(await service.store.pushToken(paired.client.grant!.pairingId), deviceToken)
      const accepted = await paired.client.call<{
        thread: { id: string }
        accepted: RemoteChatAccepted
      }>('chat.startThread', { content: 'Finish this notification test.' })
      const timeout = AbortSignal.timeout(10_000)
      const push = await Promise.race([
        pushed,
        new Promise<never>((_, reject) => {
          timeout.addEventListener('abort', () => reject(new Error('No completion push')), {
            once: true
          })
        })
      ])
      assert.equal(
        push.status,
        200,
        'real Relay accepts host credentials and produces an Apple alert'
      )
      assert.equal(push.apple.headers['apns-push-type'], 'alert')
      assert.equal(push.apple.headers['apns-priority'], '10')
      assert.equal(push.apple.payload.threadId, accepted.thread.id)
      assert.deepEqual((push.apple.payload.aps as { alert: unknown }).alert, {
        title: push.payload.title,
        body: 'Your task has finished.'
      })
      assert.equal(push.payload.type, 'run-completed')
      assert.equal(push.payload.token, deviceToken)
      assert.equal(push.payload.threadId, accepted.thread.id)
      assert.equal(typeof push.payload.title, 'string')
      assert.ok((push.payload.title as string).length > 0)
      assert.match(push.payload.remoteDeviceId as string, /^[0-9a-f]{32}$/)
      assert.deepEqual(Object.keys(push.payload).sort(), [
        'remoteDeviceId',
        'threadId',
        'title',
        'token',
        'type'
      ])
      await paired.client.call('remote.push.register', { token: null })
      assert.equal(await service.store.pushToken(paired.client.grant!.pairingId), null)
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
