import assert from 'node:assert/strict'
import test from 'node:test'

import type { RpcMessage } from './rpcTransport.ts'
import { decodeRpcMessage, encodeRpcMessage } from './rpcWireCodec.ts'

test('wire messages preserve host byte streams, optional arguments and colliding user records', () => {
  const message: RpcMessage = {
    kind: 'rpc:request',
    id: 31,
    method: 'fetch',
    args: [
      undefined,
      { body: new Uint8Array([0, 255, 128]), missing: undefined },
      { $yachiyoRpc: 'bytes', value: 'ordinary user data' },
      JSON.parse('{"__proto__":{"polluted":true}}')
    ]
  }
  assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})

test('wire encoding rejects values that JSON would silently change', () => {
  for (const value of [NaN, Infinity, () => {}, new Map(), new Date()]) {
    assert.throws(() => encodeRpcMessage({ kind: 'rpc:event', payload: value }))
  }
  const cyclic: unknown[] = []
  cyclic.push(cyclic)
  assert.throws(() => encodeRpcMessage({ kind: 'rpc:event', payload: cyclic }), /cycles/)
})

test('wire decoding rejects malformed messages and deeply nested input', () => {
  for (const frame of ['null', '{}', '{"kind":"rpc:request","id":-1,"method":"x","args":[]}']) {
    assert.throws(() => decodeRpcMessage(frame))
  }
  assert.throws(() => decodeRpcMessage('['.repeat(65) + '0' + ']'.repeat(65)), /nesting/)
})
