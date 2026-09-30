import { safeStorage, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { t } from '@yachiyo/i18n/index'
import {
  selectProviderCredentialMode,
  requestedProviderCredentialMode,
  selectCliProviderCredentialMode,
  type ProviderCredentialMode
} from './providerCredentialMode'
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

export async function prepareElectronProviderCredentials(
  settingsPath: string,
  headless: boolean
): Promise<boolean> {
  const mode = await selectProviderCredentialMode({
    plaintextRequested: requestedProviderCredentialMode(process.argv) === 'plaintext',
    plaintextExists: existsSync(
      resolveYachiyoPlaintextProviderCredentialVaultPath(dirname(settingsPath))
    ),
    headless,
    unlockEncrypted: () => {
      unlockElectronProviderCredentialKey(settingsPath)
    },
    choose: async (reason) => {
      const existing = reason === 'existing'
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: t('main.credentialStorage.title'),
        message: t(existing ? 'main.credentialStorage.existing' : 'main.credentialStorage.message'),
        detail: t('main.credentialStorage.detail'),
        buttons: existing
          ? [
              t('main.startupFailure.quit'),
              t('main.credentialStorage.plaintext'),
              t('main.credentialStorage.encrypted')
            ]
          : [t('main.startupFailure.quit'), t('main.credentialStorage.plaintext')],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1
        ? 'plaintext'
        : existing && result.response === 2
          ? 'encrypted'
          : null
    }
  })
  if (!mode) return false
  credentialMode = mode
  if (mode === 'plaintext')
    console.warn(
      '[credentials] Plaintext mode: provider secrets are stored unencrypted in a separate local file. Existing encrypted credentials are not used or changed.'
    )
  return true
}

/** CLI commands without a config service never need to access credentials. */
export function createElectronCliProviderCredentialVault(
  settingsPath: string
): ProviderCredentialVault {
  credentialMode = selectCliProviderCredentialMode(
    process.argv,
    existsSync(resolveYachiyoPlaintextProviderCredentialVaultPath(dirname(settingsPath)))
  )
  if (credentialMode === 'plaintext')
    console.warn(
      '[credentials] Plaintext mode: provider credentials are stored unencrypted in a separate local file.'
    )
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
