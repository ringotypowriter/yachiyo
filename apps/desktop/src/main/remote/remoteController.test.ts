import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@yachiyo/shared/protocol'

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
}

function createController(): {
  controller: RemoteController<FakeService>
  created: FakeService[]
  wanted: boolean[]
} {
  const created: FakeService[] = []
  const wanted: boolean[] = []
  const controller = new RemoteController<FakeService>({
    createService: (params) => {
      const service = new FakeService(params)
      created.push(service)
      return service
    },
    keepAwake: { setWanted: (value) => wanted.push(value), dispose: () => undefined },
    tunnelEndpoint: () => ({ kind: 'tunnel', url: 'wss://quiet-fox.trycloudflare.com/remote/v1' }),
    lanAddress: () => '192.168.1.20',
    log: () => undefined
  })
  return { controller, created, wanted }
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
