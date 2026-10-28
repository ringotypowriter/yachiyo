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

test('wire bytes preserve subarray boundaries, all byte values and base64 padding', () => {
  for (const length of [0, 1, 2, 3, 8191, 8192, 8193, 16385]) {
    const storage = Uint8Array.from({ length: length + 32 }, (_, index) => index % 256)
    const value = storage.subarray(11, 11 + length)
    const original = storage.slice()
    const message: RpcMessage = { kind: 'rpc:response', id: 1, ok: true, value }
    assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
    assert.deepEqual(storage, original)
  }
})

test('wire decoding rejects malformed base64 instead of returning partial bytes', () => {
  for (const value of ['%', 'a', 'AA===']) {
    const frame = JSON.stringify({
      kind: 'rpc:event',
      payload: { $yachiyoRpc: 'bytes', value }
    })
    assert.throws(() => decodeRpcMessage(frame))
  }
})

test('nested optional fields and escaped records survive without changing the input', () => {
  const record = Object.freeze({
    ...JSON.parse('{"__proto__":{"polluted":true}}'),
    $yachiyoRpc: 'record',
    value: undefined
  })
  const shared = Object.freeze({ optional: undefined, record })
  const message: RpcMessage = {
    kind: 'rpc:event',
    payload: Object.freeze({ items: Object.freeze([undefined, shared, shared]) })
  }
  assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})

test('wire decoding rejects malformed messages and deeply nested input', () => {
  for (const frame of ['null', '{}', '{"kind":"rpc:request","id":-1,"method":"x","args":[]}']) {
    assert.throws(() => decodeRpcMessage(frame))
  }
  assert.throws(() => decodeRpcMessage('['.repeat(65) + '0' + ']'.repeat(65)), /nesting/)
  assert.throws(
    () =>
      encodeRpcMessage({
        kind: 'rpc:event',
        payload: JSON.parse('['.repeat(65) + '0' + ']'.repeat(65))
      }),
    /nesting/
  )
})
