import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ModelRuntime, ModelStreamRequest } from '../../runtime/models/types.ts'
import { RetryableRunError } from '../../runtime/models/runtimeErrors.ts'
import { DEFAULT_NAMED_SUBAGENT_PROFILES } from '../../settings/namedSubagents.ts'
import type {
  AgentMessageReceipt,
  ProviderSettings,
  SettingsConfig,
  SendAgentMessageInput
} from '@yachiyo/shared/protocol'
import {
  SubagentManager,
  type LaunchSubagentInput
} from '../../app/domain/subagents/subagentManager.ts'
import {
  createWorkerSubagentRunnerFactory,
  WORKER_SUBAGENT_RETRY_MAX_ATTEMPTS,
  type WorkerSubagentRunnerDependencies
} from '../../app/domain/subagents/workerSubagentRunner.ts'
import { createTool, type DelegateTaskContext } from './delegateTaskTool.ts'
import type { AgentToolDependencies } from '../agentTools.ts'

const TEST_SETTINGS: ProviderSettings = {
  providerName: 'test',
  provider: 'openai',
  model: 'gpt-test',
  apiKey: '',
  baseUrl: ''
}

function makeLaunchManager(launches: LaunchSubagentInput[]): SubagentManager {
  return {
    launch: async (input) => {
      launches.push(input)
      return {
        agentId: input.agentId,
        codeName: input.codeName,
        state: 'running',
        workspacePath: input.workspacePath
      }
    }
  } as unknown as SubagentManager
}

function makeContext(overrides: Partial<DelegateTaskContext> = {}): DelegateTaskContext {
  const launches: LaunchSubagentInput[] = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* () {
      yield 'provider output'
    }
  } as ModelRuntime

  return {
    workspacePath: process.cwd(),
    availableWorkspaces: [process.cwd()],
    subagentsConfig: {
      mode: 'worker',
      enabledNamedAgents: ['explore', 'review']
    },
    subagentProfiles: [],
    settings: TEST_SETTINGS,
    createModelRuntime: () => modelRuntime,
    parentToolContext: {
      runId: 'parent-run',
      threadId: 'thread-1',
      enabledTools: ['delegateTask', 'steerTask', 'getTask'],
      workspacePath: process.cwd()
    },
    parentDependencies: {},
    subagentManager: makeLaunchManager(launches),
    ...overrides,
    __testLaunches: launches
  } as DelegateTaskContext & { __testLaunches: LaunchSubagentInput[] }
}

function launchOptions(toolCallId: string): {
  toolCallId: string
  messages: []
  abortSignal: AbortSignal
} {
  return { toolCallId, messages: [], abortSignal: new AbortController().signal }
}

test('Worker delegation accepts the current unsaved directory and its realpath alias', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-delegate-'))
  const alias = `${workspace}-alias`
  const launches: LaunchSubagentInput[] = []
  try {
    await symlink(workspace, alias)
    const tool = createTool(
      makeContext({
        workspacePath: workspace,
        availableWorkspaces: [],
        subagentManager: makeLaunchManager(launches)
      })
    )
    for (const requested of [undefined, workspace, alias]) {
      const result = (await tool.execute!(
        { agent_name: 'explore', prompt: 'Read the workspace', workspace: requested },
        launchOptions(`temp-${launches.length}`)
      )) as { error?: string }
      assert.equal(result.error, undefined)
    }
    assert.equal(launches.length, 3)
    const canonicalWorkspace = await realpath(workspace)
    assert.ok(launches.every((launch) => launch.workspacePath === canonicalWorkspace))
  } finally {
    await rm(alias, { force: true })
    await rm(workspace, { recursive: true, force: true })
  }
})

for (const mode of ['worker', 'acp'] as const) {
  test(`${mode} delegation validates directory authorization without requiring Git`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-workspace-'))
    const saved = await mkdtemp(join(tmpdir(), 'yachiyo-saved-'))
    const outside = await mkdtemp(join(tmpdir(), 'yachiyo-outside-'))
    const file = join(workspace, 'file')
    const launches: LaunchSubagentInput[] = []
    const acpPaths: string[] = []
    try {
      await writeFile(file, 'sentinel')
      const context = makeContext({
        workspacePath: workspace,
        availableWorkspaces: [saved, file, join(workspace, 'missing')],
        subagentsConfig: { mode, enabledNamedAgents: ['explore'] },
        subagentProfiles: [{ name: 'explore', enabled: true } as never],
        subagentManager: makeLaunchManager(launches),
        launchAcpProcess: ((_profile: unknown, cwd: string) => {
          acpPaths.push(cwd)
          return { proc: {}, stream: {}, procExited: Promise.resolve(0) }
        }) as unknown as DelegateTaskContext['launchAcpProcess'],
        runAcpSession: (async (_stream, _proc, _exited, cwd) => {
          assert.equal(cwd, acpPaths.at(-1))
          return { sessionId: 'session', stopReason: 'end_turn', lastMessageText: 'done' }
        }) as DelegateTaskContext['runAcpSession']
      })
      const tool = createTool(context)
      for (const requested of [undefined, workspace, saved]) {
        const result = (await tool.execute!(
          { agent_name: 'explore', prompt: 'Inspect', workspace: requested },
          launchOptions('valid')
        )) as { error?: string }
        assert.equal(result.error, undefined)
      }
      for (const requested of [outside, file, join(workspace, 'missing')]) {
        const result = (await tool.execute!(
          { agent_name: 'explore', prompt: 'Inspect', workspace: requested },
          launchOptions('invalid')
        )) as { error?: string }
        assert.ok(result.error)
      }
      assert.equal(mode === 'worker' ? launches.length : acpPaths.length, 3)
      assert.equal(await readFile(file, 'utf8'), 'sentinel')
      await assert.rejects(access(join(workspace, '.git')))
      assert.deepEqual(context.availableWorkspaces, [saved, file, join(workspace, 'missing')])
    } finally {
      await Promise.all(
        [workspace, saved, outside].map((path) => rm(path, { recursive: true, force: true }))
      )
    }
  })
}

test('delegateTask returns a launch receipt without awaiting provider execution', async () => {
  let providerCalls = 0
  const context = makeContext({
    createModelRuntime: () => {
      providerCalls += 1
      return {
        streamReply: async function* () {
          yield 'provider output'
        }
      } as ModelRuntime
    }
  }) as DelegateTaskContext & { __testLaunches: LaunchSubagentInput[] }
  const tool = createTool(context)

  const result = (await tool.execute!(
    { agent_name: 'explore', prompt: 'Map the feature' },
    launchOptions('delegation-1')
  )) as { content: Array<{ type: 'text'; text: string }> }

  assert.match(result.content[0]?.text ?? '', /launched as Task/)
  assert.match(result.content[0]?.text ?? '', /delivered automatically/)
  assert.match(result.content[0]?.text ?? '', /steerTask/)
  assert.equal(providerCalls, 0)
  assert.equal(context.__testLaunches.length, 1)
  assert.equal(context.__testLaunches[0]?.agentId, 'delegation-1')
  assert.equal(typeof context.__testLaunches[0]?.runnerFactory, 'function')
})

test('delegateTask rejects unknown Worker profile names before launch', async () => {
  const launches: LaunchSubagentInput[] = []
  const tool = createTool(
    makeContext({
      subagentManager: makeLaunchManager(launches)
    })
  )

  const result = (await tool.execute!(
    { agent_name: 'missing' as never, prompt: 'Map the feature' },
    launchOptions('delegation-invalid')
  )) as { content: Array<{ type: 'text'; text: string }>; error?: string }

  assert.match(result.error ?? result.content[0]?.text ?? '', /Unknown worker subagent/)
  assert.equal(launches.length, 0)
})

for (const profileId of ['explore', 'plan', 'review'] as const) {
  test(`${profileId} Worker runs Web and read orchestration without inheriting full Node access`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-research-worker-'))
    await writeFile(join(workspace, 'sample.txt'), 'local evidence')
    let webCalls = 0
    const searchQueries: string[] = []
    let inspected = false
    const factory = createWorkerSubagentRunnerFactory({
      profileId,
      profile: DEFAULT_NAMED_SUBAGENT_PROFILES[profileId],
      dependencies: {
        settings: TEST_SETTINGS,
        parentToolContext: { workspacePath: workspace, runMode: 'auto' },
        parentDependencies: {
          webSearchService: {
            search: async ({ query }: { query: string }) => {
              searchQueries.push(query)
              return {
                provider: 'test',
                query,
                results: [
                  { rank: 1, title: 'Search evidence', url: 'https://example.com/reference' }
                ]
              }
            }
          } as AgentToolDependencies['webSearchService'],
          fetchImpl: async () => {
            webCalls++
            return new Response('remote evidence', { headers: { 'content-type': 'text/plain' } })
          }
        },
        createModelRuntime: () =>
          ({
            streamReply: async function* (request: ModelStreamRequest) {
              const tools = request.tools!
              assert.ok(tools.jsRepl)
              assert.ok(tools.webRead)
              assert.ok(tools.webSearch)
              assert.equal(Boolean(tools.bash), profileId === 'review')
              assert.equal(tools.pyRepl, undefined)
              const result = (await tools.jsRepl!.execute!(
                {
                  code: 'const results = await parallel([() => read("sample.txt"), () => tool.webRead({url:"https://example.com/reference",format:"markdown"}), () => tool.webSearch({query:"QuickJS documentation"})]); display(results); typeof process',
                  timeout: 5,
                  reset: false
                },
                launchOptions('research-cell')
              )) as { error?: string; details: { result: string; displayOutput: string } }
              assert.equal(result.error, undefined)
              assert.equal(result.details.result, 'undefined')
              assert.match(result.details.displayOutput, /local evidence/)
              assert.match(result.details.displayOutput, /remote evidence/)
              assert.match(result.details.displayOutput, /Search evidence/)
              const blocked = (await tools.jsRepl!.execute!(
                { code: 'await tool.bash({command:"pwd"})' },
                launchOptions('blocked-cell')
              )) as { error?: string }
              assert.ok(blocked.error)
              inspected = true
              yield 'done'
            }
          }) as ModelRuntime
      }
    })
    const runner = factory({
      launch: {
        agentId: 'research',
        parentThreadId: 'parent',
        launchRunId: 'run',
        agentName: profileId,
        agentType: profileId,
        codeName: 'Akari',
        workspacePath: workspace,
        prompt: 'Inspect evidence'
      },
      signal: new AbortController().signal,
      sendMessage: () => ({ messageId: 'message', delivery: 'queued', recipientState: 'idle' }),
      getTask: () => undefined,
      hasPendingMessages: () => false,
      onProgress: () => {},
      onToolCall: () => {}
    })
    try {
      await runner.runTurn({
        turnId: 'turn',
        initialPrompt: 'Inspect evidence',
        messages: [],
        signal: new AbortController().signal
      })
      assert.equal(inspected, true)
      assert.equal(webCalls, 1)
      assert.deepEqual(searchQueries, ['QuickJS documentation'])
      assert.equal(await readFile(join(workspace, 'sample.txt'), 'utf8'), 'local evidence')
    } finally {
      await runner.close()
      await rm(workspace, { recursive: true, force: true })
    }
  })
}

test('Worker runner preserves prompt/mailbox history and Agent-specific prompt cache keys', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-'))
  const requests: ModelStreamRequest[] = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      requests.push(request)
      request.onFinish?.({
        promptTokens: 3,
        completionTokens: 2,
        totalPromptTokens: 3,
        totalCompletionTokens: 2,
        responseMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'reply' }] }]
      })
      yield 'reply'
    }
  } as ModelRuntime
  const dependencies: WorkerSubagentRunnerDependencies = {
    settings: TEST_SETTINGS,
    parentToolContext: { workspacePath: workspace, sandboxed: false },
    parentDependencies: {} as AgentToolDependencies,
    createModelRuntime: () => modelRuntime
  }
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies
  })
  const sentMessages: Array<SendAgentMessageInput> = []
  const receipt: AgentMessageReceipt = {
    messageId: 'message-1',
    delivery: 'queued',
    recipientState: 'idle'
  }
  const runner = factory({
    launch: {
      agentId: 'agent-1',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Initial task'
    },
    signal: new AbortController().signal,
    sendMessage: (input) => {
      sentMessages.push(input)
      return receipt
    },
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await runner.runTurn({
      turnId: 'turn-1',
      initialPrompt: 'Initial task',
      messages: [],
      signal: new AbortController().signal
    })
    await runner.runTurn({
      turnId: 'turn-2',
      messages: [
        {
          id: 'envelope-1',
          teamThreadId: 'thread-1',
          sequence: 1,
          from: { kind: 'parent', threadId: 'thread-1' },
          to: { kind: 'agent', agentId: 'agent-1' },
          message: 'Follow-up request',
          createdAt: new Date(1).toISOString()
        }
      ],
      signal: new AbortController().signal
    })

    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.promptCacheKey, 'thread-1:subagent:agent-1')
    const secondHistory = JSON.stringify(requests[1]?.messages)
    assert.match(secondHistory, /Initial task/)
    assert.match(secondHistory, /Follow-up request/)
    assert.equal('delegateTask' in (requests[0]?.tools ?? {}), false)
    assert.equal('sendThreadMessage' in (requests[0]?.tools ?? {}), false)
    assert.equal('steerTask' in (requests[0]?.tools ?? {}), true)
    assert.equal('getTask' in (requests[0]?.tools ?? {}), true)
    assert.deepEqual(sentMessages, [])
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner retries transient interruptions with bounded exponential backoff until success', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-retry-success-'))
  let providerCalls = 0
  const delays: number[] = []
  const requests: ModelStreamRequest[] = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      requests.push(request)
      providerCalls += 1
      if (providerCalls < 3) throw new RetryableRunError(`transient-${providerCalls}`)
      yield 'recovered'
    }
  }
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: {},
      createModelRuntime: () => modelRuntime,
      sleep: async (delayMs) => {
        delays.push(delayMs)
      }
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-retry-success',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Recover transiently'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({ messageId: 'message-1', delivery: 'queued', recipientState: 'idle' }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    const result = await runner.runTurn({
      turnId: 'turn-1',
      initialPrompt: 'Recover transiently',
      messages: [],
      signal: new AbortController().signal
    })
    assert.equal(result.output, 'recovered')
    assert.equal(providerCalls, 3)
    assert.deepEqual(delays, [1_000, 2_000])
    assert.match(JSON.stringify(requests[1]?.messages), /Worker turn recovery 1\/3/)
    assert.match(JSON.stringify(requests[2]?.messages), /Worker turn recovery 2\/3/)
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner stops after the bounded transient retry budget is exhausted', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-retry-exhausted-'))
  let providerCalls = 0
  const delays: number[] = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* () {
      providerCalls += 1
      if (providerCalls < 0) yield ''
      throw new RetryableRunError('provider unavailable')
    }
  }
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: {},
      createModelRuntime: () => modelRuntime,
      sleep: async (delayMs) => {
        delays.push(delayMs)
      }
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-retry-exhausted',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Exhaust retries'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({ messageId: 'message-1', delivery: 'queued', recipientState: 'idle' }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await assert.rejects(
      runner.runTurn({
        turnId: 'turn-1',
        initialPrompt: 'Exhaust retries',
        messages: [],
        signal: new AbortController().signal
      }),
      /provider unavailable/
    )
    assert.equal(providerCalls, WORKER_SUBAGENT_RETRY_MAX_ATTEMPTS)
    assert.equal(delays.length, WORKER_SUBAGENT_RETRY_MAX_ATTEMPTS - 1)
    assert.deepEqual(delays, [1_000, 2_000])
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner does not automatically retry non-retryable errors or cancellation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-no-retry-'))
  for (const scenario of ['fatal', 'cancelled'] as const) {
    let providerCalls = 0
    let sleepCalls = 0
    const controller = new AbortController()
    const modelRuntime: ModelRuntime = {
      streamReply: async function* () {
        providerCalls += 1
        if (providerCalls < 0) yield ''
        if (scenario === 'cancelled') controller.abort(new Error('cancelled by parent'))
        throw new RetryableRunError(scenario)
      }
    }
    const factory = createWorkerSubagentRunnerFactory({
      profileId: 'general',
      profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
      dependencies: {
        settings: TEST_SETTINGS,
        parentToolContext: { workspacePath: workspace, sandboxed: false },
        parentDependencies: {},
        createModelRuntime: () =>
          scenario === 'fatal'
            ? ({
                streamReply: async function* () {
                  providerCalls += 1
                  if (providerCalls < 0) yield ''
                  throw new Error('invalid request')
                }
              } as ModelRuntime)
            : modelRuntime,
        sleep: async () => {
          sleepCalls += 1
        }
      }
    })
    const runner = factory({
      launch: {
        agentId: `agent-${scenario}`,
        parentThreadId: 'thread-1',
        launchRunId: 'run-1',
        agentName: 'general',
        agentType: 'general',
        codeName: 'Akari',
        workspacePath: workspace,
        prompt: scenario
      },
      signal: controller.signal,
      sendMessage: () => ({ messageId: 'message-1', delivery: 'queued', recipientState: 'idle' }),
      getTask: () => undefined,
      hasPendingMessages: () => false,
      onProgress: () => {},
      onToolCall: () => {}
    })

    try {
      await assert.rejects(
        runner.runTurn({
          turnId: 'turn-1',
          initialPrompt: scenario,
          messages: [],
          signal: controller.signal
        })
      )
      assert.equal(providerCalls, 1, scenario)
      assert.equal(sleepCalls, 0, scenario)
    } finally {
      await runner.close()
    }
  }
  await rm(workspace, { recursive: true, force: true })
})

test('Worker retry resumes after completed tools without executing them again', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-tool-retry-'))
  const requests: ModelStreamRequest[] = []
  let providerCalls = 0
  let toolExecutions = 0
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      requests.push(request)
      providerCalls += 1
      if (providerCalls === 1) {
        const toolCall = {
          type: 'tool-call',
          dynamic: true,
          toolCallId: 'write-once',
          toolName: 'write',
          input: { path: join(workspace, 'once.txt'), content: 'once' }
        }
        toolExecutions += 1
        request.onToolCallStart?.({
          abortSignal: request.signal,
          messages: request.messages,
          toolCall
        } as never)
        request.onToolCallFinish?.({
          abortSignal: request.signal,
          durationMs: 0,
          experimental_context: undefined,
          functionId: undefined,
          metadata: undefined,
          model: undefined,
          messages: request.messages,
          output: {
            content: [{ type: 'text', text: 'wrote once.txt' }],
            details: {},
            metadata: {}
          },
          stepNumber: 0,
          success: true,
          toolCall
        } as never)
        throw new RetryableRunError('stream dropped after tool completion')
      }

      assert.match(JSON.stringify(request.messages), /write-once/)
      assert.match(JSON.stringify(request.messages), /tool-result/)
      yield 'continued without repeating the write'
    }
  }
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: {},
      createModelRuntime: () => modelRuntime,
      sleep: async () => {}
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-tool-retry',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Write once'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({ messageId: 'message-1', delivery: 'queued', recipientState: 'idle' }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    const result = await runner.runTurn({
      turnId: 'turn-1',
      initialPrompt: 'Write once',
      messages: [],
      signal: new AbortController().signal
    })
    assert.equal(result.output, 'continued without repeating the write')
    assert.equal(providerCalls, 2)
    assert.equal(toolExecutions, 1)
    assert.equal(requests.length, 2)
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker preserves a synthetic interrupted result for a dangling tool call before manual continuation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-dangling-tool-'))
  let providerCalls = 0
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      providerCalls += 1
      if (providerCalls === 1) {
        request.onToolCallStart?.({
          abortSignal: request.signal,
          messages: request.messages,
          toolCall: {
            type: 'tool-call',
            dynamic: true,
            toolCallId: 'dangling-write',
            toolName: 'write',
            input: { path: join(workspace, 'uncertain.txt'), content: 'uncertain' }
          }
        } as never)
        throw new RetryableRunError('stream dropped with tool in flight')
      }

      const serialized = JSON.stringify(request.messages)
      assert.match(serialized, /dangling-write/)
      assert.match(serialized, /tool-result/)
      assert.match(serialized, /interrupted before completion/)
      yield 'manual continuation used preserved history'
    }
  }
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: {},
      createModelRuntime: () => modelRuntime,
      sleep: async () => {}
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-dangling-tool',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Start a tool'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({ messageId: 'message-1', delivery: 'queued', recipientState: 'idle' }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await assert.rejects(
      runner.runTurn({
        turnId: 'turn-1',
        initialPrompt: 'Start a tool',
        messages: [],
        signal: new AbortController().signal
      }),
      /stream dropped with tool in flight/
    )
    const result = await runner.runTurn({
      turnId: 'turn-2',
      messages: [
        {
          id: 'message-2',
          teamThreadId: 'thread-1',
          sequence: 1,
          from: { kind: 'parent', threadId: 'thread-1' },
          to: { kind: 'agent', agentId: 'agent-dangling-tool' },
          message: 'Continue after interruption',
          createdAt: new Date(1).toISOString()
        }
      ],
      signal: new AbortController().signal
    })
    assert.equal(result.output, 'manual continuation used preserved history')
    assert.equal(providerCalls, 2)
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner preserves the host jsRepl worker bundle path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-js-repl-'))
  const workerPath = join(workspace, 'injected-js-repl-worker.cjs')
  await writeFile(
    workerPath,
    [
      `const { parentPort } = require('node:worker_threads')`,
      `parentPort.on('message', (message) => {`,
      `  if (message.type === 'init') parentPort.postMessage({ type: 'ready' })`,
      `  if (message.type === 'execute') parentPort.postMessage({`,
      `    type: 'result',`,
      `    runId: message.runId,`,
      `    result: 'injected-worker',`,
      `    consoleLines: [],`,
      `    displayOutputs: [],`,
      `    timedOut: false`,
      `  })`,
      `})`
    ].join('\n')
  )
  let jsReplResult: string | undefined
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      const jsRepl = request.tools?.jsRepl as
        | {
            execute?: (
              input: { code: string },
              options: {
                toolCallId: string
                messages: []
                abortSignal: AbortSignal
              }
            ) => Promise<{ details: { result?: string } }>
          }
        | undefined
      assert.ok(jsRepl?.execute)
      const result = await jsRepl.execute(
        { code: '6 * 7' },
        {
          toolCallId: 'worker-js-repl-smoke',
          messages: [],
          abortSignal: new AbortController().signal
        }
      )
      jsReplResult = result.details.result
      yield 'done'
    }
  } as ModelRuntime
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: { jsReplWorkerPath: workerPath },
      createModelRuntime: () => modelRuntime
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-js-repl',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Use jsRepl'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({
      messageId: 'message-1',
      delivery: 'queued',
      recipientState: 'idle'
    }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await runner.runTurn({
      turnId: 'turn-js-repl',
      initialPrompt: 'Use jsRepl',
      messages: [],
      signal: new AbortController().signal
    })
    assert.equal(jsReplResult, 'injected-worker')
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner preserves the host pyRepl runner and runtime dependencies', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'yachiyo-worker-py-repl-')))
  const runnerPath = join(workspace, 'injected-py-repl-runner.py')
  await writeFile(runnerPath, '# injected worker runner\n', 'utf8')

  let stagedRunnerPath: string | undefined
  let pyReplResult: string | undefined
  let kernelDisposed = false
  let runtimeReleased = false
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      const pyRepl = request.tools?.pyRepl as
        | {
            execute?: (
              input: { code: string },
              options: {
                toolCallId: string
                messages: []
                abortSignal: AbortSignal
              }
            ) => Promise<{ details: { result?: string } }>
          }
        | undefined
      assert.ok(pyRepl?.execute)
      const result = await pyRepl.execute(
        { code: '6 * 7' },
        {
          toolCallId: 'worker-py-repl-smoke',
          messages: [],
          abortSignal: new AbortController().signal
        }
      )
      pyReplResult = result.details.result
      yield 'done'
    }
  } as ModelRuntime
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: {
        pyReplRunnerPath: runnerPath,
        pyReplDependencies: {
          ensureRuntime: async () => ({
            kind: 'managed',
            rootPath: workspace,
            pythonPath: join(workspace, 'python'),
            uvPath: join(workspace, 'uv'),
            environmentPath: join(workspace, 'environment'),
            env: {},
            version: '3.12.14' as const,
            acquireProcessLease: async () => async () => {},
            release: async () => {
              runtimeReleased = true
            }
          }),
          createKernel: ((options) => {
            stagedRunnerPath = options.runnerPath
            return {
              execute: async () => ({
                events: [{ type: 'result', bundle: { 'text/plain': 'injected-python' } }],
                status: 'ok',
                cancelled: false,
                timedOut: false,
                contextReset: false,
                resetReason: undefined,
                resetScope: undefined,
                failureKind: undefined,
                failure: undefined
              }),
              dispose: async () => {
                kernelDisposed = true
              }
            } as never
          }) as NonNullable<
            NonNullable<AgentToolDependencies['pyReplDependencies']>['createKernel']
          >
        }
      },
      createModelRuntime: () => modelRuntime
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-py-repl',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Use pyRepl'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({
      messageId: 'message-1',
      delivery: 'queued',
      recipientState: 'idle'
    }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await runner.runTurn({
      turnId: 'turn-py-repl',
      initialPrompt: 'Use pyRepl',
      messages: [],
      signal: new AbortController().signal
    })
    assert.equal(pyReplResult, 'injected-python')
    assert.ok(stagedRunnerPath)
    assert.equal(await readFile(stagedRunnerPath, 'utf8'), '# injected worker runner\n')
  } finally {
    await runner.close()
    assert.equal(kernelDisposed, true)
    assert.equal(runtimeReleased, true)
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner omits pyRepl when managed Python is not ready', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'yachiyo-worker-no-py-repl-')))
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      assert.equal(request.tools?.pyRepl, undefined)
      yield 'done'
    }
  } as ModelRuntime
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: { pyReplAvailable: false },
      createModelRuntime: () => modelRuntime
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-no-py-repl',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Do not use pyRepl'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({
      messageId: 'message-1',
      delivery: 'queued',
      recipientState: 'idle'
    }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await runner.runTurn({
      turnId: 'turn-no-py-repl',
      initialPrompt: 'Do not use pyRepl',
      messages: [],
      signal: new AbortController().signal
    })
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker runner compacts with its own model before a follow-up turn', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yachiyo-worker-compaction-'))
  const requests: ModelStreamRequest[] = []
  let taskCallCount = 0
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (request) {
      requests.push(request)
      if (request.purpose === 'worker-compaction:initial') {
        request.onFinish?.({
          promptTokens: 11,
          completionTokens: 7,
          totalPromptTokens: 11,
          totalCompletionTokens: 7
        })
        yield 'COMPACTED WORKER SUMMARY'
        return
      }

      taskCallCount += 1
      request.onFinish?.({
        promptTokens: taskCallCount === 1 ? 3_500 : 100,
        completionTokens: 2,
        totalPromptTokens: taskCallCount === 1 ? 3_500 : 100,
        totalCompletionTokens: 2,
        responseMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: taskCallCount === 1 ? `FIRST TURN ${'detail '.repeat(1_000)}` : 'SECOND TURN'
              }
            ]
          }
        ]
      })
      yield `reply-${taskCallCount}`
    }
  } as ModelRuntime
  const config: SettingsConfig = {
    providers: [],
    chat: { stripCompact: true, stripCompactThresholdTokens: 3_000 }
  }
  const factory = createWorkerSubagentRunnerFactory({
    profileId: 'general',
    profile: DEFAULT_NAMED_SUBAGENT_PROFILES.general,
    dependencies: {
      settings: TEST_SETTINGS,
      config,
      parentToolContext: { workspacePath: workspace, sandboxed: false },
      parentDependencies: {} as AgentToolDependencies,
      createModelRuntime: () => modelRuntime
    }
  })
  const runner = factory({
    launch: {
      agentId: 'agent-compact',
      parentThreadId: 'thread-1',
      launchRunId: 'run-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: workspace,
      prompt: 'Initial task'
    },
    signal: new AbortController().signal,
    sendMessage: () => ({
      messageId: 'message-1',
      delivery: 'queued',
      recipientState: 'idle'
    }),
    getTask: () => undefined,
    hasPendingMessages: () => false,
    onProgress: () => {},
    onToolCall: () => {}
  })

  try {
    await runner.runTurn({
      turnId: 'turn-1',
      initialPrompt: 'Initial task',
      messages: [],
      signal: new AbortController().signal
    })
    const second = await runner.runTurn({
      turnId: 'turn-2',
      messages: [
        {
          id: 'envelope-1',
          teamThreadId: 'thread-1',
          sequence: 1,
          from: { kind: 'parent', threadId: 'thread-1' },
          to: { kind: 'agent', agentId: 'agent-compact' },
          message: 'Continue after compaction',
          createdAt: new Date(1).toISOString()
        }
      ],
      signal: new AbortController().signal
    })

    assert.equal(requests.length, 3)
    assert.equal(requests[1]?.purpose, 'worker-compaction:initial')
    assert.strictEqual(requests[1]?.settings, requests[0]?.settings)
    assert.equal(requests[1]?.toolChoice, 'none')
    assert.match(JSON.stringify(requests[2]?.messages), /COMPACTED WORKER SUMMARY/)
    assert.doesNotMatch(JSON.stringify(requests[2]?.messages), /FIRST TURN/)
    assert.equal(second.promptTokens, 111)
    assert.equal(second.completionTokens, 9)
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker profile permissions expose pyRepl only to general workers', () => {
  const profile = DEFAULT_NAMED_SUBAGENT_PROFILES.general
  assert.ok(profile.allowedTools?.includes('pyRepl'))
  assert.ok(profile.allowedTools?.includes('steerTask'))
  assert.ok(profile.allowedTools?.includes('getTask'))
  assert.equal(profile.allowedTools?.includes('delegateTask'), false)
  assert.equal(profile.allowedTools?.includes('sendThreadMessage'), false)

  for (const profileId of ['explore', 'plan', 'review'] as const) {
    assert.equal(DEFAULT_NAMED_SUBAGENT_PROFILES[profileId].allowedTools?.includes('pyRepl'), false)
  }
})
