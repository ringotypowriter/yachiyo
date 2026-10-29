import type { AppRemoteBinding } from '../appServer/remoteBinding.ts'

export const REMOTE_WALLET_REQUIRED_MESSAGE =
  'Remote access is unavailable in plaintext credential mode. Restart with encrypted credentials and an unlocked system wallet to use Remote. Saved Remote settings and pairings are unchanged.'

/** Preserve saved configuration while preventing all Remote startup and storage access. */
export function createUnavailableRemoteBinding(): AppRemoteBinding {
  const unavailable = async (): Promise<never> => {
    throw new Error(REMOTE_WALLET_REQUIRED_MESSAGE)
  }
  return {
    apply: async () => {},
    handleCommand: unavailable,
    createPairingUrl: unavailable,
    listPairings: unavailable,
    revokePairing: unavailable,
    activateRelay: unavailable,
    stop: async () => {}
  }
}
