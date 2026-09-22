import assert from 'node:assert/strict'
import test from 'node:test'

import type { RemoteStatusResult } from '@yachiyo/shared/remote/command'

import { remoteAddressLabel, remoteStatusHint, withRemote } from './remotePaneModel'

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

test('the address prefers the tunnel host and falls back to the first endpoint', () => {
  assert.equal(remoteAddressLabel(status()), 'quiet-fox.trycloudflare.com')
  assert.equal(
    remoteAddressLabel(
      status({ endpoints: [{ kind: 'lan', url: 'ws://192.168.1.20:47831/remote/v1' }] })
    ),
    '192.168.1.20:47831'
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
