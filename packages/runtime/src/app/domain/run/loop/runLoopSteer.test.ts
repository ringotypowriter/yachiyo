import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_ENABLED_TOOL_NAMES,
  type MessageRecord,
  type ThreadRecord
} from '@yachiyo/shared/protocol'
import {
  handleCancelledWithSteerResult,
  handleSteerPendingResult,
  type RunLoopSteerContext
} from './runLoopSteer.ts'

test('handleSteerPendingResult persists hidden steers before the visible steer anchor', async () => {
  let currentThread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    headMessageId: 'assistant-before-steer',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const savedMessages: MessageRecord[] = []
  let runRequestMessageId: string | undefined

  const context: RunLoopSteerContext = {
    deps: {
      createId: () => 'id',
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => currentThread,
      emit: () => {},
      storage: {
        saveThreadMessage: ({
          message,
          updatedThread
        }: {
          message: MessageRecord
          updatedThread: ThreadRecord
        }) => {
          savedMessages.push(message)
          currentThread = updatedThread
        },
        updateRunRequestMessageId: (_runId: string, messageId: string) => {
          runRequestMessageId = messageId
        }
      }
    } as unknown as RunLoopSteerContext['deps'],
    createSendChatFlowContext: () =>
      ({
        deps: context.deps
      }) as ReturnType<RunLoopSteerContext['createSendChatFlowContext']>,
    createFollowUpQueueContext: () =>
      ({
        deps: {
          requireThread: () => currentThread,
          loadThreadMessages: () => savedMessages,
          loadThreadToolCalls: () => [],
          emit: () => {}
        }
      }) as unknown as ReturnType<RunLoopSteerContext['createFollowUpQueueContext']>
  }

  const activeRun = {
    threadId: 'thread-1',
    requestMessageId: 'user-start',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true,
    pendingSteerInputs: [
      {
        content: 'system notice',
        images: [],
        attachments: [],
        messageId: 'hidden-steer',
        timestamp: '2026-05-02T00:00:00.250Z',
        hidden: true
      },
      {
        content: 'user steer',
        images: [],
        attachments: [],
        messageId: 'visible-steer',
        timestamp: '2026-05-02T00:00:00.500Z'
      }
    ]
  }

  const result = await handleSteerPendingResult(context, {
    accumulatedUsage: undefined,
    activeRun: activeRun as unknown as Parameters<typeof handleSteerPendingResult>[1]['activeRun'],
    carriedToolFailLoopSteers: 0,
    currentRequestMessageId: 'user-start',
    loopInput: {
      enabledTools: [],
      runMode: 'auto',
      requestMessageId: 'user-start',
      runId: 'run-1',
      runTrigger: 'local',
      thread: currentThread,
      updateHeadOnComplete: true
    } as Parameters<typeof handleSteerPendingResult>[1]['loopInput'],
    result: {
      kind: 'steer-pending',
      assistantMessageId: 'assistant-before-steer'
    }
  })

  assert.equal(result.kind, 'continue')
  assert.deepEqual(
    savedMessages.map((message) => ({
      id: message.id,
      parentMessageId: message.parentMessageId,
      hidden: message.hidden === true,
      content: message.content
    })),
    [
      {
        id: 'hidden-steer',
        parentMessageId: 'assistant-before-steer',
        hidden: true,
        content: 'system notice'
      },
      {
        id: 'visible-steer',
        parentMessageId: 'hidden-steer',
        hidden: false,
        content: 'user steer'
      }
    ]
  )
  assert.equal(result.currentRequestMessageId, 'visible-steer')
  assert.equal(runRequestMessageId, 'visible-steer')
})

test('handleSteerPendingResult carries the active snapshot tracker through hidden system steers', async () => {
  let currentThread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    headMessageId: 'assistant-before-steer',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const savedMessages: MessageRecord[] = []
  const markedRestorePoints: string[] = []
  const snapshotTracker = {
    markRestorePoint: async (messageId: string) => {
      markedRestorePoints.push(messageId)
    }
  }

  const context: RunLoopSteerContext = {
    deps: {
      createId: () => 'id',
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => currentThread,
      emit: () => {},
      storage: {
        saveThreadMessage: ({
          message,
          updatedThread
        }: {
          message: MessageRecord
          updatedThread: ThreadRecord
        }) => {
          savedMessages.push(message)
          currentThread = updatedThread
        },
        updateRunRequestMessageId: () => {}
      }
    } as unknown as RunLoopSteerContext['deps'],
    createSendChatFlowContext: () =>
      ({
        deps: context.deps
      }) as ReturnType<RunLoopSteerContext['createSendChatFlowContext']>,
    createFollowUpQueueContext: () =>
      ({
        deps: {
          requireThread: () => currentThread,
          loadThreadMessages: () => savedMessages,
          loadThreadToolCalls: () => [],
          emit: () => {}
        }
      }) as unknown as ReturnType<RunLoopSteerContext['createFollowUpQueueContext']>
  }

  const activeRun = {
    threadId: 'thread-1',
    requestMessageId: 'user-start',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true,
    snapshotTracker,
    pendingSteerInputs: [
      {
        content: 'system reminder',
        images: [],
        attachments: [],
        messageId: 'hidden-steer',
        timestamp: '2026-05-02T00:00:00.250Z',
        hidden: true
      }
    ]
  }

  const result = await handleSteerPendingResult(context, {
    accumulatedUsage: undefined,
    activeRun: activeRun as unknown as Parameters<typeof handleSteerPendingResult>[1]['activeRun'],
    carriedToolFailLoopSteers: 0,
    currentRequestMessageId: 'user-start',
    loopInput: {
      enabledTools: [],
      runMode: 'auto',
      requestMessageId: 'user-start',
      runId: 'run-1',
      runTrigger: 'local',
      thread: currentThread,
      updateHeadOnComplete: true
    } as Parameters<typeof handleSteerPendingResult>[1]['loopInput'],
    result: {
      kind: 'steer-pending',
      assistantMessageId: 'assistant-before-steer'
    }
  })

  assert.equal(result.kind, 'continue')
  if (result.kind === 'continue') {
    assert.equal(result.carriedSnapshotTracker, snapshotTracker)
  }
  assert.deepEqual(markedRestorePoints, ['hidden-steer'])
})

test('handleCancelledWithSteerResult preserves queued visible steer tools after stop', () => {
  let currentThread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    headMessageId: 'stopped-assistant',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const savedMessages: MessageRecord[] = []
  const updatedThreads: ThreadRecord[] = []

  const context: RunLoopSteerContext = {
    deps: {
      createId: () => 'id',
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => currentThread,
      emit: () => {},
      storage: {
        saveThreadMessage: ({
          message,
          updatedThread
        }: {
          message: MessageRecord
          updatedThread: ThreadRecord
        }) => {
          savedMessages.push(message)
          currentThread = updatedThread
        },
        updateThread: (thread: ThreadRecord) => {
          updatedThreads.push(thread)
          currentThread = thread
        }
      }
    } as unknown as RunLoopSteerContext['deps'],
    createSendChatFlowContext: () =>
      ({
        deps: context.deps
      }) as ReturnType<RunLoopSteerContext['createSendChatFlowContext']>,
    createFollowUpQueueContext: () =>
      ({
        deps: {
          requireThread: () => currentThread,
          loadThreadMessages: () => savedMessages,
          loadThreadToolCalls: () => [],
          emit: () => {}
        }
      }) as unknown as ReturnType<RunLoopSteerContext['createFollowUpQueueContext']>
  }

  const activeRun = {
    threadId: 'thread-1',
    requestMessageId: 'user-start',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true,
    pendingSteerInputs: [
      {
        content: 'continue with tools',
        images: [],
        attachments: [],
        messageId: 'visible-steer',
        timestamp: '2026-05-02T00:00:00.500Z',
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        enabledSkillNames: ['workspace-refactor'],
        runMode: 'auto' as const,
        reasoningEffort: 'high' as const
      }
    ]
  }

  const result = handleCancelledWithSteerResult(context, {
    activeRun: activeRun as Parameters<typeof handleCancelledWithSteerResult>[1]['activeRun'],
    loopInput: {
      enabledTools: [],
      runMode: 'chat',
      requestMessageId: 'user-start',
      runId: 'run-1',
      runTrigger: 'local',
      thread: currentThread,
      updateHeadOnComplete: true
    } as Parameters<typeof handleCancelledWithSteerResult>[1]['loopInput'],
    result: {
      kind: 'cancelled-with-steer',
      stoppedMessageId: 'stopped-assistant',
      steerInputs: [],
      usage: undefined
    }
  })

  assert.deepEqual(result, { kind: 'cancelled' })
  assert.equal(currentThread.queuedFollowUpMessageId, 'visible-steer')
  assert.deepEqual(currentThread.queuedFollowUpEnabledTools, DEFAULT_ENABLED_TOOL_NAMES)
  assert.deepEqual(currentThread.queuedFollowUpEnabledSkillNames, ['workspace-refactor'])
  assert.equal(currentThread.queuedFollowUpReasoningEffort, 'high')
  assert.deepEqual(
    updatedThreads.map((thread) => ({
      queuedFollowUpEnabledSkillNames: thread.queuedFollowUpEnabledSkillNames,
      queuedFollowUpEnabledTools: thread.queuedFollowUpEnabledTools,
      queuedFollowUpMessageId: thread.queuedFollowUpMessageId,
      queuedFollowUpReasoningEffort: thread.queuedFollowUpReasoningEffort
    })),
    [
      {
        queuedFollowUpEnabledSkillNames: ['workspace-refactor'],
        queuedFollowUpEnabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        queuedFollowUpMessageId: 'visible-steer',
        queuedFollowUpReasoningEffort: 'high'
      }
    ]
  )
})

test('handleCancelledWithSteerResult does not queue hidden-only steers as follow-ups', () => {
  let currentThread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    headMessageId: 'stopped-assistant',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const savedMessages: MessageRecord[] = []
  const updatedThreads: ThreadRecord[] = []

  const context: RunLoopSteerContext = {
    deps: {
      createId: () => 'id',
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => currentThread,
      emit: () => {},
      storage: {
        saveThreadMessage: ({
          message,
          updatedThread
        }: {
          message: MessageRecord
          updatedThread: ThreadRecord
        }) => {
          savedMessages.push(message)
          currentThread = updatedThread
        },
        updateThread: (thread: ThreadRecord) => {
          updatedThreads.push(thread)
          currentThread = thread
        }
      }
    } as unknown as RunLoopSteerContext['deps'],
    createSendChatFlowContext: () =>
      ({
        deps: context.deps
      }) as ReturnType<RunLoopSteerContext['createSendChatFlowContext']>,
    createFollowUpQueueContext: () =>
      ({
        deps: {
          requireThread: () => currentThread,
          loadThreadMessages: () => savedMessages,
          loadThreadToolCalls: () => [],
          emit: () => {}
        }
      }) as unknown as ReturnType<RunLoopSteerContext['createFollowUpQueueContext']>
  }

  const activeRun = {
    threadId: 'thread-1',
    requestMessageId: 'user-start',
    abortController: new AbortController(),
    executionPhase: 'tool-running' as const,
    updateHeadOnComplete: true,
    pendingSteerInputs: [
      {
        content: 'internal recovery note',
        images: [],
        attachments: [],
        messageId: 'hidden-steer',
        timestamp: '2026-05-02T00:00:00.500Z',
        hidden: true
      }
    ]
  }

  const result = handleCancelledWithSteerResult(context, {
    activeRun: activeRun as Parameters<typeof handleCancelledWithSteerResult>[1]['activeRun'],
    loopInput: {
      enabledTools: [],
      runMode: 'auto',
      requestMessageId: 'user-start',
      runId: 'run-1',
      runTrigger: 'local',
      thread: currentThread,
      updateHeadOnComplete: true
    } as Parameters<typeof handleCancelledWithSteerResult>[1]['loopInput'],
    result: {
      kind: 'cancelled-with-steer',
      stoppedMessageId: 'stopped-assistant',
      steerInputs: [],
      usage: undefined
    }
  })

  assert.deepEqual(result, { kind: 'cancelled' })
  assert.deepEqual(
    savedMessages.map((message) => ({
      id: message.id,
      hidden: message.hidden === true,
      content: message.content
    })),
    [{ id: 'hidden-steer', hidden: true, content: 'internal recovery note' }]
  )
  assert.equal(currentThread.queuedFollowUpMessageId, undefined)
  assert.deepEqual(
    updatedThreads.map((thread) => thread.queuedFollowUpMessageId),
    []
  )
})
