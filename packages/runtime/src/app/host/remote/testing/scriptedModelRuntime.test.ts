import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelStreamRequest } from '../../../../runtime/models/types.ts'
import { createScriptedModelRuntime } from './scriptedModelRuntime.ts'

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
