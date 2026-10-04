import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'
import { selectProviderCredentialMode } from './providerCredentialMode.ts'

test('explicit plaintext mode never touches a hanging wallet', () => {
  assert.equal(
    selectProviderCredentialMode({
      args: ['--yachiyo-plaintext-credentials'],
      plaintextExists: false,
      unlockEncrypted: () => {
        throw new Error('must not call wallet')
      }
    }),
    'plaintext'
  )
})

test('unavailable wallet falls back to plaintext unless encrypted mode was requested', () => {
  const base = {
    plaintextExists: false,
    unlockEncrypted: () => {
      throw new ProviderCredentialStoreUnavailableError('unavailable')
    }
  }
  assert.equal(selectProviderCredentialMode({ ...base, args: [] }), 'plaintext')
  assert.throws(
    () => selectProviderCredentialMode({ ...base, args: ['--yachiyo-encrypted-credentials'] }),
    ProviderCredentialStoreUnavailableError
  )
})

test('existing plaintext data stays selected until encrypted mode is requested', () => {
  let unlocks = 0
  const base = {
    plaintextExists: true,
    unlockEncrypted: () => {
      unlocks++
    }
  }
  assert.equal(selectProviderCredentialMode({ ...base, args: [] }), 'plaintext')
  assert.equal(unlocks, 0)
  assert.equal(
    selectProviderCredentialMode({ ...base, args: ['--yachiyo-plaintext-credentials'] }),
    'plaintext'
  )
  assert.equal(unlocks, 0)
  assert.equal(
    selectProviderCredentialMode({ ...base, args: ['--yachiyo-encrypted-credentials'] }),
    'encrypted'
  )
  assert.equal(unlocks, 1)
})

test('corruption is propagated without fallback', () => {
  const error = new Error('corrupt')
  assert.throws(
    () =>
      selectProviderCredentialMode({
        args: [],
        plaintextExists: false,
        unlockEncrypted: () => {
          throw error
        }
      }),
    (actual) => actual === error
  )
})

test('secure mode remains default and conflicting flags are rejected before wallet access', () => {
  let unlocks = 0
  const base = {
    plaintextExists: false,
    unlockEncrypted: () => {
      unlocks++
    }
  }
  assert.equal(selectProviderCredentialMode({ ...base, args: [] }), 'encrypted')
  assert.equal(unlocks, 1)
  assert.throws(
    () =>
      selectProviderCredentialMode({
        ...base,
        args: ['--yachiyo-encrypted-credentials', '--yachiyo-plaintext-credentials']
      }),
    /only one/
  )
  assert.equal(unlocks, 1)
})
