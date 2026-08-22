import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ModelRuntime, ModelStreamRequest } from '../../runtime/models/types.ts'
import { DEFAULT_NAMED_SUBAGENT_PROFILES } from '../../settings/namedSubagents.ts'
import type {
  AgentMessageReceipt,
  ProviderSettings,
  SendAgentMessageInput
} from '@yachiyo/shared/protocol'
import {
  SubagentManager,
  type LaunchSubagentInput
} from '../../app/domain/subagents/subagentManager.ts'
import {
  createWorkerSubagentRunnerFactory,
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
      enabledTools: ['delegateTask', 'sendMessage'],
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

  assert.match(result.content[0]?.text ?? '', /launched as Agent/)
  assert.match(result.content[0]?.text ?? '', /delivered automatically/)
  assert.match(result.content[0]?.text ?? '', /sendMessage/)
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
    assert.equal('sendMessage' in (requests[0]?.tools ?? {}), true)
    assert.deepEqual(sentMessages, [])
  } finally {
    await runner.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Worker profile permissions include sendMessage without enabling recursive delegation', () => {
  const profile = DEFAULT_NAMED_SUBAGENT_PROFILES.general
  assert.ok(profile.allowedTools?.includes('sendMessage'))
  assert.equal(profile.allowedTools?.includes('delegateTask'), false)
  assert.equal(profile.allowedTools?.includes('sendThreadMessage'), false)
})
