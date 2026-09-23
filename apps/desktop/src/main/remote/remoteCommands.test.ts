import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_REMOTE_CONFIG, type SettingsConfig } from '@yachiyo/shared/protocol'
import type { RemoteStatusResult } from '@yachiyo/shared/remote/command'

import { handleRemoteCommand, type RemoteCommandDeps } from './remoteCommands.ts'
import type { TunnelInstallMode } from './tunnelSupervisor.ts'

function createDeps(): {
  deps: RemoteCommandDeps
  saved: SettingsConfig[]
  installs: TunnelInstallMode[]
} {
  let config: SettingsConfig = { providers: [], remote: DEFAULT_REMOTE_CONFIG }
  const saved: SettingsConfig[] = []
  const installs: TunnelInstallMode[] = []
  const deps: RemoteCommandDeps = {
    getConfig: async () => config,
    saveConfig: async (next) => {
      config = next
      saved.push(next)
    },
    tunnel: {
      install: async (install) => {
        installs.push(install)
      },
      uninstall: async () => undefined,
      status: async () => ({
        cloudflaredPath: '/opt/homebrew/bin/cloudflared',
        agentInstalled: true,
        agentRunning: true,
        hostname: 'quiet-fox.trycloudflare.com',
        endpoint: null
      }),
      hasConflictingUserConfig: () => false
    },
    service: () => null,
    listPairings: async () => [
      {
        pairingId: 'pairing-1',
        deviceName: 'iPhone',
        phoneKey: 'key',
        mailboxCounter: 3,
        createdAt: '2026-09-22T00:00:00.000Z'
      }
    ],
    revokePairing: async (pairingId) => pairingId === 'pairing-1',
    icloudDrive: async () => 'unavailable'
  }
  return { deps, saved, installs }
}

test('status reports iCloud Drive, cloudflared, and pairing state without secrets', async () => {
  const { deps } = createDeps()
  const status = (await handleRemoteCommand({ action: 'status' }, deps)) as RemoteStatusResult
  assert.equal(status.icloudDrive, 'unavailable')
  assert.equal(status.enabled, false)
  assert.equal(status.running, false)
  assert.equal(status.pairings, 1)
  assert.equal(status.cloudflared.hostname, 'quiet-fox.trycloudflare.com')
  assert.equal(JSON.stringify(status).includes('key'), false)
})

test('installing a tunnel enables remote with that mode; uninstall falls back to LAN only', async () => {
  const { deps, saved, installs } = createDeps()
  await handleRemoteCommand(
    {
      action: 'tunnel-install',
      mode: 'named',
      tunnelName: 'yachiyo-mac',
      hostname: 'mac.example.com'
    },
    deps
  )
  assert.deepEqual(installs, [
    { mode: 'named', tunnelName: 'yachiyo-mac', hostname: 'mac.example.com' }
  ])
  assert.deepEqual(saved.at(-1)?.remote, {
    ...DEFAULT_REMOTE_CONFIG,
    enabled: true,
    tunnel: 'named',
    namedHostname: 'mac.example.com'
  })

  await handleRemoteCommand({ action: 'tunnel-uninstall' }, deps)
  assert.equal(saved.at(-1)?.remote?.tunnel, 'none')
  assert.equal(saved.at(-1)?.remote?.enabled, true)
})

test('pairings list hides keys and revoke reports whether a pairing was removed', async () => {
  const { deps } = createDeps()
  assert.deepEqual(await handleRemoteCommand({ action: 'pairings-list' }, deps), [
    { pairingId: 'pairing-1', deviceName: 'iPhone', createdAt: '2026-09-22T00:00:00.000Z' }
  ])
  assert.deepEqual(
    await handleRemoteCommand({ action: 'pairings-revoke', pairingId: 'nope' }, deps),
    { revoked: false }
  )
})
