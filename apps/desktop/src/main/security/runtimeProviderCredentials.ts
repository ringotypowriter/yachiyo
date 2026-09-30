import {
  resolveYachiyoPlaintextProviderCredentialVaultPath,
  resolveYachiyoProviderCredentialVaultPath
} from '@yachiyo/runtime/config/paths'
import { createPlaintextProviderCredentialVault } from '@yachiyo/runtime/settings/plaintextProviderCredentialVault'
import {
  createProviderCredentialVault,
  type ProviderCredentialVault
} from '@yachiyo/runtime/settings/providerCredentialVault'

/** Only the main process may choose storage mode, before starting the runtime. */
export function createRuntimeProviderCredentialVault(
  message: {
    providerCredentialMode?: unknown
    providerCredentialKey?: unknown
  },
  baseDir?: string
): ProviderCredentialVault {
  if (message.providerCredentialMode === 'plaintext') {
    if (message.providerCredentialKey !== undefined)
      throw new Error('Plaintext runtime must not receive an encryption key')
    return createPlaintextProviderCredentialVault({
      vaultPath: resolveYachiyoPlaintextProviderCredentialVaultPath(baseDir)
    })
  }
  if (
    message.providerCredentialMode !== 'encrypted' ||
    !(message.providerCredentialKey instanceof Uint8Array)
  ) {
    throw new Error('Runtime start message is missing a valid provider credential mode or key')
  }
  return createProviderCredentialVault({
    vaultPath: resolveYachiyoProviderCredentialVaultPath(baseDir),
    encryptionKey: message.providerCredentialKey
  })
}
