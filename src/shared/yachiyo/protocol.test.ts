import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deriveThreadCapabilities,
  getThreadCapabilities,
  isMemoryConfigured,
  normalizeMemoryProviderId
} from './protocol.ts'

test('normalizeMemoryProviderId accepts the builtin memory provider', () => {
  assert.equal(normalizeMemoryProviderId('builtin-memory'), 'builtin-memory')
  assert.equal(normalizeMemoryProviderId('nowledge-mem'), 'nowledge-mem')
  assert.equal(normalizeMemoryProviderId('unknown-provider'), 'nowledge-mem')
})

test('isMemoryConfigured allows builtin memory without a base URL', () => {
  assert.equal(
    isMemoryConfigured({
      memory: {
        enabled: true,
        provider: 'builtin-memory'
      }
    }),
    true
  )

  assert.equal(
    isMemoryConfigured({
      memory: {
        enabled: true,
        provider: 'nowledge-mem',
        baseUrl: ''
      }
    }),
    false
  )
})

test('deriveThreadCapabilities disables retry and branch actions for ACP threads', () => {
  assert.deepEqual(deriveThreadCapabilities(), {
    canRetry: true,
    canCreateBranch: true,
    canSelectReplyBranch: true,
    canEdit: true,
    canDelete: true
  })

  assert.deepEqual(
    deriveThreadCapabilities({
      kind: 'acp',
      profileId: 'agent-1',
      sessionStatus: 'new'
    }),
    {
      canRetry: false,
      canCreateBranch: false,
      canSelectReplyBranch: false,
      canEdit: false,
      canDelete: false
    }
  )
})

test('getThreadCapabilities prefers explicit thread capabilities when present', () => {
  assert.deepEqual(
    getThreadCapabilities({
      runtimeBinding: { kind: 'acp', profileId: 'agent-1', sessionStatus: 'new' },
      capabilities: {
        canRetry: false,
        canCreateBranch: false,
        canSelectReplyBranch: false,
        canEdit: false,
        canDelete: false
      }
    }),
    {
      canRetry: false,
      canCreateBranch: false,
      canSelectReplyBranch: false,
      canEdit: false,
      canDelete: false
    }
  )
})
