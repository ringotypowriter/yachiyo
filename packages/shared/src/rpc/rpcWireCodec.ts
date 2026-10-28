import { z } from 'zod'

import type { RpcMessage } from './rpcTransport.ts'

const requestId = z.number().int().positive().safe()
const messageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rpc:request'),
    id: requestId,
    method: z.string().min(1).max(200),
    args: z.array(z.unknown()).max(16),
    expectsProgress: z.boolean().optional()
  }),
  z.discriminatedUnion('ok', [
    z.object({
      kind: z.literal('rpc:response'),
      id: requestId,
      ok: z.literal(true),
      value: z.unknown().optional()
    }),
    z.object({
      kind: z.literal('rpc:response'),
      id: requestId,
      ok: z.literal(false),
      error: z.object({ name: z.string(), message: z.string(), stack: z.string().optional() })
    })
  ]),
  z.object({ kind: z.literal('rpc:progress'), id: requestId, value: z.unknown() }),
  z.object({ kind: z.literal('rpc:event'), payload: z.unknown() })
])

const MAX_DEPTH = 64
const TAG = '$yachiyoRpc'
const BINARY_STRING_LENGTH = 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

interface BinaryPayload {
  frame: Uint8Array
  offset: number
}

function encodeValue(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
  parts: Uint8Array[]
): unknown {
  if (depth > MAX_DEPTH) throw new Error('RPC value exceeds the nesting limit')
  if (value === undefined) return { [TAG]: 'undefined' }
  if (typeof value === 'string' && value.length >= BINARY_STRING_LENGTH && value.isWellFormed()) {
    const bytes = encoder.encode(value)
    parts.push(bytes)
    return { [TAG]: 'string', length: bytes.byteLength }
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error('RPC values must be JSON data or bytes')
  if (ancestors.has(value)) throw new Error('RPC values cannot contain cycles')
  if (value instanceof Uint8Array) {
    parts.push(value)
    return { [TAG]: 'bytes', length: value.byteLength }
  }
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('RPC values must be plain records, arrays or bytes')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value))
      return value.map((item) => encodeValue(item, ancestors, depth + 1, parts))
    const entries = Object.entries(value)
    // Escape user records containing our tag, so ordinary data never becomes a typed value.
    if (Object.hasOwn(value, TAG)) {
      for (const entry of entries) entry[1] = encodeValue(entry[1], ancestors, depth + 1, parts)
      return { [TAG]: 'record', value: entries }
    }
    const record: Record<string, unknown> = {}
    for (const [key, item] of entries) {
      const encoded = encodeValue(item, ancestors, depth + 1, parts)
      if (key === '__proto__') {
        Object.defineProperty(record, key, {
          value: encoded,
          enumerable: true,
          configurable: true,
          writable: true
        })
      } else record[key] = encoded
    }
    return record
  } finally {
    ancestors.delete(value)
  }
}

function decodeValue(value: unknown, depth: number, payload?: BinaryPayload): unknown {
  if (depth > MAX_DEPTH) throw new Error('RPC value exceeds the nesting limit')
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = decodeValue(value[index], depth + 1, payload)
    }
    return value
  }
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, TAG)) {
    if (record[TAG] === 'undefined' && Object.keys(record).length === 1) return undefined
    if (record[TAG] === 'bytes' || record[TAG] === 'string') {
      const length = record.length
      if (
        !payload ||
        Object.keys(record).length !== 2 ||
        typeof length !== 'number' ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > payload.frame.byteLength - payload.offset
      ) {
        throw new Error('Invalid RPC binary payload')
      }
      const bytes = payload.frame.subarray(payload.offset, payload.offset + length)
      payload.offset += length
      // Copy even Node Buffer views; Buffer.slice() would retain and alias the received frame.
      return record[TAG] === 'bytes' ? new Uint8Array(bytes) : decoder.decode(bytes)
    }
    if (record[TAG] === 'record' && Array.isArray(record.value)) {
      const entries = record.value.map((entry: unknown) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          throw new Error('Invalid RPC record')
        }
        return [entry[0], decodeValue(entry[1], depth + 1, payload)]
      })
      return Object.fromEntries(entries)
    }
    throw new Error('Invalid RPC typed value')
  }
  // JSON.parse owns these records, including any own __proto__ data property.
  // Replace typed values in place so ordinary snapshots do not get copied again.
  for (const key of Object.keys(record)) record[key] = decodeValue(record[key], depth + 1, payload)
  return record
}

/** Small messages use JSON. Binary frames contain a uint32 LE header length, JSON, then raw parts.
 * Parts follow the typed values in JSON traversal order, without offsets or reusable references.
 */
export function encodeRpcMessage(message: RpcMessage): string | Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  const json = JSON.stringify(encodeValue(message, new Set(), 0, parts))
  if (parts.length === 0) return json
  const header = encoder.encode(json)
  const size = 4 + header.byteLength + parts.reduce((total, part) => total + part.byteLength, 0)
  const frame = new Uint8Array(size)
  new DataView(frame.buffer).setUint32(0, header.byteLength, true)
  frame.set(header, 4)
  let offset = 4 + header.byteLength
  for (const part of parts) {
    frame.set(part, offset)
    offset += part.byteLength
  }
  return frame
}

export function decodeRpcMessage(frame: string | Uint8Array): RpcMessage {
  if (typeof frame === 'string') {
    return messageSchema.parse(decodeValue(JSON.parse(frame), 0)) as RpcMessage
  }
  if (frame.byteLength < 4) throw new Error('Invalid RPC binary header')
  const headerLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
    0,
    true
  )
  if (headerLength > frame.byteLength - 4) throw new Error('Invalid RPC binary header')
  const payload = { frame, offset: 4 + headerLength }
  const header = JSON.parse(decoder.decode(frame.subarray(4, payload.offset)))
  const message = decodeValue(header, 0, payload)
  if (payload.offset !== frame.byteLength) throw new Error('Unused RPC binary payload')
  return messageSchema.parse(message) as RpcMessage
}
