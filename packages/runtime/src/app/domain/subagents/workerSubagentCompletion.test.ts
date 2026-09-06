import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ModelRuntime, ModelStreamRequest } from '../../../runtime/models/types.ts'
import { RetryableRunError } from '../../../runtime/models/runtimeErrors.ts'
import { SubagentTurnError } from './subagentManager.ts'
import { createWorkerSubagentRunnerFactory } from './workerSubagentRunner.ts'

async function withRunner(
  streamReply: ModelRuntime['streamReply'],
  check: (
    runner: ReturnType<ReturnType<typeof createWorkerSubagentRunnerFactory>>
  ) => Promise<void>,
  hasPendingMessages: () => boolean = () => false
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'worker-completion-'))
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'explore',
    profile: { systemPrompt: 'Inspect and report.', allowedTools: ['read'], maxToolSteps: 4 },
    dependencies: {
      settings: {
        providerName: 'test',
        provider: 'openai',
        model: 'test',
        apiKey: '',
        baseUrl: ''
      },
      parentToolContext: { workspacePath },
      parentDependencies: {},
      createModelRuntime: () => ({ streamReply }) as ModelRuntime
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent',
      parentThreadId: 'parent',
      launchRunId: 'run',
      agentName: 'explore',
      agentType: 'explore',
      codeName: 'Akari',
      workspacePath,
      prompt: 'Inspect'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({ messageId: 'message', delivery: 'queued', recipientState: 'idle' }),
    getTask: () => undefined,
    hasPendingMessages,
    onProgress: () => {},
    onToolCall: () => {}
  })
  try {
    await check(runner)
  } finally {
    await runner.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
}

const turn = {
  turnId: 'turn',
  initialPrompt: 'Inspect',
  messages: [],
  signal: new AbortController().signal
}
function finishWithToolResult(request: ModelStreamRequest): void {
  request.onFinish?.({
    promptTokens: 3,
    completionTokens: 2,
    responseMessages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'read-1', toolName: 'read', input: { path: 'fixture' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'read-1',
            toolName: 'read',
            output: { type: 'text', value: 'evidence' }
          }
        ]
      }
    ]
  } as never)
}

test('mailbox stop is a yield, not a completed report', async () => {
  await withRunner(
    async function* (request) {
      const stops = Array.isArray(request.stopWhen) ? request.stopWhen : [request.stopWhen]
      assert.ok(await stops.at(-1)!({ steps: [{ toolResults: [{}] }] } as never))
      finishWithToolResult(request)
      yield* []
    },
    async (runner) => {
      const result = await runner.runTurn(turn)
      assert.equal(result.yielded, true)
      assert.equal(result.output, '')
    },
    () => true
  )
})

test('tool-only completion requests one final report without rerunning tools', async () => {
  let attempts = 0
  await withRunner(
    async function* (request) {
      attempts++
      if (attempts === 1) {
        yield 'Inspecting the file'
        finishWithToolResult(request)
        return
      }
      assert.equal(request.tools, undefined)
      assert.match(JSON.stringify(request.messages), /evidence/)
      request.onFinish?.({ promptTokens: 5, completionTokens: 4 } as never)
      yield 'Verified report'
    },
    async (runner) => {
      const result = await runner.runTurn(turn)
      assert.equal(result.output, 'Verified report')
      assert.equal(result.promptTokens, 8)
      assert.equal(result.completionTokens, 6)
      assert.equal(attempts, 2)
    }
  )
})

test('interrupted reporting retries without tools and keeps partial report history', async () => {
  let attempts = 0
  await withRunner(
    async function* (request) {
      attempts++
      if (attempts === 1) {
        finishWithToolResult(request)
        return
      }
      assert.equal(request.tools, undefined)
      if (attempts === 2) {
        yield 'Partial report'
        throw new RetryableRunError('network interrupted')
      }
      assert.match(JSON.stringify(request.messages), /Partial report/)
      yield 'Recovered final report'
    },
    async (runner) => {
      const result = await runner.runTurn(turn)
      assert.match(result.output, /Recovered final report/)
      assert.equal(attempts, 3)
    }
  )
})

test('repeated empty completion fails explicitly instead of claiming success', async () => {
  let attempts = 0
  await withRunner(
    async function* () {
      attempts++
      yield* []
    },
    async (runner) => {
      await assert.rejects(runner.runTurn(turn), /final report/i)
      assert.equal(attempts, 2)
    }
  )
})

test('empty final reporting exposes already incurred usage on its error', async () => {
  await withRunner(
    async function* (request) {
      request.onFinish?.({ promptTokens: 3, completionTokens: 2 } as never)
      yield* []
    },
    async (runner) => {
      await assert.rejects(runner.runTurn(turn), (error: unknown) => {
        assert.ok(error instanceof SubagentTurnError)
        assert.deepEqual(error.usage, { promptTokens: 6, completionTokens: 4 })
        return true
      })
    }
  )
})
