import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as flushImmediate } from 'node:timers/promises'

import type {
  ChatAccepted,
  SendChatInput,
  ThreadRecord,
  ToolCallRecord
} from '@yachiyo/shared/protocol'
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
test('handleBackgroundBashCompleted publishes native errors as failures', async () => {
  const thread: ThreadRecord = {
    id: 'thread-native-error',
    title: 'Thread',
    source: 'local',
    updatedAt: TIMESTAMP
  }
  const toolCall: ToolCallRecord = {
    id: 'tc-native-error',
    runId: 'run-native-error',
    threadId: thread.id,
    requestMessageId: 'msg-native-error',
    toolName: 'bash',
    status: 'background',
    inputSummary: 'native-command',
    outputSummary: 'background: tc-native-error',
    details: {
      command: 'native-command',
      cwd: '/workspace',
      stdout: '',
      stderr: '',
      background: true,
      taskId: 'native-error-task',
      logPath: '/workspace/native-error.log'
    },
    startedAt: TIMESTAMP
  }
  const updatedToolCalls: ToolCallRecord[] = []
  const emitted: Array<{ type: string; error?: string }> = []
  const sentInputs: SendChatInput[] = []
  const context: BackgroundTaskLifecycleContext = {
    deps: {
      timestamp: () => TIMESTAMP,
      requireThread: () => thread,
      loadThreadToolCalls: () => [toolCall],
      storage: {
        updateToolCall: (updated: ToolCallRecord) => updatedToolCalls.push(updated),
        getChannelUser: () => undefined
      },
      emit: (event: { type: string; error?: string }) => emitted.push(event)
    } as unknown as BackgroundTaskLifecycleContext['deps'],
    backgroundTaskRunContext: new Map(),
    isClosing: () => false,
    sendChat: async (input) => {
      sentInputs.push(input)
      return {
        kind: 'active-run-steer-pending',
        runId: 'run-native-error',
        thread
      } as ChatAccepted
    }
  }

  handleBackgroundBashCompleted(context, {
    taskId: 'native-error-task',
    command: 'native-command',
    logPath: '/workspace/native-error.log',
    exitCode: 0,
    error: 'Flush process log: disk full',
    threadId: thread.id,
    toolCallId: toolCall.id
  })
  await flushImmediate()

  assert.equal(updatedToolCalls[0]?.status, 'failed')
  assert.equal(updatedToolCalls[0]?.error, 'Flush process log: disk full')
  assert.equal(
    emitted.find((event) => event.type === 'background-task.completed')?.error,
    'Flush process log: disk full'
  )
  assert.match(sentInputs[0]?.content ?? '', /^\[Background task failed\]/u)
  assert.match(sentInputs[0]?.content ?? '', /Error: Flush process log: disk full/u)
})

test('handleBackgroundBashCompleted routes Worker-owned completion to its Agent mailbox', async () => {
  const delivered: Array<{ agentId: string; threadId: string; message: string }> = []
  const context: BackgroundTaskLifecycleContext = {
    deps: {
      timestamp: () => TIMESTAMP,
      emit: () => {}
    } as unknown as BackgroundTaskLifecycleContext['deps'],
    backgroundTaskRunContext: new Map([
      [
        'task-1',
        {
          enabledTools: [],
          runMode: 'auto',
          runTrigger: 'local',
          ownerAgentId: 'agent-1'
        }
      ]
    ]),
    isClosing: () => false,
    sendChat: async () => {
      throw new Error('Worker-owned completion should not start a parent run')
    },
    deliverToAgent: (input) => {
      delivered.push(input)
    }
  }

  handleBackgroundBashCompleted(context, {
    taskId: 'task-1',
    command: 'sleep 1',
    logPath: '/workspace/.yachiyo/tool-output/task-1.log',
    exitCode: 0,
    threadId: 'thread-1'
  })
  await flushImmediate()

  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]?.agentId, 'agent-1')
  assert.equal(delivered[0]?.threadId, 'thread-1')
  assert.match(delivered[0]?.message ?? '', /Background task completed/)
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
