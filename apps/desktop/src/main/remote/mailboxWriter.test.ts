import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'
import type { MailboxPlaintext } from '@yachiyo/shared/remote/mailbox'
import { createFakeDesktopServer } from '@yachiyo/runtime/app/host/remote/testing/createFakeDesktopServer'

import { createInProcessRemotePorts } from './inProcessPorts.ts'
import { MailboxWriter, mailboxDirectory } from './mailboxWriter.ts'
import { deriveMailboxKeys, openMailbox } from './noise/mailboxCrypto.ts'
import { generateKeyPair } from './noise/primitives.ts'
import { PairingStore, plaintextSecretBox } from './pairingStore.ts'
import { RemoteController } from './remoteController.ts'
import { RemoteService } from './remoteService.ts'
import { TunnelSupervisor } from './tunnelSupervisor.ts'

const endpoint = (host: string): RemoteEndpoint => ({
  kind: 'tunnel',
  url: `wss://${host}/remote/v1`
})

async function pairedStore(directory: string): Promise<{ store: PairingStore; secret: Buffer }> {
  const store = new PairingStore({ directory, secretBox: plaintextSecretBox })
  const offer = store.createOffer()
  const { mailboxSecret } = await store.completePairing({
    token: offer.token,
    phoneKey: generateKeyPair().publicKey,
    deviceName: 'iPhone'
  })
  return { store, secret: mailboxSecret }
}

async function readBox(root: string, secret: Buffer, lastCounter = 0): Promise<MailboxPlaintext> {
  const { mailboxId, mailboxKey } = deriveMailboxKeys(secret)
  const box = await readFile(join(mailboxDirectory(root), `${mailboxId}.box`))
  return openMailbox(mailboxKey, box, lastCounter)
}

test('publishing writes a decryptable box and bumps the counter only when endpoints change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-mailbox-'))
  try {
    const { store, secret } = await pairedStore(join(root, 'remote'))
    const writer = new MailboxWriter({
      root,
      store,
      remoteDeviceId: '0123456789abcdef0123456789abcdef'
    })

    assert.equal((await writer.publish([endpoint('a.trycloudflare.com')])).length, 1)
    assert.deepEqual(await readBox(root, secret), {
      remoteDeviceId: '0123456789abcdef0123456789abcdef',
      endpoints: [endpoint('a.trycloudflare.com')],
      counter: 1,
      issuedAt: (await readBox(root, secret)).issuedAt
    })

    assert.deepEqual(await writer.publish([endpoint('a.trycloudflare.com')]), [])
    await writer.publish([endpoint('b.trycloudflare.com')])
    const second = await readBox(root, secret, 1)
    assert.equal(second.counter, 2)
    assert.deepEqual(second.endpoints, [endpoint('b.trycloudflare.com')])

    const [pairing] = await store.list()
    await writer.remove(secret, pairing!.pairingId)
    assert.deepEqual(await readdir(mailboxDirectory(root)), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nothing is written when iCloud Drive is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-mailbox-'))
  try {
    const { store } = await pairedStore(join(root, 'remote'))
    const writer = new MailboxWriter({
      root: join(root, 'missing-icloud'),
      store,
      remoteDeviceId: '0123456789abcdef0123456789abcdef'
    })
    assert.deepEqual(await writer.publish([endpoint('a.trycloudflare.com')]), [])
    assert.equal((await store.list())[0]?.mailboxCounter, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a new quick-tunnel hostname reaches the mailbox through the running service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-mailbox-flow-'))
  const icloud = join(root, 'icloud')
  await mkdir(icloud, { recursive: true })
  const fake = await createFakeDesktopServer({ chunkDelayMs: 0 })
  let hostname = 'first-fox.trycloudflare.com'
  const tunnel = new TunnelSupervisor({
    paths: {
      launchAgentsDir: join(root, 'LaunchAgents'),
      yachiyoHome: join(root, 'home'),
      cloudflaredUserConfig: join(root, 'config.yaml')
    },
    uid: 501,
    fetch: (async () => Response.json({ hostname })) as typeof globalThis.fetch
  })
  const ports = createInProcessRemotePorts(fake.server)
  const controller = new RemoteController<RemoteService>({
    createService: ({ listen, endpoints }) =>
      new RemoteService({
        directory: join(root, 'remote'),
        uploadsDirectory: join(root, 'uploads'),
        secretBox: plaintextSecretBox,
        server: ports.server,
        host: ports.host,
        subscribe: (listener) => fake.server.subscribe(listener),
        listen,
        deviceName: () => 'Test Mac',
        appVersion: '0.0.0-test',
        endpoints,
        mailboxRoot: icloud,
        log: () => undefined
      }),
    keepAwake: { setWanted: () => undefined, dispose: () => undefined },
    tunnel,
    log: () => undefined
  })
  try {
    const { secret } = await pairedStore(join(root, 'remote'))
    await controller.apply({ ...DEFAULT_REMOTE_CONFIG, enabled: true, port: 0 })
    await tunnel.poll()
    await controller.service!.publishEndpoints()
    const first = await readBox(icloud, secret)
    assert.deepEqual(first.endpoints, [endpoint('first-fox.trycloudflare.com')])

    hostname = 'second-owl.trycloudflare.com'
    await tunnel.poll()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await readBox(icloud, secret, first.counter)
    assert.equal(second.counter, first.counter + 1)
    assert.deepEqual(second.endpoints, [endpoint('second-owl.trycloudflare.com')])
  } finally {
    await controller.stop()
    await fake.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
