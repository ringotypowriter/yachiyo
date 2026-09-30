import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG, type RemoteConfig } from '@yachiyo/shared/protocol'

import { createPlatformTunnelSupervisor } from './platformTunnelSupervisor.ts'
import { RemoteController } from './remoteController.ts'
import { handleRemoteCommand, type RemoteCommandDeps } from './remoteCommands.ts'
import { TunnelSupervisor } from './tunnelSupervisor.ts'
import { WindowsTunnelSupervisor } from './windowsTunnelSupervisor.ts'

test('supported platforms retain their existing tunnel supervisors', () => {
  assert.ok(
    createPlatformTunnelSupervisor({ platform: 'darwin', yachiyoHome: '/unused' }) instanceof
      TunnelSupervisor
  )
  assert.ok(
    createPlatformTunnelSupervisor({ platform: 'win32', yachiyoHome: '/unused' }) instanceof
      WindowsTunnelSupervisor
  )
})

test('Linux refuses built-in installs without writing configuration or reporting a tunnel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-linux-tunnel-'))
  const logs: string[] = []
  const tunnel = createPlatformTunnelSupervisor({
    platform: 'linux',
    yachiyoHome: root,
    log: (line) => logs.push(line)
  })
  try {
    for (const install of [
      { mode: 'quick' as const },
      { mode: 'named' as const, tunnelName: 'saved-mac', hostname: 'saved.example.com' }
    ]) {
      await assert.rejects(
        tunnel.install(install, { port: 47831, metricsPort: 47832 }),
        /Built-in remote tunnels are unavailable.*External endpoint/
      )
      const config: RemoteConfig = {
        ...DEFAULT_REMOTE_CONFIG,
        enabled: true,
        tunnel: install.mode,
        namedHostname: 'saved.example.com'
      }
      tunnel.monitor(config, () => assert.fail('An unmanaged tunnel must not publish changes'))
      assert.equal(tunnel.endpoint(config), null)
      assert.deepEqual(await tunnel.status(config), {
        cloudflaredPath: null,
        agentInstalled: false,
        agentRunning: false,
        hostname: null,
        endpoint: null
      })
    }
    assert.equal(logs.length, 2)
    assert.equal(tunnel.hasConflictingUserConfig(), false)
    tunnel.monitor({ ...DEFAULT_REMOTE_CONFIG, enabled: true, tunnel: 'none' }, () => undefined)
    assert.equal(logs.length, 2)
    tunnel.stopMonitoring()
    await tunnel.uninstall()
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Linux advertises external TLS ingress and explicit LAN without fabricated managed endpoints', () => {
  const controller = new RemoteController({
    createService: () => assert.fail('Endpoint resolution must not start the service'),
    keepAwake: { setWanted: () => undefined, dispose: () => undefined },
    tunnel: createPlatformTunnelSupervisor({ platform: 'linux', yachiyoHome: '/unused' }),
    lanAddress: () => '192.0.2.10',
    log: () => undefined
  })
  const config: RemoteConfig = {
    ...DEFAULT_REMOTE_CONFIG,
    enabled: true,
    tunnel: 'none',
    publicEndpoint: 'https://vm.example.com'
  }
  assert.deepEqual(controller.endpoints(config, 47831), [
    { kind: 'tunnel', url: 'wss://vm.example.com/remote/v1' }
  ])
  assert.deepEqual(
    controller.endpoints({ ...config, publicEndpoint: 'http://vm.example.com' }, 47831),
    []
  )
  const savedNamedConfig: RemoteConfig = {
    ...config,
    tunnel: 'named',
    namedHostname: 'uncreated.example.com'
  }
  assert.deepEqual(controller.endpoints(savedNamedConfig, 47831), [])
  assert.deepEqual(controller.endpoints({ ...savedNamedConfig, lanEndpoint: true }, 47831), [
    { kind: 'lan', url: 'ws://192.0.2.10:47831/remote/v1' }
  ])
})

test('Linux CLI install failure preserves settings and uninstall only clears managed mode', async () => {
  let config = {
    providers: [],
    remote: {
      ...DEFAULT_REMOTE_CONFIG,
      enabled: true,
      publicEndpoint: 'https://vm.example.com'
    }
  }
  let saves = 0
  const deps: RemoteCommandDeps = {
    getConfig: async () => config,
    saveConfig: async (next) => {
      config = { ...config, remote: next.remote! }
      saves++
    },
    tunnel: createPlatformTunnelSupervisor({ platform: 'linux', yachiyoHome: '/unused' }),
    service: () => null,
    listPairings: async () => [],
    revokePairing: async () => false,
    icloudDrive: async () => 'unavailable'
  }
  await assert.rejects(
    handleRemoteCommand({ action: 'tunnel-install', mode: 'quick' }, deps),
    /Built-in remote tunnels are unavailable/
  )
  assert.equal(saves, 0)
  assert.equal(config.remote.tunnel, 'quick')
  await handleRemoteCommand({ action: 'tunnel-uninstall' }, deps)
  assert.equal(saves, 1)
  assert.equal(config.remote.tunnel, 'none')
  assert.equal(config.remote.enabled, true)
  assert.equal(config.remote.publicEndpoint, 'https://vm.example.com')
})
