import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { DEFAULT_REMOTE_CONFIG } from '@yachiyo/shared/protocol'
import type { GatewayRemoteBinding } from './gatewayRemote.ts'
import {
  createRemoteCredentialSecretBox,
  createUnavailableRemoteBinding,
  REMOTE_WALLET_REQUIRED_MESSAGE
} from './remoteCredentialMode.ts'

test('Remote secrets reject plaintext mode before touching the wallet', () => {
  let walletCalls = 0
  const secretBox = createRemoteCredentialSecretBox({
    isPlaintextMode: () => true,
    safeStorage: {
      encryptString: () => {
        walletCalls++
        return Buffer.alloc(0)
      },
      decryptString: () => {
        walletCalls++
        return ''
      }
    }
  })
  assert.throws(() => secretBox.encrypt(Buffer.from('synthetic secret')), {
    message: REMOTE_WALLET_REQUIRED_MESSAGE
  })
  assert.throws(() => secretBox.decrypt(Buffer.from('synthetic ciphertext')), {
    message: REMOTE_WALLET_REQUIRED_MESSAGE
  })
  assert.equal(walletCalls, 0)
})

test('encrypted mode preserves the Remote wallet format and rechecks mode on every call', () => {
  let plaintextMode = false
  const plaintext = Buffer.from('synthetic secret')
  const ciphertext = Buffer.from('synthetic ciphertext')
  const calls: string[] = []
  const secretBox = createRemoteCredentialSecretBox({
    isPlaintextMode: () => plaintextMode,
    safeStorage: {
      encryptString: (value) => {
        assert.equal(value, plaintext.toString('base64'))
        calls.push('encrypt')
        return ciphertext
      },
      decryptString: (value) => {
        assert.equal(value, ciphertext)
        calls.push('decrypt')
        return plaintext.toString('base64')
      }
    }
  })
  assert.equal(secretBox.encrypt(plaintext), ciphertext)
  assert.deepEqual(secretBox.decrypt(ciphertext), plaintext)
  plaintextMode = true
  assert.throws(() => secretBox.encrypt(plaintext), { message: REMOTE_WALLET_REQUIRED_MESSAGE })
  assert.throws(() => secretBox.decrypt(ciphertext), { message: REMOTE_WALLET_REQUIRED_MESSAGE })
  assert.deepEqual(calls, ['encrypt', 'decrypt'])
})

async function assertRemoteUnavailable(binding: GatewayRemoteBinding): Promise<void> {
  const saved = Object.freeze({ ...DEFAULT_REMOTE_CONFIG, enabled: true })
  binding.apply(saved)
  binding.apply({ ...saved, enabled: false })
  assert.equal(saved.enabled, true)
  for (const action of ['status', 'pairings-list', 'pairing-qr', 'tunnel-uninstall'] as const) {
    await assert.rejects(binding.handleCommand({ action }), {
      message: REMOTE_WALLET_REQUIRED_MESSAGE
    })
  }
  await assert.rejects(binding.handleCommand({ action: 'tunnel-install', mode: 'quick' }), {
    message: REMOTE_WALLET_REQUIRED_MESSAGE
  })
  await assert.rejects(binding.handleCommand({ action: 'pairings-revoke', pairingId: 'test' }), {
    message: REMOTE_WALLET_REQUIRED_MESSAGE
  })
  await assert.rejects(binding.createPairingUrl(), { message: REMOTE_WALLET_REQUIRED_MESSAGE })
  await assert.rejects(binding.listPairings(), { message: REMOTE_WALLET_REQUIRED_MESSAGE })
  await assert.rejects(binding.revokePairing('test'), { message: REMOTE_WALLET_REQUIRED_MESSAGE })
  await binding.stop()
}

test('unavailable Remote preserves saved configuration and rejects commands actionably', async () => {
  await assertRemoteUnavailable(createUnavailableRemoteBinding())
})

test('plaintext gateway does not initialize Remote storage, services, tunnels, or wallet access', async () => {
  const source = ts.transpileModule(
    readFileSync(new URL('./gatewayRemote.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const exports: { createGatewayRemoteBinding?: (deps: unknown) => GatewayRemoteBinding } = {}
  let plaintextMode = false
  const rejectAccess = (): never => {
    throw new Error('Remote dependencies must not be used in plaintext mode')
  }
  runInNewContext(source, {
    exports,
    require: (id: string) => {
      if (id === './remoteCredentialMode.ts') {
        return { createRemoteCredentialSecretBox, createUnavailableRemoteBinding }
      }
      if (id === '../security/providerCredentials.ts') {
        return { isPlaintextProviderCredentialMode: () => plaintextMode }
      }
      if (id === 'electron') {
        return { safeStorage: { encryptString: rejectAccess, decryptString: rejectAccess } }
      }
      return new Proxy(
        {},
        { get: (_target, key) => (key === '__esModule' ? false : rejectAccess()) }
      )
    }
  })
  assert.ok(exports.createGatewayRemoteBinding)
  const binding = exports.createGatewayRemoteBinding({
    server: rejectAccess,
    hostCall: rejectAccess
  })
  // The gateway binding is created during module import, before startup selects the mode.
  plaintextMode = true
  await assertRemoteUnavailable(binding)
})
