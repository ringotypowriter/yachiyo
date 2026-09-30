import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'

export const PLAINTEXT_CREDENTIALS_FLAG = '--yachiyo-plaintext-credentials'
export type ProviderCredentialMode = 'encrypted' | 'plaintext'

/** No storage writes or fallback happen until the explicit choice has completed. */
export async function selectProviderCredentialMode(input: {
  plaintextRequested: boolean
  plaintextExists: boolean
  headless: boolean
  unlockEncrypted: () => void
  choose: (
    reason: 'requested' | 'existing' | 'unavailable'
  ) => Promise<ProviderCredentialMode | null>
}): Promise<ProviderCredentialMode | null> {
  if (input.plaintextRequested) {
    return input.headless ? 'plaintext' : input.choose('requested')
  }
  if (input.plaintextExists && !input.headless) {
    const choice = await input.choose('existing')
    if (choice !== 'encrypted') return choice
  }
  try {
    input.unlockEncrypted()
    return 'encrypted'
  } catch (error) {
    if (input.headless || !(error instanceof ProviderCredentialStoreUnavailableError)) throw error
    return input.choose('unavailable')
  }
}

export const ENCRYPTED_CREDENTIALS_FLAG = '--yachiyo-encrypted-credentials'

export function requestedProviderCredentialMode(
  args: readonly string[]
): ProviderCredentialMode | undefined {
  const plaintext = args.includes(PLAINTEXT_CREDENTIALS_FLAG)
  const encrypted = args.includes(ENCRYPTED_CREDENTIALS_FLAG)
  if (plaintext && encrypted) throw new Error('Choose only one provider credential storage mode')
  return plaintext ? 'plaintext' : encrypted ? 'encrypted' : undefined
}

export function selectCliProviderCredentialMode(
  args: readonly string[],
  plaintextExists: boolean
): ProviderCredentialMode {
  const requested = requestedProviderCredentialMode(args)
  if (plaintextExists && !requested) {
    throw new Error(
      `Separate plaintext credentials exist. Choose ${PLAINTEXT_CREDENTIALS_FLAG} or ${ENCRYPTED_CREDENTIALS_FLAG} explicitly.`
    )
  }
  return requested ?? 'encrypted'
}
