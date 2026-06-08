import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createChannelServiceSupervisor,
  type ManagedChannelService
} from './channelServiceLifecycle.ts'

interface FakeService extends ManagedChannelService {
  starts: number
  stops: number
  healthy: boolean
  blockStart?: Promise<void>
  blockHealthCheck?: Promise<void>
}

function createFakeService(
  healthy = true,
  blockStart?: Promise<void>,
  blockHealthCheck?: Promise<void>
): FakeService {
  return {
    starts: 0,
    stops: 0,
    healthy,
    blockStart,
    blockHealthCheck,
    async start(): Promise<void> {
      this.starts++
      await this.blockStart
    },
    async stop(): Promise<void> {
      this.stops++
    },
    async healthCheck(): Promise<boolean> {
      await this.blockHealthCheck
      return this.healthy
    }
  }
}

describe('createChannelServiceSupervisor', () => {
  it('does not create a service when disabled and stops an existing instance', async () => {
    let enabled = true
    const services: FakeService[] = []
    const supervisor = createChannelServiceSupervisor({
      telegram: {
        label: 'telegram',
        enabled: () => enabled,
        create: () => {
          const service = createFakeService()
          services.push(service)
          return service
        }
      }
    })

    await supervisor.reconcile('telegram', 'initial')
    enabled = false
    await supervisor.reconcile('telegram', 'disabled')

    assert.equal(services.length, 1)
    assert.equal(services[0].starts, 1)
    assert.equal(services[0].stops, 1)
    assert.equal(supervisor.getService('telegram'), null)
  })

  it('creates and starts a service when enabled and no instance exists', async () => {
    const services: FakeService[] = []
    const supervisor = createChannelServiceSupervisor({
      qq: {
        label: 'qq',
        enabled: () => true,
        create: () => {
          const service = createFakeService()
          services.push(service)
          return service
        }
      }
    })

    await supervisor.reconcile('qq', 'initial')

    assert.equal(services.length, 1)
    assert.equal(services[0].starts, 1)
    assert.equal(supervisor.getService('qq'), services[0])
  })

  it('restarts an unhealthy service', async () => {
    const services: FakeService[] = []
    const supervisor = createChannelServiceSupervisor({
      discord: {
        label: 'discord',
        enabled: () => true,
        create: () => {
          const service = createFakeService()
          services.push(service)
          return service
        }
      }
    })

    await supervisor.reconcile('discord', 'initial')
    services[0].healthy = false
    await supervisor.ensureHealthy('discord', 'health check')

    assert.equal(services.length, 2)
    assert.equal(services[0].stops, 1)
    assert.equal(services[1].starts, 1)
    assert.equal(supervisor.getService('discord'), services[1])
  })

  it('deduplicates concurrent restarts for one platform', async () => {
    let releaseStart!: () => void
    const blockedStart = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    const services: FakeService[] = []
    const supervisor = createChannelServiceSupervisor({
      qqbot: {
        label: 'qqbot',
        enabled: () => true,
        create: () => {
          const service = createFakeService(
            services.length > 0,
            services.length === 1 ? blockedStart : undefined
          )
          services.push(service)
          return service
        }
      }
    })

    await supervisor.reconcile('qqbot', 'initial')
    services[0].healthy = false

    const first = supervisor.ensureHealthy('qqbot', 'first')
    const second = supervisor.restart('qqbot', 'second')
    await Promise.resolve()
    releaseStart()
    await Promise.all([first, second])

    assert.equal(services.length, 2)
    assert.equal(services[0].stops, 1)
    assert.equal(services[1].starts, 1)
  })

  it('pokes only enabled platforms', async () => {
    const services: Record<string, FakeService[]> = { telegram: [], qq: [] }
    const supervisor = createChannelServiceSupervisor({
      telegram: {
        label: 'telegram',
        enabled: () => true,
        create: () => {
          const service = createFakeService()
          services.telegram.push(service)
          return service
        }
      },
      qq: {
        label: 'qq',
        enabled: () => false,
        create: () => {
          const service = createFakeService()
          services.qq.push(service)
          return service
        }
      }
    })

    await supervisor.poke('resume')

    assert.equal(services.telegram.length, 1)
    assert.equal(services.qq.length, 0)
  })

  it('applies a disable reconcile after an in-flight health check completes', async () => {
    let enabled = true
    let releaseHealthCheck!: () => void
    const blockedHealthCheck = new Promise<void>((resolve) => {
      releaseHealthCheck = resolve
    })
    const services: FakeService[] = []
    const supervisor = createChannelServiceSupervisor({
      telegram: {
        label: 'telegram',
        enabled: () => enabled,
        create: () => {
          const service = createFakeService(true, undefined, blockedHealthCheck)
          services.push(service)
          return service
        }
      }
    })

    await supervisor.reconcile('telegram', 'initial')
    const healthCheck = supervisor.ensureHealthy('telegram', 'periodic health check')
    await Promise.resolve()

    enabled = false
    const disable = supervisor.reconcile('telegram', 'config changed')
    releaseHealthCheck()
    await Promise.all([healthCheck, disable])

    assert.equal(services.length, 1)
    assert.equal(services[0].stops, 1)
    assert.equal(supervisor.getService('telegram'), null)
  })
})
