import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as flushImmediate } from 'node:timers/promises'

import type {
  ChatAccepted,
  SendChatInput,
  ThreadRecord,
  ToolCallRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
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

test('handleBackgroundBashCompleted auto-delivers completion notices as hidden steers', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    source: 'local',
    updatedAt: TIMESTAMP
  }
  const sentInputs: SendChatInput[] = []
  const context: BackgroundTaskLifecycleContext = {
    deps: {
      timestamp: () => TIMESTAMP,
      requireThread: () => thread,
      loadThreadToolCalls: () => [],
      storage: {
        getChannelUser: () => undefined
      },
      emit: () => {}
    } as unknown as BackgroundTaskLifecycleContext['deps'],
    backgroundTaskRunContext: new Map(),
    isClosing: () => false,
    sendChat: async (input) => {
      sentInputs.push(input)
      return {
        kind: 'active-run-steer-pending',
        runId: 'run-1',
        thread
      } as ChatAccepted
    }
  }

  handleBackgroundBashCompleted(context, {
    taskId: 'task-1',
    command: 'sleep 1',
    logPath: '/workspace/.yachiyo/tool-output/task-1.log',
    exitCode: 0,
    threadId: thread.id
  })
  await flushImmediate()

  assert.deepEqual(
    sentInputs.map((input) => ({
      mode: input.mode,
      hidden: input.hidden === true,
      content: input.content
    })),
    [
      {
        mode: 'steer',
        hidden: true,
        content:
          '[Background task completed]\n' +
          'Task ID: task-1\n' +
          'Command: sleep 1\n' +
          'Exit code: 0\n' +
          'Log file: /workspace/.yachiyo/tool-output/task-1.log\n\n' +
          'The background command has finished. You can read the log file for full output.'
      }
    ]
  )
})

test('handleBackgroundBashCompleted keeps fallback auto-delivery hidden', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    source: 'local',
    updatedAt: TIMESTAMP
  }
  const sentInputs: SendChatInput[] = []
  const context: BackgroundTaskLifecycleContext = {
    deps: {
      timestamp: () => TIMESTAMP,
      requireThread: () => thread,
      loadThreadToolCalls: () => [],
      storage: {
        getChannelUser: () => undefined
      },
      emit: () => {}
    } as unknown as BackgroundTaskLifecycleContext['deps'],
    backgroundTaskRunContext: new Map(),
    isClosing: () => false,
    sendChat: async (input) => {
      sentInputs.push(input)
      if (input.mode === 'steer') {
        throw new Error('steer rejected')
      }
      return {
        kind: 'run-started',
        runId: 'run-1',
        thread,
        userMessage: {
          id: 'message-1',
          threadId: thread.id,
          role: 'user',
          content: input.content,
          hidden: true,
          status: 'completed',
          createdAt: TIMESTAMP
        }
      } as ChatAccepted
    }
  }

  handleBackgroundBashCompleted(context, {
    taskId: 'task-1',
    command: 'sleep 1',
    logPath: '/workspace/.yachiyo/tool-output/task-1.log',
    exitCode: 0,
    threadId: thread.id
  })
  await flushImmediate()

  assert.deepEqual(
    sentInputs.map((input) => ({
      mode: input.mode,
      hidden: input.hidden === true
    })),
    [
      { mode: 'steer', hidden: true },
      { mode: 'follow-up', hidden: true }
    ]
  )
})
