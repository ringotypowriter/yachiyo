import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcClient } from './rpcClient.ts'
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
