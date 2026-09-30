import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'

export const PLAINTEXT_CREDENTIALS_FLAG = '--yachiyo-plaintext-credentials'
export const ENCRYPTED_CREDENTIALS_FLAG = '--yachiyo-encrypted-credentials'
export type ProviderCredentialMode = 'encrypted' | 'plaintext'

/** Explicit startup flags are the only way to opt into plaintext storage. */
export function selectProviderCredentialMode(input: {
  args: readonly string[]
  plaintextExists: boolean
  unlockEncrypted: () => void
}): ProviderCredentialMode {
  const plaintext = input.args.includes(PLAINTEXT_CREDENTIALS_FLAG)
  const encrypted = input.args.includes(ENCRYPTED_CREDENTIALS_FLAG)
  if (plaintext && encrypted) throw new Error('Choose only one provider credential storage mode')
  if (plaintext) return 'plaintext'
  if (input.plaintextExists && !encrypted) {
    throw new Error(
      `Separate plaintext credentials exist. Choose ${PLAINTEXT_CREDENTIALS_FLAG} or ${ENCRYPTED_CREDENTIALS_FLAG} explicitly. Plaintext credentials are unencrypted and readable by anyone with file access.`
    )
  }
  try {
    input.unlockEncrypted()
  } catch (error) {
    if (!(error instanceof ProviderCredentialStoreUnavailableError)) throw error
    throw new ProviderCredentialStoreUnavailableError(
      `System credential storage is unavailable. Unlock your system wallet and restart, or explicitly start with ${PLAINTEXT_CREDENTIALS_FLAG}. Plaintext mode stores provider credentials unencrypted in a separate local file and cannot use existing encrypted credentials or Remote access.`
    )
  }
  return 'encrypted'
}
