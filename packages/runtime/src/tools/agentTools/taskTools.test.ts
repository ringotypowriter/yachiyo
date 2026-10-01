import assert from 'node:assert/strict'
import test from 'node:test'

import type { SubagentSnapshot } from '@yachiyo/shared/protocol'
import { createGetTaskTool, type GetTaskToolOutput } from './getTaskTool.ts'
import { createSteerTaskTool, type SteerTaskToolOutput } from './steerTaskTool.ts'

const snapshot: SubagentSnapshot = {
  agentId: 'task-1',
  parentThreadId: 'thread-1',
  launchRunId: 'run-1',
  agentName: 'explore',
  agentType: 'explore',
  codeName: 'Akari',
  workspacePath: '/workspace',
  state: 'running',
  startedAt: '2026-09-02T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:01.000Z',
  progress: '[read] packages/shared/src/protocol.ts\n'
}

test('steerTask addresses tasks by taskId while preserving parent and peer routing', async () => {
  const dispatched: Array<{ to: string; message: string }> = []
  const tool = createSteerTaskTool({
    eliminate: () => false,
    dispatch: (input) => {
      dispatched.push(input)
      return { messageId: 'message-1', delivery: 'queued', recipientState: 'running' }
    }
  })

  const result = (await tool.execute!(
    { taskId: 'task-1', message: 'Check the config path too.' },
    { toolCallId: 'call-1', messages: [], context: undefined }
  )) as SteerTaskToolOutput

  assert.deepEqual(dispatched, [{ to: 'task-1', message: 'Check the config path too.' }])
  assert.equal(result.details.kind, 'steerTask')
  assert.equal(result.details.taskId, 'task-1')
})

test('getTask returns the current same-team task snapshot and progress', async () => {
  const tool = createGetTaskTool({
    getTask: (taskId) => (taskId === 'task-1' ? snapshot : undefined)
  })

  const result = (await tool.execute!(
    { taskId: 'task-1' },
    { toolCallId: 'call-1', messages: [], context: undefined }
  )) as GetTaskToolOutput

  assert.equal(result.error, undefined)
  assert.equal(result.details.kind, 'getTask')
  assert.equal(result.details.taskId, 'task-1')
  const text = result.content.map((block) => ('text' in block ? block.text : '')).join('')
  assert.match(text, /State: running/)
  assert.match(text, /packages\/shared\/src\/protocol\.ts/)
})

test('getTask reports an unknown or inaccessible task without leaking it', async () => {
  const tool = createGetTaskTool({ getTask: () => undefined })

  const result = (await tool.execute!(
    { taskId: 'other-task' },
    { toolCallId: 'call-1', messages: [], context: undefined }
  )) as GetTaskToolOutput

  assert.match(result.error ?? '', /not found/)
})

test('steerTask eliminate cancels directly without dispatching a message', async () => {
  const cancelled: string[] = []
  const tool = createSteerTaskTool({
    dispatch: () => {
      throw new Error('Must not queue elimination')
    },
    eliminate: (taskId) => {
      cancelled.push(taskId)
      return true
    }
  })
  const result = (await tool.execute!(
    { taskId: 'task-1', action: 'eliminate' },
    { toolCallId: 'call-1', messages: [], context: undefined }
  )) as SteerTaskToolOutput
  assert.deepEqual(cancelled, ['task-1'])
  assert.equal(result.error, undefined)
  assert.match(
    result.content.map((block) => ('text' in block ? block.text : '')).join(''),
    /cancelled/
  )
})

test('steerTask eliminate reports an inaccessible or terminal task', async () => {
  const tool = createSteerTaskTool({
    dispatch: () => {
      throw new Error('Must not dispatch')
    },
    eliminate: () => false
  })
  const result = (await tool.execute!(
    { taskId: 'other-task', action: 'eliminate' },
    { toolCallId: 'call-1', messages: [], context: undefined }
  )) as SteerTaskToolOutput
  assert.match(result.error ?? '', /not found|accessible|terminal/)
})

test('steerTask keeps an object-root provider schema and validates action-specific messages', async () => {
  const { asSchema } = await import('ai')
  const tool = createSteerTaskTool({
    dispatch: () => {
      throw new Error('unused')
    },
    eliminate: () => false
  })
  const schema = asSchema(tool.inputSchema)
  assert.equal((await schema.jsonSchema).type, 'object')
  assert.equal((await schema.validate!({ taskId: 'task-1', action: 'eliminate' })).success, true)
  assert.equal((await schema.validate!({ taskId: 'task-1', message: 'Continue' })).success, true)
  assert.equal((await schema.validate!({ taskId: 'task-1', action: 'steer' })).success, false)
  assert.equal((await schema.validate!({ taskId: 'task-1', action: 'unknown' })).success, false)
})
