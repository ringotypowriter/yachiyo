import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@yachiyo/shared/protocol'
import type { RemoteEndpoint } from '@yachiyo/shared/remote/common'

import { RemoteController, type RemoteServiceParams } from './remoteController.ts'

class FakeService {
  port: number | null = null
  running = false
  readonly params: RemoteServiceParams

  constructor(params: RemoteServiceParams) {
    this.params = params
  }

  async start(): Promise<void> {
    this.running = true
    this.port = this.params.listen.port
  }

  async stop(): Promise<void> {
    this.running = false
  }

  published = 0
  async publishEndpoints(): Promise<void> {
    this.published += 1
  }
}

function createController(
  relayCredential?: (
    server: string
  ) => Promise<{ server: string; hostId: string; key: string } | null>
): {
  controller: RemoteController<FakeService>
  created: FakeService[]
  wanted: boolean[]
  monitors: Array<(endpoint: RemoteEndpoint | null) => void>
} {
  const created: FakeService[] = []
  const wanted: boolean[] = []
  const monitors: Array<(endpoint: RemoteEndpoint | null) => void> = []
  const controller = new RemoteController<FakeService>({
    relayCredential,
    createService: (params) => {
      const service = new FakeService(params)
      created.push(service)
      return service
    },
    keepAwake: { setWanted: (value) => wanted.push(value), dispose: () => undefined },
    tunnel: {
      monitor: (_config, onChange) => {
        monitors.push(onChange)
      },
      stopMonitoring: () => {
        monitors.length = 0
      },
      endpoint: (config) =>
        config.tunnel === 'none'
          ? null
          : { kind: 'tunnel', url: 'wss://quiet-fox.trycloudflare.com/remote/v1' }
    },
    lanAddress: () => '192.168.1.20',
    log: () => undefined
  })
  return { controller, created, wanted, monitors }
}

const enabled = (overrides: Partial<RemoteConfig> = {}): RemoteConfig => ({
  ...DEFAULT_REMOTE_CONFIG,
  enabled: true,
  ...overrides
})

test('a disabled remote constructs nothing and holds no power blocker', async () => {
  const { controller, created, wanted } = createController()
  await controller.apply(DEFAULT_REMOTE_CONFIG)

  assert.equal(created.length, 0)
  assert.equal(controller.service, null)
  assert.deepEqual(wanted, [false])
})

test('relay bearer is loaded only for selected enabled relay; switching away stops it without touching cloudflared', async () => {
  let reads = 0
  const { controller, created } = createController(async (server) => {
    reads++
    return { server, hostId: 'mac-1', key: 'A'.repeat(43) }
  })
  const relay = enabled({ tunnel: 'relay', relayServer: 'https://relay.example' })
  await controller.apply({ ...relay, enabled: false })
  await controller.apply(enabled({ relayServer: relay.relayServer }))
  assert.equal(reads, 0)
  assert.equal(created[0]?.params.relayCredential, null)
  await controller.apply(relay)
  assert.equal(reads, 1)
  assert.equal(created[1]?.params.relayCredential?.hostId, 'mac-1')
  assert.deepEqual(created[1]?.params.endpoints(), [])
  await controller.apply(enabled({ relayServer: relay.relayServer }))
  assert.equal(created[1]?.running, false)
  assert.equal(created[2]?.params.relayCredential, null)
})

test('enabling starts on loopback; disabling stops the service and releases the blocker', async () => {
  const { controller, created, wanted } = createController()
  await controller.apply(enabled())

  assert.equal(created.length, 1)
  assert.deepEqual(created[0]!.params.listen, { host: '127.0.0.1', port: 47831 })
  assert.equal(created[0]!.running, true)
  assert.deepEqual(wanted, [true])

  await controller.apply({ ...enabled(), enabled: false })
  assert.equal(created[0]!.running, false)
  assert.equal(controller.service, null)
  assert.deepEqual(wanted, [true, false])
})

test('port or LAN changes restart the service; other changes do not', async () => {
  const { controller, created } = createController()
  await controller.apply(enabled())
  await controller.apply(enabled({ keepAwakeOnPower: false }))
  assert.equal(created.length, 1)

  await controller.apply(enabled({ lanEndpoint: true }))
  assert.equal(created.length, 2)
  assert.equal(created[0]!.running, false)
  assert.equal(created[1]!.params.listen.host, '0.0.0.0')
})

test('endpoints list the tunnel first and add LAN only when enabled', async () => {
  const { controller, created } = createController()
  await controller.apply(enabled({ lanEndpoint: true }))
  assert.deepEqual(created[0]!.params.endpoints(), [
    { kind: 'tunnel', url: 'wss://quiet-fox.trycloudflare.com/remote/v1' },
    { kind: 'lan', url: 'ws://192.168.1.20:47831/remote/v1' }
  ])

  await controller.apply(enabled({ lanEndpoint: true, tunnel: 'none' }))
  assert.deepEqual(created[0]!.params.endpoints(), [
    { kind: 'lan', url: 'ws://192.168.1.20:47831/remote/v1' }
  ])
})

test('external HTTPS ingress is advertised as a secure endpoint without a managed tunnel', async () => {
  const { controller, created } = createController()
  await controller.apply(enabled({ tunnel: 'none', publicEndpoint: 'https://vm.example.com' }))
  assert.deepEqual(created[0]!.params.listen, { host: '127.0.0.1', port: 47831 })
  assert.deepEqual(created[0]!.params.endpoints(), [
    { kind: 'tunnel', url: 'wss://vm.example.com/remote/v1' }
  ])

  await controller.apply(enabled({ tunnel: 'none', publicEndpoint: 'wss://192.0.2.4/remote/v1' }))
  assert.equal(created.length, 1)
  assert.deepEqual(created[0]!.params.endpoints(), [
    { kind: 'tunnel', url: 'wss://192.0.2.4/remote/v1' }
  ])
  assert.equal(created[0]!.published, 1)
})

test('an insecure or malformed public endpoint is never sent in a pairing QR', async () => {
  const { controller, created } = createController()
  for (const publicEndpoint of [
    'http://vm.example.com',
    'ws://vm.example.com',
    'wss://vm.example.com/other',
    'wss://user:pass@vm.example.com',
    'wss://vm.example.com/remote/v1?token=secret'
  ]) {
    await controller.apply(enabled({ tunnel: 'none', publicEndpoint }))
    assert.deepEqual(created[0]!.params.endpoints(), [])
  }
})

test('a tunnel endpoint change republishes mailboxes; disabling stops monitoring', async () => {
  const { controller, created, monitors } = createController()
  await controller.apply(enabled())
  assert.equal(monitors.length, 1)

  monitors[0]!(null)
  await Promise.resolve()
  assert.equal(created[0]!.published, 1)

  await controller.apply({ ...enabled(), enabled: false })
  assert.equal(monitors.length, 0)
})
