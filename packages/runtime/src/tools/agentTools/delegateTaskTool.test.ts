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
