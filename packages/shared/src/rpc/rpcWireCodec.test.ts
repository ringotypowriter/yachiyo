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

test('wire messages preserve errors and streamed progress', () => {
  const messages: RpcMessage[] = [
    { kind: 'rpc:progress', id: 7, value: { chunk: new Uint8Array([128, 255]), done: false } },
    {
      kind: 'rpc:response',
      id: 7,
      ok: false,
      error: { name: 'Error', message: 'request failed', stack: 'stack line\n'.repeat(256) }
    },
    { kind: 'rpc:response', id: 7, ok: true, value: undefined }
  ]
  for (const message of messages) {
    assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
  }
})

test('wire bytes preserve subarray boundaries, all byte values and empty arrays', () => {
  for (const length of [0, 1, 2, 3, 8191, 8192, 8193, 16385]) {
    const storage = Uint8Array.from({ length: length + 32 }, (_, index) => index % 256)
    const value = storage.subarray(11, 11 + length)
    const original = storage.slice()
    const message: RpcMessage = { kind: 'rpc:response', id: 1, ok: true, value }
    assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
    assert.deepEqual(storage, original)
  }
})

test('large strings and bytes share one binary frame without base64 expansion', () => {
  const text = '\ufeff' + '中文😀"\\\n\0'.repeat(8192)
  const bytes = Uint8Array.from({ length: 65537 }, (_, index) => index % 256).subarray(7)
  const message: RpcMessage = {
    kind: 'rpc:response',
    id: 1,
    ok: true,
    value: {
      text,
      bytes,
      empty: new Uint8Array(),
      missing: undefined,
      literal: { $yachiyoRpc: 'string', length: 100 }
    }
  }
  const frame = encodeRpcMessage(message)
  assert(frame instanceof Uint8Array)
  assert(frame.byteLength < Buffer.byteLength(text) + bytes.byteLength + 1024)
  assert.deepEqual(decodeRpcMessage(frame), message)
  const padded = new Uint8Array(frame.byteLength + 8)
  padded.set(frame, 5)
  assert.deepEqual(decodeRpcMessage(padded.subarray(5, 5 + frame.byteLength)), message)
  const saved = frame.slice()
  for (const incoming of [frame, Buffer.from(frame)]) {
    const decoded = decodeRpcMessage(incoming)
    assert.deepEqual(decoded, message)
    assert(decoded.kind === 'rpc:response' && decoded.ok)
    const decodedBytes = (decoded.value as { bytes: Uint8Array }).bytes
    decodedBytes.fill(0)
    assert.deepEqual(new Uint8Array(incoming), saved)
  }
  assert.deepEqual(frame, saved, 'returned bytes must not alias the received frame')
  bytes.fill(0)
  assert.deepEqual(frame, saved, 'the outgoing frame must not alias caller-owned bytes')
})

test('large strings preserve lone surrogates', () => {
  for (const text of ['\ud800', '\udc00']) {
    const value = 'x'.repeat(65536) + text
    for (const payload of [value, { text: value, bytes: new Uint8Array([1]) }]) {
      const message: RpcMessage = { kind: 'rpc:event', payload }
      assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
    }
  }
})

test('binary parts keep their order across numeric keys and escaped user records', () => {
  const record = Object.fromEntries([
    ['10', new Uint8Array([10])],
    ['2', '中文'.repeat(2048)],
    ['01', new Uint8Array([1, 0])],
    ['__proto__', new Uint8Array([255])]
  ])
  const message: RpcMessage = {
    kind: 'rpc:request',
    id: 1,
    method: 'echo',
    args: [record, { ...record, $yachiyoRpc: 'bytes' }]
  }
  assert.deepEqual(decodeRpcMessage(encodeRpcMessage(message)), message)
})

function binaryFrame(header: unknown, payload = new Uint8Array()): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header))
  const frame = new Uint8Array(4 + json.length + payload.length)
  new DataView(frame.buffer).setUint32(0, json.length, true)
  frame.set(json, 4)
  frame.set(payload, 4 + json.length)
  return frame
}

test('binary decoding rejects truncated, unused and invalid UTF-8 payloads', () => {
  for (const length of [-1, 0.5, 2, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() =>
      decodeRpcMessage(
        binaryFrame(
          { kind: 'rpc:event', payload: { $yachiyoRpc: 'bytes', length } },
          new Uint8Array(1)
        )
      )
    )
  }
  for (const frame of [
    new Uint8Array(3),
    new Uint8Array([255, 255, 255, 255]),
    new Uint8Array([1, 0, 0, 0, 255]),
    binaryFrame({ kind: 'rpc:event', payload: null }, new Uint8Array(1)),
    binaryFrame(
      { kind: 'rpc:event', payload: { $yachiyoRpc: 'string', length: 1 } },
      new Uint8Array([255])
    )
  ]) {
    assert.throws(() => decodeRpcMessage(frame))
  }
  assert.throws(() =>
    decodeRpcMessage('{"kind":"rpc:event","payload":{"$yachiyoRpc":"bytes","length":0}}')
  )
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
  for (const frame of [
    'null',
    '{}',
    '{"kind":"rpc:request","id":-1,"method":"x","args":[]}',
    '{"kind":"rpc:response","id":1,"ok":false}',
    '{"kind":"rpc:response","id":1,"ok":"true","value":1}',
    '{"kind":"rpc:progress","id":-1,"value":null}',
    '{"kind":"unknown","payload":null}'
  ]) {
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
