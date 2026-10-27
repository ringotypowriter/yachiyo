import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import { runChatTurn } from './chat.ts'

test('chat preserves streaming events delivered before the send response and filters other runs', async (t) => {
  const [clientTransport, serverTransport] = createLoopbackTransportPair()
  const client = createRpcClient(clientTransport)
  const closed = new Promise<void>((resolve) => clientTransport.onClose(resolve))
  const calls: string[] = []
  const dispose = serveRpcTarget({
    transport: serverTransport,
    target: {
      createThread: () => ({ id: 'thread' }),
      watchThread: (id: string) => {
        assert.equal(id, 'thread')
        calls.push('watch')
      },
      sendChat: () => {
        calls.push('send')
        for (const event of [
          { type: 'message.delta', threadId: 'other', runId: 'run', delta: 'wrong thread' },
          { type: 'message.delta', threadId: 'thread', runId: 'previous-run', delta: 'wrong run' },
          { type: 'message.delta', threadId: 'thread', runId: 'run', delta: 'answer' },
          { type: 'run.completed', threadId: 'thread', runId: 'run' }
        ])
          serverTransport.post({ kind: 'rpc:event', payload: event })
        return { kind: 'run-started', thread: { id: 'thread' }, runId: 'run' }
      }
    }
  })
  t.after(() => {
    dispose()
    client.close()
  })
  let text = ''
  const threadId = await runChatTurn(
    { client, closed },
    {
      content: 'hello',
      onEvent: (event) => {
        if (event.type === 'message.delta') text += event.delta
      }
    }
  )
  assert.equal(threadId, 'thread')
  assert.equal(text, 'answer')
  assert.deepEqual(calls, ['watch', 'send'])
})
