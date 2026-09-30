import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'
import {
  selectProviderCredentialMode,
  selectCliProviderCredentialMode
} from './providerCredentialMode.ts'

test('explicit plaintext mode never touches a hanging wallet', async () => {
  let reason: string | undefined
  assert.equal(
    await selectProviderCredentialMode({
      plaintextRequested: true,
      plaintextExists: false,
      headless: false,
      unlockEncrypted: () => {
        throw new Error('must not call wallet')
      },
      choose: async (value) => {
        reason = value
        return 'plaintext'
      }
    }),
    'plaintext'
  )
  assert.equal(reason, 'requested')
})

test('unavailable wallet requires explicit consent and allows cancellation', async () => {
  assert.equal(
    await selectProviderCredentialMode({
      plaintextRequested: false,
      plaintextExists: false,
      headless: false,
      unlockEncrypted: () => {
        throw new ProviderCredentialStoreUnavailableError('unavailable')
      },
      choose: async (reason) => {
        assert.equal(reason, 'unavailable')
        return null
      }
    }),
    null
  )
})

test('existing plaintext data asks for a mode before opening encrypted storage', async () => {
  assert.equal(
    await selectProviderCredentialMode({
      plaintextRequested: false,
      plaintextExists: true,
      headless: false,
      unlockEncrypted: () => {
        throw new Error('must not call wallet')
      },
      choose: async (reason) => {
        assert.equal(reason, 'existing')
        return 'plaintext'
      }
    }),
    'plaintext'
  )
})

test('corruption and headless failure never silently downgrade', async () => {
  for (const [headless, error] of [
    [false, new Error('corrupt')],
    [true, new ProviderCredentialStoreUnavailableError('locked')]
  ] as const) {
    await assert.rejects(
      selectProviderCredentialMode({
        plaintextRequested: false,
        plaintextExists: false,
        headless,
        unlockEncrypted: () => {
          throw error
        },
        choose: async () => {
          throw new Error('must not prompt')
        }
      }),
      (actual) => actual === error
    )
  }
})

test('headless plaintext flag is explicit and secure mode remains default', async () => {
  let unlocks = 0
  const base = {
    plaintextExists: false,
    headless: true,
    unlockEncrypted: () => {
      unlocks++
    },
    choose: async () => null
  }
  assert.equal(
    await selectProviderCredentialMode({ ...base, plaintextRequested: true }),
    'plaintext'
  )
  assert.equal(unlocks, 0)
  assert.equal(
    await selectProviderCredentialMode({ ...base, plaintextRequested: false }),
    'encrypted'
  )
  assert.equal(unlocks, 1)
})

test('CLI requires a deliberate store choice when plaintext data exists', () => {
  assert.throws(() => selectCliProviderCredentialMode([], true), /Choose/)
  assert.equal(
    selectCliProviderCredentialMode(['--yachiyo-plaintext-credentials'], true),
    'plaintext'
  )
  assert.equal(
    selectCliProviderCredentialMode(['--yachiyo-encrypted-credentials'], true),
    'encrypted'
  )
  assert.equal(selectCliProviderCredentialMode([], false), 'encrypted')
  assert.throws(
    () =>
      selectCliProviderCredentialMode(
        ['--yachiyo-encrypted-credentials', '--yachiyo-plaintext-credentials'],
        true
      ),
    /only one/
  )
})
