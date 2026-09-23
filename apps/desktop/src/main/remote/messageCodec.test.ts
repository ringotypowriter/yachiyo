import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { crc32, gzipSync } from 'node:zlib'

import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'

import { decodeRemoteMessage, encodeRemoteMessage } from './messageCodec.ts'

const raw = (length: number): Buffer => Buffer.from(`{"v":"${'a'.repeat(length - 8)}"}`)
const frame = (bytes: Buffer): Buffer => Buffer.concat([Buffer.from([1]), gzipSync(bytes)])

test('compression threshold is inclusive and raw bytes remain untouched', async () => {
  const below = raw(1023)
  assert.equal(await encodeRemoteMessage(below, 'gzip'), below)
  const input = raw(1024)
  const encoded = await encodeRemoteMessage(input, 'gzip')
  assert.equal(encoded[0], 1)
  assert.ok(input.length - encoded.length >= 32)
  assert.deepEqual(await decodeRemoteMessage(encoded, 'gzip'), input)
})

test('legacy and explicitly secret messages are never compressed', async () => {
  const input = raw(4096)
  assert.equal(await encodeRemoteMessage(input, undefined), input)
  assert.equal(await encodeRemoteMessage(input, 'gzip', { skipCompression: true }), input)
  assert.equal(await decodeRemoteMessage(input, undefined), input)
  await assert.rejects(decodeRemoteMessage(frame(input), undefined))
})

test('incompressible bytes fall back unchanged', async () => {
  const input = randomBytes(1024)
  input[0] = 0x7b
  assert.equal(await encodeRemoteMessage(input, 'gzip'), input)
})

test('raw size limit is inclusive for encoding and decoding', async () => {
  const input = raw(REMOTE_MAX_MESSAGE_BYTES)
  assert.equal(await encodeRemoteMessage(input, undefined), input)
  assert.equal(await decodeRemoteMessage(input, 'gzip'), input)
  await assert.rejects(encodeRemoteMessage(raw(REMOTE_MAX_MESSAGE_BYTES + 1), 'gzip'))
  await assert.rejects(decodeRemoteMessage(raw(REMOTE_MAX_MESSAGE_BYTES + 1), 'gzip'))
})

test('decoded gzip output is bounded separately from the encoded envelope', async () => {
  await assert.rejects(decodeRemoteMessage(frame(raw(REMOTE_MAX_MESSAGE_BYTES + 1)), 'gzip'))
  const oversized = Buffer.alloc(REMOTE_MAX_MESSAGE_BYTES + 1, 1)
  await assert.rejects(decodeRemoteMessage(oversized, 'gzip'))
  const input = raw(REMOTE_MAX_MESSAGE_BYTES)
  assert.deepEqual(await decodeRemoteMessage(frame(input), 'gzip'), input)
})

for (const [name, bytes] of [
  ['empty envelope', Buffer.alloc(0)],
  ['empty gzip', Buffer.from([1])],
  ['unknown prefix', Buffer.from([2, 123, 125])],
  ['non-object JSON', Buffer.from('[]')],
  ['invalid gzip', Buffer.from([1, 2, 3, 4])],
  ['truncated gzip', frame(raw(1024)).subarray(0, -1)],
  ['empty decoded bytes', frame(Buffer.alloc(0))],
  ['decoded non-object', frame(Buffer.from('[]'))],
  ['concatenated members', Buffer.concat([frame(raw(1024)), gzipSync(raw(1024))])],
  ['trailing zero', Buffer.concat([frame(raw(1024)), Buffer.from([0])])],
  ['trailing junk', Buffer.concat([frame(raw(1024)), Buffer.from('junk')])]
] as const) {
  test(`rejects ${name}`, async () => {
    await assert.rejects(decodeRemoteMessage(bytes, 'gzip'))
  })
}

test('rejects corrupted CRC, size, and reserved flags', async () => {
  const crc = frame(raw(1024))
  crc[crc.length - 8]! ^= 1
  await assert.rejects(decodeRemoteMessage(crc, 'gzip'))
  const size = frame(raw(1024))
  size[size.length - 1]! ^= 1
  await assert.rejects(decodeRemoteMessage(size, 'gzip'))
  const flags = frame(raw(1024))
  flags[4] = 0xe0
  await assert.rejects(decodeRemoteMessage(flags, 'gzip'))
})

test('accepts standard optional gzip headers and checks header CRC', async () => {
  const input = raw(1024)
  const member = gzipSync(input)
  const header = Buffer.concat([
    member.subarray(0, 10),
    Buffer.from([2, 0, 1, 2]),
    Buffer.from('name\0comment\0')
  ])
  header[3] = 4 | 8 | 16 | 2
  const checksum = Buffer.alloc(2)
  checksum.writeUInt16LE(crc32(header) & 0xffff)
  const encoded = Buffer.concat([Buffer.from([1]), header, checksum, member.subarray(10)])
  assert.deepEqual(await decodeRemoteMessage(encoded, 'gzip'), input)
  encoded[1 + header.length]! ^= 1
  await assert.rejects(decodeRemoteMessage(encoded, 'gzip'))
})
