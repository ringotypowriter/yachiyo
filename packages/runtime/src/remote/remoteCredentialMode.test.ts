import { DEFAULT_REMOTE_CONFIG } from '@yachiyo/shared/protocol'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { AppRemoteBinding } from '../appServer/remoteBinding.ts'
import {
  createUnavailableRemoteBinding,
  REMOTE_WALLET_REQUIRED_MESSAGE
} from './remoteCredentialMode.ts'

async function assertRemoteUnavailable(binding: AppRemoteBinding): Promise<void> {
  const saved = Object.freeze({ ...DEFAULT_REMOTE_CONFIG, enabled: true })
  await binding.apply(saved)
  await binding.apply({ ...saved, enabled: false })
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
