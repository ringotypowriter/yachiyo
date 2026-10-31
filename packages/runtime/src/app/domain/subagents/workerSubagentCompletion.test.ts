import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ModelRuntime, ModelStreamRequest } from '../../../runtime/models/types.ts'
import { RetryableRunError } from '../../../runtime/models/runtimeErrors.ts'
import { SubagentTurnError } from './subagentManager.ts'
import { createWorkerSubagentRunnerFactory } from './workerSubagentRunner.ts'
import { DEFAULT_NAMED_SUBAGENT_PROFILES } from '../../../settings/namedSubagents.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { YachiyoStorage } from '../../../storage/storage.ts'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { DEFAULT_SETTINGS_CONFIG } from '../../../settings/settingsDefaults.ts'
import { readPluginDiagnostics } from '../../../services/plugins/pluginDiagnostics.ts'

async function withRunner(
  streamReply: ModelRuntime['streamReply'],
  check: (
    runner: ReturnType<ReturnType<typeof createWorkerSubagentRunnerFactory>>
  ) => Promise<void>,
  hasPendingMessages: () => boolean = () => false,
  unavailableTools?: readonly string[],
  sourceQueryStorage?: YachiyoStorage,
  config?: SettingsConfig,
  readConfig?: () => SettingsConfig
): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'worker-completion-'))
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'explore',
    profile: { systemPrompt: 'Inspect and report.', allowedTools: ['read'], maxToolSteps: 4 },
    dependencies: {
      config,
      settings: {
        providerName: 'test',
        provider: 'openai',
        model: 'test',
        apiKey: '',
        baseUrl: ''
      },
      parentToolContext: { workspacePath },
      parentDependencies: { unavailableTools, sourceQueryStorage, readConfig },
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
    eliminateTask: () => false,
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

test('worker turns use plugin input, model, step and lifecycle hooks with their own context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-worker-plugins-'))
  const previousHome = process.env.YACHIYO_HOME
  process.env.YACHIYO_HOME = root
  t.after(async () => {
    if (previousHome === undefined) delete process.env.YACHIYO_HOME
    else process.env.YACHIYO_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'plugins'))
  await writeFile(
    join(root, 'plugins', 'worker.js'),
    `export default {apiVersion: 1, hooks: {
    runStart({context}) {if (context.purpose !== 'subagent') throw new Error('wrong purpose'); return {maxSteps: 2}},
    beforeInput({text}) {return {text: text + ':handled'}},
    beforeModel({messages}) {return {messages: [...messages, {role: 'system', content: 'worker-hook'}]}},
    afterStep() {return {stop: true}},
    runEnd() {}
  }}`
  )
  let requests = 0
  let liveConfig: SettingsConfig = {
    ...DEFAULT_SETTINGS_CONFIG,
    plugins: { enabled: ['worker.js'] },
    chat: { stripCompact: false }
  }
  await withRunner(
    async function* (request) {
      requests++
      if (requests === 2) {
        assert.equal(request.prepareStep, undefined)
        assert.equal(request.maxToolSteps, 4)
        yield 'Disabled'
        return
      }
      assert.equal(request.maxToolSteps, 2)
      assert.ok(
        request.messages.some(
          (message) => message.role === 'user' && message.content === 'Inspect:handled'
        )
      )
      assert.ok(request.prepareStep)
      const prepared = await request.prepareStep({
        messages: request.messages,
        settings: request.settings,
        stepNumber: 0,
        options: {}
      })
      assert.equal(prepared.messages?.at(-1)?.content, 'worker-hook')
      assert.deepEqual(
        await request.onStepEnd?.({
          stepNumber: 0,
          text: 'Done',
          finishReason: 'stop',
          messages: prepared.messages!,
          usage: { promptTokens: 10, completionTokens: 2 }
        }),
        { stop: true }
      )
      yield 'Done'
    },
    async (runner) => {
      assert.equal((await runner.runTurn(turn)).output, 'Done')
      liveConfig = { ...liveConfig, plugins: { enabled: [] } }
      assert.equal((await runner.runTurn({ ...turn, turnId: 'second' })).output, 'Disabled')
    },
    undefined,
    undefined,
    undefined,
    liveConfig,
    () => liveConfig
  )
  assert.equal(requests, 2)
  const [report] = (await readPluginDiagnostics('worker.js', join(root, 'plugins'))) as Array<{
    status: string
    hooks: Array<{ hook: string; calls: number }>
  }>
  assert.equal(report.status, 'completed')
  assert.equal(report.hooks.find((hook) => hook.hook === 'runEnd')?.calls, 1)
})

const turn = {
  turnId: 'turn',
  initialPrompt: 'Inspect',
  messages: [],
  signal: new AbortController().signal
}

function workerStorage(): YachiyoStorage {
  const storage = createInMemoryYachiyoStorage()
  const thread = { id: 'parent', title: 'Task', updatedAt: '2026-10-26T00:00:00.000Z' }
  storage.createThread({ thread, createdAt: thread.updatedAt })
  storage.startRun({ runId: 'run', thread, updatedThread: thread, createdAt: thread.updatedAt })
  return storage
}

test('worker runner records live tool input and accumulates all model steps', async () => {
  const storage = workerStorage()
  await withRunner(
    async function* (request) {
      request.onToolCallStart?.({
        toolCall: { toolCallId: 'call', toolName: 'read', input: { path: '/tmp/live-evidence' } }
      } as never)
      assert.match(JSON.stringify(storage.listWorkerTranscriptTurns('parent')), /live-evidence/)
      request.onToolCallFinish?.({
        toolCall: { toolCallId: 'call', toolName: 'read', input: { path: '/tmp/live-evidence' } },
        success: true,
        output: {
          content: [{ type: 'text', text: 'evidence' }],
          details: { startLine: 1, endLine: 1 }
        }
      } as never)
      request.onFinish?.({
        promptTokens: 3,
        completionTokens: 2,
        totalPromptTokens: 20,
        totalCompletionTokens: 5
      } as never)
      yield 'Verified'
    },
    async (runner) => {
      const result = await runner.runTurn(turn)
      assert.equal(result.promptTokens, 20)
      assert.equal(result.completionTokens, 5)
      const [saved] = storage.listWorkerTranscriptTurns('parent')
      assert.equal(saved!.status, 'completed')
      assert.equal(saved!.promptTokens, 20)
      assert.match(JSON.stringify(saved!.messages), /evidence/)
    },
    () => false,
    undefined,
    storage
  )
})

test('cancelling the retry wait retains already incurred worker usage', async () => {
  const storage = workerStorage()
  const controller = new AbortController()
  const save = storage.upsertWorkerTranscriptTurn
  storage.upsertWorkerTranscriptTurn = (record) => {
    const result = save(record)
    if (
      record.status === 'running' &&
      record.messages.some((entry) =>
        JSON.stringify(entry.message).includes('[Worker turn recovery')
      )
    ) {
      queueMicrotask(() => controller.abort())
    }
    return result
  }
  let attempts = 0
  await withRunner(
    async function* (request) {
      if (++attempts === 1) {
        finishWithToolResult(request)
        yield* []
        return
      }
      throw new RetryableRunError('interrupted')
    },
    async (runner) => {
      await assert.rejects(runner.runTurn({ ...turn, signal: controller.signal }), (error) => {
        assert.ok(error instanceof SubagentTurnError)
        assert.equal(error.usage.promptTokens, 3)
        assert.equal(error.usage.completionTokens, 2)
        return true
      })
      const [saved] = storage.listWorkerTranscriptTurns('parent')
      assert.equal(saved!.status, 'cancelled')
      assert.equal(saved!.promptTokens, 3)
      assert.equal(saved!.completionTokens, 2)
    },
    () => false,
    undefined,
    storage
  )
})

test('workers preserve host tool restrictions even when their profile enables the tool', async () => {
  let called = false
  await withRunner(
    async function* (request) {
      called = true
      assert.ok(!request.tools?.read)
      yield 'No file access on this host.'
    },
    async (runner) => {
      await runner.runTurn(turn)
    },
    () => false,
    ['read']
  )
  assert.equal(called, true)
})

test('general worker in Code Mode exposes file tools only inside REPL', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'worker-code-mode-'))
  await writeFile(join(workspacePath, 'notes.txt'), 'worker code mode')
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
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
      parentDeliveryContext: { runMode: 'code', runTrigger: 'local' },
      createModelRuntime: () =>
        ({
          async *streamReply(request: ModelStreamRequest) {
            assert.ok(request.tools?.jsRepl)
            assert.ok(request.tools?.pyRepl)
            for (const name of ['read', 'write', 'edit', 'grep', 'glob']) {
              assert.equal(request.tools?.[name], undefined)
            }
            assert.match(String(request.messages[0]?.content), /Code Mode/)
            const repl = request.tools.jsRepl as unknown as {
              execute(input: {
                code: string
              }): Promise<{ details: { result?: string }; error?: string }>
            }
            const result = await repl.execute({
              code: `return JSON.stringify(await tool.read({path: 'notes.txt'}))`
            })
            assert.equal(result.error, undefined)
            assert.match(result.details.result ?? '', /worker code mode/)
            yield 'Done'
          }
        }) as ModelRuntime
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent',
      parentThreadId: 'parent',
      launchRunId: 'run',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath,
      prompt: 'Inspect'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({ messageId: 'message', delivery: 'queued', recipientState: 'idle' }),
    getTask: () => undefined,
    eliminateTask: () => false,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })
  try {
    assert.equal((await runner.runTurn(turn)).output, 'Done')
    assert.equal(await readFile(join(workspacePath, 'notes.txt'), 'utf8'), 'worker code mode')
  } finally {
    await runner.close()
    await rm(workspacePath, { recursive: true, force: true })
  }
})
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
