import { safeStorage } from 'electron'
import { dirname } from 'node:path'

import {
  resolveYachiyoProviderCredentialKeyPath,
  resolveYachiyoProviderCredentialVaultPath
} from '@yachiyo/runtime/config/paths'
import { unlockProviderCredentialKey } from '@yachiyo/runtime/settings/providerCredentialKey'
import {
  createProviderCredentialVault,
  type ProviderCredentialVault
} from '@yachiyo/runtime/settings/providerCredentialVault'

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
  return createProviderCredentialVault({
    vaultPath: resolveYachiyoProviderCredentialVaultPath(dirname(settingsPath)),
    encryptionKey: unlockElectronProviderCredentialKey(settingsPath)
  })
}
