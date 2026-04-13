import assert from 'node:assert/strict'
import test from 'node:test'

import { createTool, type DelegateCodingTaskContext } from './delegateCodingTaskTool.ts'
import { summarizeToolInput } from '../agentTools.ts'
import type { SubagentProfile } from '../../../../shared/yachiyo/protocol.ts'

const profile: SubagentProfile = {
  id: 'agent-1',
  name: 'Worker',
  enabled: true,
  description: 'Test worker',
  command: 'worker',
  args: [],
  env: {}
}

function makeContext(
  overrides: Partial<DelegateCodingTaskContext> = {}
): DelegateCodingTaskContext {
  return {
    workspacePath: '/tmp/workspace',
    availableWorkspaces: ['/tmp/workspace'],
    profiles: [profile],
    launchAcpProcess: () =>
      ({
        proc: {
          stderr: { on: () => undefined },
          on: () => undefined
        },
        stream: {},
        procExited: Promise.resolve()
      }) as never,
    runAcpSession: async (_stream, _proc, _procExited, _cwd, _prompt, adapter) => {
      await adapter.yoloClient.sessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'chunk-1' }
        }
      } as never)
      await adapter.yoloClient.sessionUpdate({
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'chunk-2' }
        }
      } as never)
      return {
        sessionId: 'session-1',
        lastMessageText: 'done',
        stopReason: 'end_turn'
      }
    },
    ...overrides
  }
}

function createExecute(context: DelegateCodingTaskContext) {
  const tool = createTool(context)
  const execute = tool.execute!
  return (
    toolCallId: string,
    input: {
      agent_name: string
      prompt: string
      workspace?: string
      session_id?: string
    }
  ) =>
    execute(input, {
      abortSignal: AbortSignal.timeout(5000),
      toolCallId,
      messages: []
    })
}

test('delegateCodingTask emits stable delegation identity for start, progress, and finish', async () => {
  const starts: Array<{ delegationId: string; agentName: string; workspacePath: string }> = []
  const progress: Array<{ delegationId: string; chunk: string }> = []
  const finishes: Array<{
    delegationId: string
    agentName: string
    status: 'success' | 'cancelled'
    sessionId?: string
    workspacePath: string
  }> = []
  const execute = createExecute(
    makeContext({
      onSubagentStarted: (event) => starts.push(event),
      onProgress: (event) => progress.push(event),
      onSubagentFinished: (event) => finishes.push(event)
    })
  )

  await execute('tool-delegate-1', {
    agent_name: 'Worker',
    prompt: 'First task'
  })
  await execute('tool-delegate-2', {
    agent_name: 'Worker',
    prompt: 'Second task'
  })

  assert.deepEqual(
    starts.map((event) => event.delegationId),
    ['tool-delegate-1', 'tool-delegate-2']
  )
  assert.deepEqual(
    progress.map((event) => event.delegationId),
    [
      'tool-delegate-1',
      'tool-delegate-1',
      'tool-delegate-1',
      'tool-delegate-2',
      'tool-delegate-2',
      'tool-delegate-2'
    ]
  )
  assert.deepEqual(
    finishes.map((event) => event.delegationId),
    ['tool-delegate-1', 'tool-delegate-2']
  )
  assert.equal(finishes[0]?.sessionId, 'session-1')
  assert.equal(finishes[1]?.sessionId, 'session-1')
})

test('summarizeToolInput uses the delegated agent name for delegateCodingTask', () => {
  assert.equal(
    summarizeToolInput('delegateCodingTask', {
      agent_name: 'Worker',
      prompt: 'Do the thing'
    }),
    'Worker'
  )
})
