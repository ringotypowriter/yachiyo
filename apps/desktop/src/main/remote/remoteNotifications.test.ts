import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import type { RemoteThreadSummary } from '@yachiyo/shared/remote/projections'
import { generateKeyPair } from './noise/primitives.ts'
import { PairingStore, plaintextSecretBox } from './pairingStore.ts'
import { RemoteNotifications } from './remoteNotifications.ts'

const TOKEN = 'a'.repeat(64)
const DEVICE = '0123456789abcdef0123456789abcdef'
const summary = { id: 't1', title: 'Conversation title' } as RemoteThreadSummary
const event = (runId = 'r1', type = 'run.completed'): YachiyoServerEvent =>
  ({
    type,
    threadId: 't1',
    runId,
    eventId: runId,
    timestamp: '2026-10-01T00:00:00Z'
  }) as YachiyoServerEvent

async function harness(
  fn: (h: {
    notifications: RemoteNotifications
    store: PairingStore
    pairingId: string
    requests: Array<{ url: string; init: RequestInit }>
    logs: string[]
    setEnabled(value: boolean): void
    setSummary(value: RemoteThreadSummary | null): void
    setResponse(value: Response): void
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'yachiyo-notifications-'))
  const store = new PairingStore({ directory, secretBox: plaintextSecretBox })
  const { record } = await store.completePairing({
    token: store.createOffer().token,
    phoneKey: generateKeyPair().publicKey,
    deviceName: 'iPhone'
  })
  await store.setPushToken(record.pairingId, TOKEN)
  let enabled = true
  let currentSummary: RemoteThreadSummary | null = summary
  let response = new Response('', { status: 200 })
  const requests: Array<{ url: string; init: RequestInit }> = []
  const logs: string[] = []
  const notifications = new RemoteNotifications({
    store,
    credential: { server: 'https://relay.example', hostId: 'mac-1', key: 'host-secret' },
    remoteDeviceId: DEVICE,
    enabled: async () => enabled,
    getThreadSummary: async () => currentSummary,
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init: init! })
      return response
    }) as typeof fetch,
    log: (line) => logs.push(line)
  })
  try {
    await fn({
      notifications,
      store,
      pairingId: record.pairingId,
      requests,
      logs,
      setEnabled: (value) => {
        enabled = value
      },
      setSummary: (value) => {
        currentSummary = value
      },
      setResponse: (value) => {
        response = value
      }
    })
  } finally {
    await store.flush()
    await rm(directory, { recursive: true, force: true })
  }
}

test('completion pushes only title and routing metadata with host authentication, once per run', async () => {
  await harness(async ({ notifications, requests }) => {
    await notifications.handle(event())
    await notifications.handle(event())
    assert.equal(requests.length, 1)
    const request = requests[0]!
    assert.equal(request.url, 'https://relay.example/v1/hosts/mac-1/push')
    assert.equal(new Headers(request.init.headers).get('authorization'), 'Bearer host-secret')
    assert.equal(request.init.redirect, 'error')
    assert.ok(request.init.signal)
    assert.deepEqual(JSON.parse(request.init.body as string), {
      type: 'run-completed',
      token: TOKEN,
      title: summary.title,
      threadId: 't1',
      remoteDeviceId: DEVICE
    })
  })
})

test('disabled notifications, hidden threads, non-completions, opted-out and revoked pairings never push', async () => {
  await harness(async ({ notifications, store, pairingId, requests, setEnabled, setSummary }) => {
    setEnabled(false)
    await notifications.handle(event('r1'))
    setEnabled(true)
    setSummary(null)
    await notifications.handle(event('r2'))
    setSummary(summary)
    await notifications.handle(event('r3', 'run.cancelled'))
    await notifications.handle(event('r4', 'run.failed'))
    await store.setPushToken(pairingId, null)
    await notifications.handle(event('r5'))
    await store.setPushToken(pairingId, TOKEN)
    await store.revoke(pairingId)
    await notifications.handle(event('r6'))
    assert.equal(requests.length, 0)
  })
})

test('APNs unregistered token is cleared and failure logs never include credentials or title', async () => {
  await harness(async ({ notifications, store, pairingId, logs, setResponse }) => {
    setResponse(new Response('{"reason":"Unregistered"}', { status: 410 }))
    await notifications.handle(event())
    assert.equal(await store.pushToken(pairingId), null)
    assert.equal(logs.length, 1)
    assert.equal(
      logs.some(
        (line) =>
          line.includes(TOKEN) || line.includes('host-secret') || line.includes(summary.title)
      ),
      false
    )
  })
})

test('a replaced token is not cleared by an older in-flight rejection', async () => {
  await harness(async ({ store, pairingId }) => {
    const notifications = new RemoteNotifications({
      store,
      credential: { server: 'https://relay.example', hostId: 'mac-1', key: 'host-secret' },
      remoteDeviceId: DEVICE,
      enabled: async () => true,
      getThreadSummary: async () => summary,
      fetch: (async () => {
        await store.setPushToken(pairingId, 'b'.repeat(64))
        return new Response('{"reason":"Unregistered"}', { status: 410 })
      }) as typeof fetch,
      log: () => {}
    })
    await notifications.handle(event())
    assert.equal(await store.pushToken(pairingId), 'b'.repeat(64))
  })
})

for (const reason of ['BadDeviceToken', 'DeviceTokenNotForTopic']) {
  test(`permanent Apple token rejection ${reason} clears only the rejected registration`, async () => {
    await harness(async ({ notifications, store, pairingId, setResponse }) => {
      setResponse(Response.json({ reason }, { status: 400 }))
      await notifications.handle(event())
      assert.equal(await store.pushToken(pairingId), null)
    })
  })
}

test('configuration and malformed rejection responses retain registration', async () => {
  await harness(async ({ notifications, store, pairingId, setResponse }) => {
    setResponse(Response.json({ reason: 'InvalidProviderToken' }, { status: 403 }))
    await notifications.handle(event('r1'))
    assert.equal(await store.pushToken(pairingId), TOKEN)
    setResponse(new Response('not JSON', { status: 400 }))
    await notifications.handle(event('r2'))
    assert.equal(await store.pushToken(pairingId), TOKEN)
  })
})

test('stopping drains and aborts in-flight requests without late token cleanup', async () => {
  await harness(async ({ store, pairingId }) => {
    let release!: (response: Response) => void
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const response = new Promise<Response>((resolve) => {
      release = resolve
    })
    let signal: AbortSignal | undefined
    const notifications = new RemoteNotifications({
      store,
      credential: { server: 'https://relay.example', hostId: 'mac-1', key: 'host-secret' },
      remoteDeviceId: DEVICE,
      enabled: async () => true,
      getThreadSummary: async () => summary,
      fetch: (async (_url, init) => {
        signal = init!.signal!
        started()
        return response
      }) as typeof fetch,
      log: () => {}
    })
    const running = notifications.handle(event())
    await ready
    const stopping = notifications.stop()
    release(Response.json({ reason: 'Unregistered' }, { status: 410 }))
    await stopping
    await running
    assert.equal(signal?.aborted, true)
    assert.equal(await store.pushToken(pairingId), TOKEN)
  })
})

test('one failing phone does not release other in-flight response readers during shutdown', async () => {
  await harness(async ({ store, pairingId }) => {
    const second = await store.completePairing({
      token: store.createOffer().token,
      phoneKey: generateKeyPair().publicKey,
      deviceName: 'second phone'
    })
    await store.setPushToken(second.record.pairingId, 'b'.repeat(64))
    let reader!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        reader = controller
      }
    })
    let entered!: () => void
    const reading = new Promise<void>((resolve) => {
      entered = resolve
    })
    const notifications = new RemoteNotifications({
      store,
      credential: { server: 'https://relay.example', hostId: 'mac-1', key: 'host-secret' },
      remoteDeviceId: DEVICE,
      enabled: async () => true,
      getThreadSummary: async () => summary,
      fetch: (async (_url, init) => {
        if (JSON.parse(init!.body as string).token === TOKEN) throw new Error('offline')
        entered()
        return new Response(body, { status: 400 })
      }) as typeof fetch,
      log: () => {}
    })
    let finished = false
    const running = notifications.handle(event()).then(() => {
      finished = true
    })
    await reading
    await new Promise<void>((resolve) => setImmediate(resolve))
    const premature = finished
    const stopping = notifications.stop()
    reader.enqueue(new TextEncoder().encode(JSON.stringify({ reason: 'BadDeviceToken' })))
    reader.close()
    await stopping
    await running
    assert.equal(premature, false)
    assert.equal(await store.pushToken(pairingId), TOKEN)
    assert.equal(await store.pushToken(second.record.pairingId), 'b'.repeat(64))
  })
})
