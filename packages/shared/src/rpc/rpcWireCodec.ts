import { z } from 'zod'

import type { RpcMessage } from './rpcTransport.ts'

const requestId = z.number().int().positive().safe()
const messageSchema = z.union([
  z.object({
    kind: z.literal('rpc:request'),
    id: requestId,
    method: z.string().min(1).max(200),
    args: z.array(z.unknown()).max(16),
    expectsProgress: z.boolean().optional()
  }),
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
  }),
  z.object({ kind: z.literal('rpc:progress'), id: requestId, value: z.unknown() }),
  z.object({ kind: z.literal('rpc:event'), payload: z.unknown() })
])

const MAX_DEPTH = 64
const TAG = '$yachiyoRpc'

function encodeValue(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('RPC value exceeds the nesting limit')
  if (value === undefined) return { [TAG]: 'undefined' }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error('RPC values must be JSON data or bytes')
  if (ancestors.has(value)) throw new Error('RPC values cannot contain cycles')
  if (value instanceof Uint8Array) {
    // Node can encode the exact byte view without expanding it into a JS string.
    if (typeof Buffer !== 'undefined') {
      return {
        [TAG]: 'bytes',
        value: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')
      }
    }
    let binary = ''
    for (let offset = 0; offset < value.length; offset += 8192) {
      binary += String.fromCharCode(...value.subarray(offset, offset + 8192))
    }
    return { [TAG]: 'bytes', value: btoa(binary) }
  }
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('RPC values must be plain records, arrays or bytes')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => encodeValue(item, ancestors, depth + 1))
    const entries = Object.entries(value)
    for (const entry of entries) entry[1] = encodeValue(entry[1], ancestors, depth + 1)
    // Escape user records containing our tag, so ordinary data never becomes a typed value.
    return Object.hasOwn(value, TAG)
      ? { [TAG]: 'record', value: entries }
      : Object.fromEntries(entries)
  } finally {
    ancestors.delete(value)
  }
}

function decodeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('RPC value exceeds the nesting limit')
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      value[index] = decodeValue(value[index], depth + 1)
    }
    return value
  }
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, TAG)) {
    if (record[TAG] === 'undefined' && Object.keys(record).length === 1) return undefined
    if (record[TAG] === 'bytes' && typeof record.value === 'string') {
      const binary = atob(record.value)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return bytes
    }
    if (record[TAG] === 'record' && Array.isArray(record.value)) {
      const entries = record.value.map((entry: unknown) => {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
          throw new Error('Invalid RPC record')
        }
        return [entry[0], decodeValue(entry[1], depth + 1)]
      })
      return Object.fromEntries(entries)
    }
    throw new Error('Invalid RPC typed value')
  }
  // JSON.parse owns these records, including any own __proto__ data property.
  // Replace typed values in place so ordinary snapshots do not get copied again.
  for (const key of Object.keys(record)) record[key] = decodeValue(record[key], depth + 1)
  return record
}

/** JSON transport encoding, including the bytes and undefined values used by host RPC. */
export function encodeRpcMessage(message: RpcMessage): string {
  return JSON.stringify(encodeValue(message, new Set(), 0))
}

export function decodeRpcMessage(frame: string): RpcMessage {
  return messageSchema.parse(decodeValue(JSON.parse(frame), 0)) as RpcMessage
}
