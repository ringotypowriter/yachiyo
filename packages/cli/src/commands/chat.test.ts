import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createRpcClient } from '@yachiyo/shared/rpc/rpcClient'
import { createLoopbackTransportPair } from '@yachiyo/shared/rpc/loopbackTransport'
import { serveRpcTarget } from '@yachiyo/shared/rpc/rpcServer'
import { runYachiyoCli } from '../yachiyoCli.ts'

for (const reason of ['eof', 'interrupt', 'disconnect'] as const) {
  test(`idle interactive chat exits on ${reason}`, { timeout: 2_000 }, async (t) => {
    const input = Object.assign(new PassThrough(), { isTTY: true })
    const [clientTransport, serverTransport] = createLoopbackTransportPair()
    const client = createRpcClient(clientTransport)
    t.after(() => {
      input.destroy()
      client.close()
    })
    const closed = new Promise<void>((resolve) => clientTransport.onClose(resolve))
    const reading = once(input, 'resume')
    const result = runYachiyoCli(['chat'], {
      stdin: input as unknown as NodeJS.ReadStream,
      connectHeadless: async () => ({ client, closed })
    })
    const checked = reason === 'disconnect' ? assert.rejects(result, /disconnected/) : result
    await reading
    if (reason === 'eof') input.end()
    else if (reason === 'interrupt') process.emit('SIGINT')
    else serverTransport.close()
    await checked
  })
}

test('chat resolves a new workspace in the client directory and rejects changing a resumed thread', async (t) => {
  const [clientTransport, serverTransport] = createLoopbackTransportPair()
  const client = createRpcClient(clientTransport)
  const closed = new Promise<void>((resolve) => clientTransport.onClose(resolve))
  let workspace: string | undefined
  const dispose = serveRpcTarget({
    transport: serverTransport,
    target: {
      createThread: (input: { workspacePath: string }) => {
        workspace = input.workspacePath
        return { id: 'thread' }
      },
      watchThread: () => {},
      sendChat: () => {
        serverTransport.post({
          kind: 'rpc:event',
          payload: { type: 'run.completed', threadId: 'thread', runId: 'run' }
        })
        return { kind: 'run-started', thread: { id: 'thread' }, runId: 'run' }
      }
    }
  })
  t.after(() => {
    dispose()
    client.close()
  })
  await runYachiyoCli(['chat', 'hello', '--workspace', '.'], {
    connectHeadless: async () => ({ client, closed }),
    stdout: { write: () => true },
    stderr: { write: () => true }
  })
  assert.equal(workspace, process.cwd())
  await assert.rejects(
    runYachiyoCli(['chat', 'hello', '--thread', 'existing', '--workspace', '.']),
    /new thread/
  )
})
