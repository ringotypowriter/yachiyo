import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcClient } from './rpcClient.ts'
import type { RpcMessage } from './rpcTransport.ts'
import { encodeRpcMessage } from './rpcWireCodec.ts'
import { createWebSocketRpcTransport, type RpcWebSocket } from './webSocketRpcTransport.ts'

test('an unsolicited response closes the peer instead of escaping into the app server', () => {
  let receive: ((event: { data: unknown }) => void) | undefined
  let closed = false
  const socket = {
    readyState: 1,
    bufferedAmount: 0,
    send() {
      assert.fail('An unsolicited response must not send a request')
    },
    close() {
      closed = true
    },
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      if (type === 'message') receive = listener
    },
    removeEventListener(type: string) {
      if (type === 'message') receive = undefined
    }
  } as RpcWebSocket
  createRpcClient(createWebSocketRpcTransport(socket))
  assert.doesNotThrow(() =>
    receive!({ data: encodeRpcMessage({ kind: 'rpc:response', id: 99, ok: true, value: null }) })
  )
  assert.equal(closed, true)
})

test('frame limits count UTF-8 bytes and queued output at exact boundaries', () => {
  for (const text of ['a', 'é', '中', '😀', '\ud800', '\udc00']) {
    for (const direction of ['send', 'receive']) {
      const message: RpcMessage = { kind: 'rpc:event', payload: text.repeat(100) }
      // Include raw lone surrogates on receive; JSON.stringify escapes them on send.
      const frame =
        direction === 'send'
          ? encodeRpcMessage(message)
          : `{"kind":"rpc:event","payload":"${message.payload}"}`
      const byteLength = Buffer.byteLength(frame)
      for (const remaining of [frame.length - 1, byteLength - 1, byteLength, frame.length * 3]) {
        let receive: ((event: { data: unknown }) => void) | undefined
        let closed = false
        const sent: string[] = []
        const received: RpcMessage[] = []
        const bufferedAmount = direction === 'send' ? 256 : 0
        const socket: RpcWebSocket = {
          readyState: 1,
          bufferedAmount,
          send(data) {
            sent.push(data)
          },
          close() {
            closed = true
          },
          addEventListener(type, listener) {
            if (type === 'message') receive = listener
          },
          removeEventListener(type) {
            if (type === 'message') receive = undefined
          }
        }
        const transport = createWebSocketRpcTransport(socket, {
          maxBytes: remaining + bufferedAmount
        })
        transport.onMessage((value) => received.push(value))
        const oversized = byteLength > remaining
        if (direction === 'send') {
          if (oversized) assert.throws(() => transport.post(message), /output buffer limit/)
          else transport.post(message)
          assert.deepEqual(sent, oversized ? [] : [frame])
        } else {
          receive!({ data: frame })
          assert.deepEqual(received, oversized ? [] : [message])
        }
        assert.equal(closed, oversized)
        transport.close()
      }
    }
  }
})
