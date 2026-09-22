/** Mixed into every Noise handshake so keys from other protocols cannot be replayed here. */
export const REMOTE_NOISE_PROLOGUE = 'yachiyo-remote/v1'

/** WebSocket path served by the desktop; everything else answers 404. */
export const REMOTE_WS_PATH = '/remote/v1'

/**
 * First byte of the client's first WebSocket frame, followed by Noise message 1. The server
 * answers with Noise message 2; every later frame is one transport ciphertext.
 */
export const REMOTE_HANDSHAKE_MODE = {
  /** Noise_IK: reconnect of an existing pairing. */
  connect: 0x01,
  /** Noise_IKpsk2 with the QR token as PSK: first pairing. */
  pair: 0x02
} as const
