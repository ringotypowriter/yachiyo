import assert from 'node:assert/strict'
import test from 'node:test'

import type { ToolCallRecord } from '../../../../../../shared/yachiyo/protocol.ts'
import {
  handleBackgroundBashCompleted,
  type BackgroundTaskLifecycleContext
} from './backgroundTaskLifecycle.ts'

const TIMESTAMP = '2026-05-06T00:00:00.000Z'

test('handleBackgroundBashCompleted leaves a completed launch tool call unchanged', () => {
  const toolCall: ToolCallRecord = {
    id: 'tc-bg',
    runId: 'run-1',
    threadId: 'thread-1',
    requestMessageId: 'msg-1',
    toolName: 'bash',
    status: 'completed',
    inputSummary: 'sleep 10',
    outputSummary: 'background: tc-bg',
    details: {
      command: 'sleep 10',
      cwd: '/workspace',
      stdout: '',
      stderr: '',
      background: true,
      taskId: 'tc-bg',
      logPath: '/workspace/.yachiyo/tool-output/tc-bg.log'
    },
    startedAt: TIMESTAMP,
    finishedAt: TIMESTAMP
  }
  const updatedToolCalls: ToolCallRecord[] = []
  const emittedTypes: string[] = []
  const context: BackgroundTaskLifecycleContext = {
    deps: {
      timestamp: () => TIMESTAMP,
      loadThreadToolCalls: () => [toolCall],
      storage: {
        updateToolCall: (updated: ToolCallRecord) => {
          updatedToolCalls.push(updated)
        },
        getChannelUser: () => undefined
      },
      emit: (event: { type: string }) => {
        emittedTypes.push(event.type)
      }
    } as unknown as BackgroundTaskLifecycleContext['deps'],
    backgroundTaskRunContext: new Map(),
    isClosing: () => false,
    sendChat: async () => {
      throw new Error('cancelled background task should not auto-deliver')
    }
  }

  handleBackgroundBashCompleted(context, {
    taskId: 'tc-bg',
    command: 'sleep 10',
    logPath: '/workspace/.yachiyo/tool-output/tc-bg.log',
    exitCode: 137,
    threadId: 'thread-1',
    toolCallId: 'tc-bg',
    cancelledByUser: true
  })

  assert.deepEqual(updatedToolCalls, [])
  assert.deepEqual(emittedTypes, ['background-task.completed'])
})
