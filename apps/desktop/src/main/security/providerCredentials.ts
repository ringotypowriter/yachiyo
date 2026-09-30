import { safeStorage } from 'electron'
import { existsSync } from 'node:fs'
import { selectProviderCredentialMode, type ProviderCredentialMode } from './providerCredentialMode'
import { createPlaintextProviderCredentialVault } from '@yachiyo/runtime/settings/plaintextProviderCredentialVault'
import { dirname } from 'node:path'

import {
  resolveYachiyoProviderCredentialKeyPath,
  resolveYachiyoPlaintextProviderCredentialVaultPath,
  resolveYachiyoProviderCredentialVaultPath
} from '@yachiyo/runtime/config/paths'
import { unlockProviderCredentialKey } from '@yachiyo/runtime/settings/providerCredentialKey'
import {
  createProviderCredentialVault,
  type ProviderCredentialVault
} from '@yachiyo/runtime/settings/providerCredentialVault'

let credentialMode: ProviderCredentialMode = 'encrypted'

export function isPlaintextProviderCredentialMode(): boolean {
  return credentialMode === 'plaintext'
}

export function prepareElectronProviderCredentials(settingsPath: string): void {
  credentialMode = selectProviderCredentialMode({
    args: process.argv,
    plaintextExists: existsSync(
      resolveYachiyoPlaintextProviderCredentialVaultPath(dirname(settingsPath))
    ),
    unlockEncrypted: () => {
      unlockElectronProviderCredentialKey(settingsPath)
    }
  })
  if (credentialMode === 'plaintext')
    console.warn(
      '[credentials] Plaintext mode: provider credentials are stored unencrypted in a separate local file, readable by anyone with file access. Existing encrypted credentials are unchanged. Remote access is unavailable.'
    )
}

/** CLI commands without a config service never need to access credentials. */
export function createElectronCliProviderCredentialVault(
  settingsPath: string
): ProviderCredentialVault {
  prepareElectronProviderCredentials(settingsPath)
  return createElectronProviderCredentialVault(settingsPath)
}

export function getProviderCredentialRuntimeStartupData(settingsPath: string): {
  providerCredentialMode: ProviderCredentialMode
  providerCredentialKey?: Buffer
} {
  return credentialMode === 'plaintext'
    ? { providerCredentialMode: 'plaintext' }
    : {
        providerCredentialMode: 'encrypted',
        providerCredentialKey: unlockElectronProviderCredentialKey(settingsPath)
      }
}

const unlockedKeys = new Map<string, Buffer>()

export function unlockElectronProviderCredentialKey(settingsPath: string): Buffer {
  const baseDir = dirname(settingsPath)
  const keyPath = resolveYachiyoProviderCredentialKeyPath(baseDir)
  const cached = unlockedKeys.get(keyPath)
  if (cached) {
    return cached
  }

  const key = unlockProviderCredentialKey({ keyPath, safeStorage })
  unlockedKeys.set(keyPath, key)
  return key
}

export function createElectronProviderCredentialVault(
  settingsPath: string
): ProviderCredentialVault {
  if (credentialMode === 'plaintext') {
    return createPlaintextProviderCredentialVault({
      vaultPath: resolveYachiyoPlaintextProviderCredentialVaultPath(dirname(settingsPath))
    })
  }
  return createProviderCredentialVault({
    vaultPath: resolveYachiyoProviderCredentialVaultPath(dirname(settingsPath)),
    encryptionKey: unlockElectronProviderCredentialKey(settingsPath)
  })
}
