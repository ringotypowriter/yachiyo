import { crc32, gzip, inflateRaw } from 'node:zlib'

import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'
import {
  REMOTE_COMPRESSION,
  REMOTE_COMPRESSED_MESSAGE_TAG,
  REMOTE_COMPRESSION_MIN_BYTES,
  REMOTE_COMPRESSION_MIN_SAVING_BYTES
} from '@yachiyo/shared/remote/wire'

export type RemoteCompression = typeof REMOTE_COMPRESSION | undefined

function checkSize(bytes: Buffer): void {
  if (bytes.length > REMOTE_MAX_MESSAGE_BYTES)
    throw new Error('Remote message exceeds the size limit.')
}

function checkRaw(bytes: Buffer): void {
  checkSize(bytes)
  if (bytes[0] !== 0x7b) throw new Error('Remote message must start with a JSON object.')
}

/** Encode independent messages; callers must explicitly skip secret-bearing pairing grants. */
export async function encodeRemoteMessage(
  plaintext: Buffer,
  compression: RemoteCompression,
  options: { skipCompression?: boolean } = {}
): Promise<Buffer> {
  checkRaw(plaintext)
  if (!compression || options.skipCompression || plaintext.length < REMOTE_COMPRESSION_MIN_BYTES) {
    return plaintext
  }
  const compressed = await new Promise<Buffer>((resolve, reject) => {
    gzip(plaintext, { level: 1 }, (error, result) => (error ? reject(error) : resolve(result)))
  })
  if (plaintext.length - compressed.length - 1 < REMOTE_COMPRESSION_MIN_SAVING_BYTES)
    return plaintext
  return Buffer.concat([Buffer.from([REMOTE_COMPRESSED_MESSAGE_TAG]), compressed])
}

/** Locate the deflate stream, accepting standard gzip optional headers but not reserved flags. */
function gzipHeaderLength(member: Buffer): number {
  if (member.length < 18 || member[0] !== 0x1f || member[1] !== 0x8b || member[2] !== 8) {
    throw new Error('Invalid gzip header.')
  }
  const flags = member[3]!
  if (flags & 0xe0) throw new Error('Unsupported gzip flags.')
  let offset = 10
  const end = member.length - 8
  if (flags & 4) {
    if (offset + 2 > end) throw new Error('Truncated gzip header.')
    offset += 2 + member.readUInt16LE(offset)
  }
  for (const flag of [8, 16]) {
    if (!(flags & flag)) continue
    while (offset < end && member[offset] !== 0) offset++
    offset++
  }
  if (flags & 2) {
    if (
      offset + 2 > end ||
      (crc32(member.subarray(0, offset)) & 0xffff) !== member.readUInt16LE(offset)
    ) {
      throw new Error('Invalid gzip header checksum.')
    }
    offset += 2
  }
  if (offset >= end) throw new Error('Truncated gzip header.')
  return offset
}

/** Decode exactly one gzip member with a bounded output, rejecting concatenation and trailing bytes. */
export async function decodeRemoteMessage(
  envelope: Buffer,
  compression: RemoteCompression
): Promise<Buffer> {
  checkSize(envelope)
  if (envelope[0] === 0x7b) return envelope
  if (!compression || envelope[0] !== REMOTE_COMPRESSED_MESSAGE_TAG) {
    throw new Error('Unsupported remote message encoding.')
  }
  const member = envelope.subarray(1)
  const offset = gzipHeaderLength(member)
  const result = await new Promise<{
    buffer: Buffer
    engine: { bytesWritten: number }
  }>((resolve, reject) => {
    inflateRaw(
      member.subarray(offset),
      { maxOutputLength: REMOTE_MAX_MESSAGE_BYTES, info: true },
      (error, value) => {
        if (error) reject(error)
        // Node's declarations do not narrow the convenience callback for `info: true`.
        else
          resolve(
            value as unknown as {
              buffer: Buffer
              engine: { bytesWritten: number }
            }
          )
      }
    )
  })
  const trailer = offset + result.engine.bytesWritten
  if (trailer + 8 !== member.length)
    throw new Error('Expected a single gzip member without trailing bytes.')
  if (
    member.readUInt32LE(trailer) !== crc32(result.buffer) ||
    member.readUInt32LE(trailer + 4) !== result.buffer.length
  ) {
    throw new Error('Invalid gzip checksum or size.')
  }
  checkRaw(result.buffer)
  return result.buffer
}
