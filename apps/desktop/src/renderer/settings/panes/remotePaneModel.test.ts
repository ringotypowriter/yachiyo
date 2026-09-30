import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteStatusResult } from '@yachiyo/shared/remote/command'

import {
  remoteAddressLabel,
  remoteStatusHint,
  supportsManagedRemoteTunnel,
  withRemote
} from './remotePaneModel'

function status(overrides: Partial<RemoteStatusResult> = {}): RemoteStatusResult {
  return {
    enabled: true,
    tunnel: 'quick',
    running: true,
    port: 47831,
    endpoints: [
      { kind: 'lan', url: 'ws://192.168.1.20:47831/remote/v1' },
      { kind: 'tunnel', url: 'wss://quiet-fox.trycloudflare.com/remote/v1' }
    ],
    cloudflared: {
      path: '/opt/homebrew/bin/cloudflared',
      agentInstalled: true,
      agentRunning: true,
      hostname: 'quiet-fox.trycloudflare.com',
      conflictingUserConfig: false
    },
    icloudDrive: 'available',
    pairings: 1,
    connections: 0,
    ...overrides
  }
}

test('the copied address preserves the tunnel URL and falls back to the full LAN endpoint', () => {
  assert.equal(remoteAddressLabel(status()), 'wss://quiet-fox.trycloudflare.com/remote/v1')
  assert.equal(
    remoteAddressLabel(
      status({ endpoints: [{ kind: 'lan', url: 'ws://192.168.1.20:47831/remote/v1' }] })
    ),
    'ws://192.168.1.20:47831/remote/v1'
  )
  assert.equal(remoteAddressLabel(status({ endpoints: [] })), null)
  assert.equal(remoteAddressLabel(null), null)
})

test('a stopped cloudflared outranks missing iCloud Drive; nothing shows while off', () => {
  assert.equal(
    remoteStatusHint(
      status({
        icloudDrive: 'unavailable',
        cloudflared: { ...status().cloudflared, agentRunning: false }
      })
    ),
    'cloudflared-stopped'
  )
  assert.equal(remoteStatusHint(status({ icloudDrive: 'unavailable' })), 'icloud-unavailable')
  assert.equal(
    remoteStatusHint(status({ icloudDrive: 'unavailable' }), 'win32'),
    'quick-address-changes'
  )
  assert.equal(
    remoteStatusHint(status({ tunnel: 'named', icloudDrive: 'unavailable' }), 'win32'),
    null
  )
  assert.equal(
    remoteStatusHint(status({ icloudDrive: 'unavailable' }), 'darwin'),
    'icloud-unavailable'
  )
  assert.equal(
    remoteStatusHint(
      status({ tunnel: 'none', cloudflared: { ...status().cloudflared, agentRunning: false } })
    ),
    null
  )
  assert.equal(remoteStatusHint(status({ running: false, icloudDrive: 'unavailable' })), null)
})

test('withRemote patches only the remote section', () => {
  const next = withRemote({ providers: [] }, { enabled: true })
  assert.equal(next.remote?.enabled, true)
  assert.equal(next.remote?.tunnel, 'quick')
})

test('Linux only offers external ingress and explains incompatible saved tunnel modes', () => {
  assert.equal(supportsManagedRemoteTunnel('linux'), false)
  assert.equal(supportsManagedRemoteTunnel('darwin'), true)
  assert.equal(supportsManagedRemoteTunnel('win32'), true)
  for (const tunnel of ['quick', 'named'] as const) {
    assert.equal(remoteStatusHint(status({ tunnel }), 'linux'), 'external-endpoint-required')
    assert.equal(
      remoteStatusHint(status({ tunnel, running: false }), 'linux'),
      'external-endpoint-required'
    )
  }
  assert.equal(remoteStatusHint(status({ enabled: false, running: false }), 'linux'), null)
  assert.equal(
    remoteStatusHint(
      status({
        tunnel: 'none',
        icloudDrive: 'unavailable',
        cloudflared: { ...status().cloudflared, agentRunning: false }
      }),
      'linux'
    ),
    null
  )
})
