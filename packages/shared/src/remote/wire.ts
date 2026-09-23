/** Mixed into every Noise handshake so keys from other protocols cannot be replayed here. */
export const REMOTE_NOISE_PROLOGUE = 'yachiyo-remote/v1'

/** WebSocket path served by the desktop; everything else answers 404. */
export const REMOTE_WS_PATH = '/remote/v1'

/** Offered in Noise message 1 and selected in the authenticated message 2 payload.
 * No offer/empty reply retains the original JSON-only protocol without an extra round trip.
 * Negotiated messages are either unchanged JSON objects or this tag followed by gzip;
 * the tag is inside Noise, so WebSocket compression is neither needed nor useful.
 */
export const REMOTE_COMPRESSION = 'gzip'
export const REMOTE_COMPRESSED_MESSAGE_TAG = 0x01
export const REMOTE_COMPRESSION_MIN_BYTES = 1024
export const REMOTE_COMPRESSION_MIN_SAVING_BYTES = 32

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
