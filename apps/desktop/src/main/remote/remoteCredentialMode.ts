import type { GatewayRemoteBinding } from './gatewayRemote.ts'
import type { SecretBox } from './pairingStore.ts'

export const REMOTE_WALLET_REQUIRED_MESSAGE =
  'Remote access is unavailable in plaintext credential mode. Restart with encrypted credentials and an unlocked system wallet to use Remote. Saved Remote settings and pairings are unchanged.'

/** Plaintext provider credentials never permit plaintext Remote identity or pairing secrets. */
export function createRemoteCredentialSecretBox(input: {
  isPlaintextMode: () => boolean
  safeStorage: {
    encryptString(plaintext: string): Buffer
    decryptString(ciphertext: Buffer): string
  }
}): SecretBox {
  const requireWalletMode = (): void => {
    if (input.isPlaintextMode()) throw new Error(REMOTE_WALLET_REQUIRED_MESSAGE)
  }
  return {
    encrypt: (plaintext) => {
      requireWalletMode()
      return input.safeStorage.encryptString(plaintext.toString('base64'))
    },
    decrypt: (ciphertext) => {
      requireWalletMode()
      return Buffer.from(input.safeStorage.decryptString(ciphertext), 'base64')
    }
  }
}

/** Preserve saved configuration while preventing all Remote startup and storage access. */
export function createUnavailableRemoteBinding(): GatewayRemoteBinding {
  const unavailable = async (): Promise<never> => {
    throw new Error(REMOTE_WALLET_REQUIRED_MESSAGE)
  }
  return {
    apply: () => {},
    handleCommand: unavailable,
    createPairingUrl: unavailable,
    listPairings: unavailable,
    revokePairing: unavailable,
    activateRelay: unavailable,
    stop: async () => {}
  }
}
