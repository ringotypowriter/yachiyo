import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolSet } from 'ai'
import type { ModelRuntime } from '../../runtime/models/types.ts'
import { DEFAULT_NAMED_SUBAGENT_PROFILES } from '../../settings/namedSubagents.ts'
import { createTool, type DelegateTaskContext } from './delegateTaskTool.ts'

function makeContext(overrides: Partial<DelegateTaskContext> = {}): DelegateTaskContext {
  const modelRuntime: ModelRuntime = {
    streamReply: async function* () {
      yield 'worker result'
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
    settings: {
      providerName: 'test',
      provider: 'openai',
      model: 'gpt-test',
      apiKey: '',
      baseUrl: ''
    },
    createModelRuntime: () => modelRuntime,
    parentToolContext: { enabledTools: ['read', 'grep'], workspacePath: process.cwd() },
    parentDependencies: {},
    ...overrides
  }
}

test('delegateTask runs enabled worker subagents with stable start and finish metadata', async () => {
  const starts: Array<{ delegationId: string; agentType: string; startedAt: string }> = []
  const finishes: Array<{ delegationId: string; agentType: string; status: string }> = []
  const tool = createTool(
    makeContext({
      onSubagentStarted: (event) => starts.push(event),
      onSubagentFinished: (event) => finishes.push(event)
    })
  )

  const result = (await tool.execute!(
    { agent_name: 'explore', prompt: 'Map the feature' },
    { toolCallId: 'delegation-1', messages: [], abortSignal: AbortSignal.timeout(5000) }
  )) as Awaited<ReturnType<NonNullable<typeof tool.execute>>> & {
    content: Array<{ type: 'text'; text: string }>
  }

  assert.match(result.content[0]?.text ?? '', /worker result/)
  assert.deepEqual(
    starts.map((event) => [event.delegationId, event.agentType]),
    [['delegation-1', 'explore']]
  )
  assert.equal(typeof starts[0]?.startedAt, 'string')
  assert.deepEqual(
    finishes.map((event) => [event.delegationId, event.agentType, event.status]),
    [['delegation-1', 'explore', 'success']]
  )
})

test('delegateTask returns fallback text when a worker produces only tool calls', async () => {
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (input) {
      if (process.env.__YACHIYO_TEST_UNREACHABLE__ === '1') yield ''
      input.onToolCallFinish?.({
        abortSignal: AbortSignal.timeout(5000),
        durationMs: 0,
        experimental_context: undefined,
        functionId: undefined,
        metadata: undefined,
        model: undefined,
        messages: [],
        stepNumber: undefined,
        success: true,
        output: {
          content: [{ type: 'text', text: 'a.ts\nb.ts' }],
          details: {
            backend: 'typescript',
            pattern: '**/*.ts',
            path: process.cwd(),
            resultCount: 2,
            truncated: false,
            matches: ['a.ts', 'b.ts']
          }
        },
        toolCall: {
          type: 'tool-call',
          dynamic: true,
          toolCallId: 'worker-tool-1',
          toolName: 'glob',
          input: { pattern: '**/*.ts' }
        }
      })
    }
  } as ModelRuntime
  const tool = createTool(
    makeContext({
      createModelRuntime: () => modelRuntime
    })
  )

  const result = (await tool.execute!(
    { agent_name: 'explore', prompt: 'Map the feature' },
    { toolCallId: 'delegation-fallback', messages: [], abortSignal: AbortSignal.timeout(5000) }
  )) as Awaited<ReturnType<NonNullable<typeof tool.execute>>> & {
    content: Array<{ type: 'text'; text: string }>
  }

  assert.match(result.content[0]?.text ?? '', /Subagent completed without a final text response/)
  assert.match(result.content[0]?.text ?? '', /glob: \*\*\/\*\.ts → found 2 files/)
})

test('delegateTask rejects unknown worker subagent names', async () => {
  const tool = createTool(makeContext())
  const result = (await tool.execute!(
    { agent_name: 'missing', prompt: 'Do it' },
    { toolCallId: 'delegation-2', messages: [], abortSignal: AbortSignal.timeout(5000) }
  )) as Awaited<ReturnType<NonNullable<typeof tool.execute>>> & { error?: string }

  assert.equal(
    result.error,
    'Unknown worker subagent "missing". Valid names: explore, plan, review, general.'
  )
})

test('worker subagents do not receive delegateTask recursively', async () => {
  let capturedTools: ToolSet | undefined
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (input) {
      capturedTools = input.tools
      yield 'worker result'
    }
  } as ModelRuntime
  const tool = createTool(
    makeContext({
      createModelRuntime: () => modelRuntime,
      parentDependencies: {
        subagentsConfig: {
          mode: 'worker',
          enabledNamedAgents: ['explore']
        },
        settings: {
          providerName: 'test',
          provider: 'openai',
          model: 'gpt-test',
          apiKey: '',
          baseUrl: ''
        },
        createModelRuntime: () => modelRuntime
      }
    })
  )

  await tool.execute!(
    { agent_name: 'explore', prompt: 'Map the feature' },
    { toolCallId: 'delegation-3', messages: [], abortSignal: AbortSignal.timeout(5000) }
  )

  assert.ok(capturedTools)
  assert.equal('delegateTask' in capturedTools, false)
})

test('worker subagents expose only enabled schemas', async () => {
  let capturedTools: ToolSet | undefined
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (input) {
      capturedTools = input.tools
      yield 'review result'
    }
  } as ModelRuntime
  const tool = createTool(
    makeContext({
      createModelRuntime: () => modelRuntime,
      parentDependencies: {
        searchService: {} as never,
        availableSkills: []
      }
    })
  )

  await tool.execute!(
    { agent_name: 'review', prompt: 'Review the change' },
    { toolCallId: 'delegation-4', messages: [], abortSignal: AbortSignal.timeout(5000) }
  )

  assert.ok(capturedTools)
  assert.deepEqual(Object.keys(capturedTools).sort(), [
    'bash',
    'glob',
    'grep',
    'read',
    'skillsRead'
  ])
})

test('built-in worker tool permissions stay fixed in code', () => {
  assert.deepEqual(DEFAULT_NAMED_SUBAGENT_PROFILES.review.allowedTools, [
    'read',
    'bash',
    'grep',
    'glob',
    'skillsRead'
  ])
  assert.deepEqual(DEFAULT_NAMED_SUBAGENT_PROFILES.general.allowedTools, [
    'read',
    'write',
    'edit',
    'bash',
    'jsRepl',
    'grep',
    'glob',
    'webRead',
    'webSearch',
    'skillsRead',
    'applyPatch'
  ])
})

test('worker subagent uses preferred model when configured', async () => {
  const capturedSettings: Array<{ providerName: string; model: string }> = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (input) {
      capturedSettings.push({
        providerName: input.settings.providerName,
        model: input.settings.model
      })
      yield 'worker result'
    }
  } as ModelRuntime

  const tool = createTool(
    makeContext({
      config: {
        providers: [
          {
            id: 'p1',
            name: 'preferred',
            type: 'openai',
            apiKey: 'sk-p',
            baseUrl: '',
            project: '',
            location: '',
            serviceAccountEmail: '',
            serviceAccountPrivateKey: '',
            modelList: { enabled: ['gpt-5'], disabled: [] }
          }
        ],
        subagents: {
          mode: 'worker',
          enabledNamedAgents: ['explore'],
          preferredModels: {
            explore: { providerName: 'preferred', model: 'gpt-5' }
          }
        }
      },
      settings: {
        providerName: 'default',
        provider: 'anthropic',
        model: 'claude-default',
        apiKey: '',
        baseUrl: ''
      },
      createModelRuntime: () => modelRuntime
    })
  )

  await tool.execute!(
    { agent_name: 'explore', prompt: 'Do it' },
    { toolCallId: 'delegation-preferred', messages: [], abortSignal: AbortSignal.timeout(5000) }
  )

  assert.equal(capturedSettings.length, 1)
  assert.equal(capturedSettings[0]!.providerName, 'preferred')
  assert.equal(capturedSettings[0]!.model, 'gpt-5')
})

test('worker subagent falls back to calling model when preferred model is disabled or missing', async () => {
  const capturedSettings: Array<{ providerName: string; model: string }> = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (input) {
      capturedSettings.push({
        providerName: input.settings.providerName,
        model: input.settings.model
      })
      yield 'worker result'
    }
  } as ModelRuntime

  const tool = createTool(
    makeContext({
      config: {
        providers: [
          {
            id: 'p1',
            name: 'preferred',
            type: 'openai',
            apiKey: 'sk-p',
            baseUrl: '',
            project: '',
            location: '',
            serviceAccountEmail: '',
            serviceAccountPrivateKey: '',
            modelList: { enabled: [], disabled: ['gpt-5'] }
          }
        ],
        subagents: {
          mode: 'worker',
          enabledNamedAgents: ['explore'],
          preferredModels: {
            explore: { providerName: 'preferred', model: 'gpt-5' }
          }
        }
      },
      settings: {
        providerName: 'default',
        provider: 'anthropic',
        model: 'claude-default',
        apiKey: '',
        baseUrl: ''
      },
      createModelRuntime: () => modelRuntime
    })
  )

  await tool.execute!(
    { agent_name: 'explore', prompt: 'Do it' },
    {
      toolCallId: 'delegation-fallback',
      messages: [],
      abortSignal: AbortSignal.timeout(5000)
    }
  )

  assert.equal(capturedSettings.length, 1)
  assert.equal(capturedSettings[0]!.providerName, 'default')
  assert.equal(capturedSettings[0]!.model, 'claude-default')
})

test('worker without preferred model uses calling model unchanged', async () => {
  const capturedSettings: Array<{ providerName: string; model: string }> = []
  const modelRuntime: ModelRuntime = {
    streamReply: async function* (input) {
      capturedSettings.push({
        providerName: input.settings.providerName,
        model: input.settings.model
      })
      yield 'worker result'
    }
  } as ModelRuntime

  const tool = createTool(
    makeContext({
      config: {
        providers: [],
        subagents: {
          mode: 'worker',
          enabledNamedAgents: ['explore']
        }
      },
      settings: {
        providerName: 'default',
        provider: 'anthropic',
        model: 'claude-default',
        apiKey: '',
        baseUrl: ''
      },
      createModelRuntime: () => modelRuntime
    })
  )

  await tool.execute!(
    { agent_name: 'explore', prompt: 'Do it' },
    {
      toolCallId: 'delegation-no-pref',
      messages: [],
      abortSignal: AbortSignal.timeout(5000)
    }
  )

  assert.equal(capturedSettings.length, 1)
  assert.equal(capturedSettings[0]!.providerName, 'default')
  assert.equal(capturedSettings[0]!.model, 'claude-default')
})
