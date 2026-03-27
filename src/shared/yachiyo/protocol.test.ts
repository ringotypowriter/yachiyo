import assert from 'node:assert/strict'
import test from 'node:test'

import { isMemoryConfigured, normalizeMemoryProviderId } from './protocol.ts'

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
