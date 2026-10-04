import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'

export const PLAINTEXT_CREDENTIALS_FLAG = '--yachiyo-plaintext-credentials'
export const ENCRYPTED_CREDENTIALS_FLAG = '--yachiyo-encrypted-credentials'
export type ProviderCredentialMode = 'encrypted' | 'plaintext'

/** Encrypted storage is preferred; an unavailable wallet falls back to the plaintext store. */
export function selectProviderCredentialMode(input: {
  args: readonly string[]
  plaintextExists: boolean
  unlockEncrypted: () => void
}): ProviderCredentialMode {
  const plaintext = input.args.includes(PLAINTEXT_CREDENTIALS_FLAG)
  const encrypted = input.args.includes(ENCRYPTED_CREDENTIALS_FLAG)
  if (plaintext && encrypted) throw new Error('Choose only one provider credential storage mode')
  if (plaintext) return 'plaintext'
  // The two stores are never merged, so a wallet that recovers later must not silently replace
  // the credentials saved in plaintext with the encrypted set.
  if (input.plaintextExists && !encrypted) return 'plaintext'
  try {
    input.unlockEncrypted()
  } catch (error) {
    if (!(error instanceof ProviderCredentialStoreUnavailableError)) throw error
    if (!encrypted) return 'plaintext'
    throw new ProviderCredentialStoreUnavailableError(
      `System credential storage is unavailable. Unlock your system wallet and restart, or start without ${ENCRYPTED_CREDENTIALS_FLAG} to use plaintext storage. Plaintext mode stores provider credentials unencrypted in a separate local file and cannot use existing encrypted credentials or Remote access.`
    )
  }
  return 'encrypted'
}
