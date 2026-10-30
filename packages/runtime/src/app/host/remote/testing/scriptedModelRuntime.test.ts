import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelStreamRequest } from '../../../../runtime/models/types.ts'
import { createScriptedModelRuntime } from './scriptedModelRuntime.ts'

test('scripted retries stay observable until the phone cancels or the provider resumes', async () => {
  const controller = new AbortController()
  let reportRetry: (error: unknown) => void
  const retryReported = new Promise<unknown>((resolve) => {
    reportRetry = resolve
  })
  const request = {
    messages: [{ role: 'user', content: 'retry: Connection reset by server' }],
    signal: controller.signal,
    onRetry: (_attempt: number, _max: number, _delay: number, error: unknown) => reportRetry(error)
  } as unknown as ModelStreamRequest
  const iterator = createScriptedModelRuntime({ slowChunkDelayMs: 1000 })
    .streamReply(request)
    [Symbol.asyncIterator]()
  const next = iterator.next()
  try {
    const first = await Promise.race([
      retryReported,
      next.then(
        () => null,
        () => null
      )
    ])
    assert.ok(first instanceof Error)
    assert.equal(first.message, 'Connection reset by server')
    controller.abort()
    await assert.rejects(next, { name: 'AbortError' })
  } finally {
    controller.abort()
  }
})

test('scripted background commands consume streaming tool execution before reporting completion', async () => {
  let executed = false
  let output: unknown
  const final = { content: [{ type: 'text', text: 'started' }], metadata: { taskId: 'task-1' } }
  const request = {
    messages: [{ role: 'user', content: 'background: mobile task' }],
    signal: new AbortController().signal,
    tools: {
      bash: {
        async *execute() {
          executed = true
          yield final
        }
      }
    },
    onToolCallFinish: (event: { output?: unknown }) => {
      output = event.output
    }
  } as unknown as ModelStreamRequest
  let reply = ''
  for await (const chunk of createScriptedModelRuntime().streamReply(request)) reply += chunk
  assert.match(reply, /running in the background/)
  assert.equal(executed, true)
  assert.deepEqual(output, final)
})
