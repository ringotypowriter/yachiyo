import { constants, inflateRawSync } from 'node:zlib'

import { REMOTE_STREAM_DEFLATE_MESSAGE_TAG } from '@yachiyo/shared/remote/wire'

/**
 * Phone-side model of `stream-deflate` for tests and benchmarks: every tagged message continues
 * one raw inflate stream; raw JSON messages (the pairing grant) bypass it. Re-inflates the whole
 * stream per message, which is simple and exact but only suitable for test-sized traffic.
 */
export function createStreamInflateDecoder(): (envelope: Buffer) => Buffer {
  let compressed = Buffer.alloc(0)
  let produced = 0
  return (envelope) => {
    if (envelope[0] === 0x7b) return envelope
    if (envelope[0] !== REMOTE_STREAM_DEFLATE_MESSAGE_TAG) {
      throw new Error('Expected a stream-deflate message.')
    }
    compressed = Buffer.concat([compressed, envelope.subarray(1)])
    const output = inflateRawSync(compressed, { finishFlush: constants.Z_SYNC_FLUSH })
    const message = output.subarray(produced)
    produced = output.length
    return message
  }
}
