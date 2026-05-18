import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ComposerReasoningSelection,
  ThreadRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { startRecoveredRun } from '../active/activeRunStart.ts'
import { sendActiveRunSteer, sendChatFlow, type SendChatFlowContext } from '../chat/sendChatFlow.ts'
import {
  deleteQueuedFollowUpDraft,
  projectQueuedFollowUpDraftSnapshot,
  startQueuedFollowUpIfPresent,
  type FollowUpQueueContext,
  type QueuedFollowUpDraft
} from '../queue/followUpQueue.ts'
import { YachiyoServerRunDomain } from '../runDomain.ts'
import type { RunState } from '../runTypes.ts'

function createDomain(cancelledRunIds: string[] = []): YachiyoServerRunDomain {
  return new YachiyoServerRunDomain({
    storage: {
      cancelRun: (input: { runId: string }) => {
        cancelledRunIds.push(input.runId)
      }
    },
    createId: () => 'id',
    timestamp: () => '2026-05-02T00:00:00.000Z',
    emit: () => {},
    runInactivityTimeoutMs: 30_000,
    auxiliaryGeneration: {},
    createModelRuntime: () => ({}),
    ensureThreadWorkspace: async () => '/tmp/yachiyo-test',
    memoryService: {
      hasHiddenSearchCapability: () => false,
      isConfigured: () => false
    },
    readConfig: () => ({ enabledTools: [] }),
    readSettings: () => ({
      providerName: 'work',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1'
    }),
    listSkills: async () => [],
    requireThread: (threadId: string) => ({
      id: threadId,
      title: 'Thread',
      updatedAt: '2026-05-02T00:00:00.000Z'
    }),
    loadThreadMessages: () => [],
    loadThreadToolCalls: () => []
  } as unknown as ConstructorParameters<typeof YachiyoServerRunDomain>[0])
}

test('withdrawPendingSteer restores the reasoning effort replaced by the steer', () => {
  const domain = createDomain()
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRun = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    enabledTools: [
      'read',
      'write',
      'edit',
      'bash',
      'jsRepl',
      'grep',
      'glob',
      'webRead',
      'webSearch'
    ],
    enabledSkillNames: ['original-skill'],
    runMode: 'auto',
    reasoningEffort: 'medium' as ComposerReasoningSelection,
    runTrigger: 'channel' as const,
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const domainState = domain as unknown as {
    activeRuns: Map<string, typeof activeRun>
    activeRunByThread: Map<string, string>
  }

  domainState.activeRuns.set('run-1', activeRun)
  domainState.activeRunByThread.set(thread.id, 'run-1')

  sendActiveRunSteer(
    {
      deps: { timestamp: () => '2026-05-02T00:00:00.000Z' } as SendChatFlowContext['deps'],
      activeRuns: domainState.activeRuns as SendChatFlowContext['activeRuns'],
      activeRunByThread: domainState.activeRunByThread,
      debouncedSendChats: new Map(),
      queuedFollowUpDrafts: new Map(),
      threadTitleRunner: {
        schedule: () => {}
      } as unknown as SendChatFlowContext['threadTitleRunner'],
      startActiveRun: () => {}
    },
    {
      activeRunId: 'run-1',
      content: 'steer',
      enabledTools: [],
      enabledSkillNames: ['steer-skill'],
      runMode: 'chat',
      reasoningEffort: 'high',
      runTrigger: 'local',
      images: [],
      attachments: [],
      messageId: 'steer-1',
      thread
    }
  )

  assert.equal(activeRun.reasoningEffort, 'high')
  assert.deepEqual(activeRun.enabledTools, [])
  assert.equal(activeRun.runMode, 'chat')
  assert.equal(activeRun.runTrigger, 'local')

  domain.withdrawPendingSteer(thread.id)

  assert.deepEqual(activeRun.enabledTools, [
    'read',
    'write',
    'edit',
    'bash',
    'jsRepl',
    'grep',
    'glob',
    'webRead',
    'webSearch'
  ])
  assert.deepEqual(activeRun.enabledSkillNames, ['original-skill'])
  assert.equal(activeRun.runMode, 'auto')
  assert.equal(activeRun.reasoningEffort, 'medium')
  assert.equal(activeRun.runTrigger, 'channel')
})

test('sendActiveRunSteer keeps hidden and visible pending steers separate', () => {
  const domain = createDomain()
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRun: RunState = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const domainState = domain as unknown as {
    activeRuns: Map<string, typeof activeRun>
    activeRunByThread: Map<string, string>
  }
  const context: SendChatFlowContext = {
    deps: { timestamp: () => '2026-05-02T00:00:00.000Z' } as SendChatFlowContext['deps'],
    activeRuns: domainState.activeRuns as SendChatFlowContext['activeRuns'],
    activeRunByThread: domainState.activeRunByThread,
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: new Map(),
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  domainState.activeRuns.set('run-1', activeRun)
  domainState.activeRunByThread.set(thread.id, 'run-1')

  sendActiveRunSteer(context, {
    activeRunId: 'run-1',
    content: 'system notice',
    runMode: 'auto',
    runTrigger: 'local',
    images: [],
    attachments: [],
    messageId: 'hidden-steer',
    thread,
    hidden: true
  })
  sendActiveRunSteer(context, {
    activeRunId: 'run-1',
    content: 'user steer',
    runMode: 'auto',
    runTrigger: 'local',
    images: [],
    attachments: [],
    messageId: 'visible-steer',
    thread
  })

  const pending = (
    activeRun as {
      pendingSteerInputs?: Array<{
        id?: string
        messageId: string
        hidden?: boolean
        content: string
      }>
    }
  ).pendingSteerInputs
  assert.deepEqual(
    pending?.map((steer) => ({
      content: steer.content,
      hidden: steer.hidden === true,
      messageId: steer.messageId
    })),
    [
      { content: 'system notice', hidden: true, messageId: 'hidden-steer' },
      { content: 'user steer', hidden: false, messageId: 'visible-steer' }
    ]
  )
})

test('sendActiveRunSteer keeps steered run mode and enabled tools in sync', () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRun: RunState = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    enabledTools: [
      'read',
      'write',
      'edit',
      'bash',
      'jsRepl',
      'grep',
      'glob',
      'webRead',
      'webSearch'
    ],
    runMode: 'auto',
    abortController: new AbortController(),
    executionPhase: 'generating',
    updateHeadOnComplete: true
  }

  sendActiveRunSteer(
    {
      deps: { timestamp: () => '2026-05-02T00:00:00.000Z' } as SendChatFlowContext['deps'],
      activeRuns: new Map([['run-1', activeRun]]),
      activeRunByThread: new Map([[thread.id, 'run-1']]),
      debouncedSendChats: new Map(),
      queuedFollowUpDrafts: new Map(),
      threadTitleRunner: {
        schedule: () => {}
      } as unknown as SendChatFlowContext['threadTitleRunner'],
      startActiveRun: () => {}
    },
    {
      activeRunId: 'run-1',
      content: 'switch to chat',
      enabledTools: [],
      runMode: 'chat',
      runTrigger: 'local',
      images: [],
      attachments: [],
      messageId: 'steer-chat',
      thread
    }
  )

  assert.equal(activeRun.runMode, 'chat')
  assert.deepEqual(activeRun.enabledTools, [])
  assert.deepEqual(activeRun.pendingSteerInputs?.[0]?.enabledTools, [])
})

test('sendActiveRunSteer keeps visible steers as the final anchor when hidden arrives later', () => {
  const domain = createDomain()
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRun: RunState = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const domainState = domain as unknown as {
    activeRuns: Map<string, typeof activeRun>
    activeRunByThread: Map<string, string>
  }
  const context: SendChatFlowContext = {
    deps: { timestamp: () => '2026-05-02T00:00:00.000Z' } as SendChatFlowContext['deps'],
    activeRuns: domainState.activeRuns as SendChatFlowContext['activeRuns'],
    activeRunByThread: domainState.activeRunByThread,
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: new Map(),
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  domainState.activeRuns.set('run-1', activeRun)
  domainState.activeRunByThread.set(thread.id, 'run-1')

  sendActiveRunSteer(context, {
    activeRunId: 'run-1',
    content: 'user steer',
    enabledSkillNames: ['visible-skill'],
    runMode: 'auto',
    reasoningEffort: 'low',
    runTrigger: 'local',
    images: [],
    attachments: [],
    messageId: 'visible-steer',
    thread
  })
  sendActiveRunSteer(context, {
    activeRunId: 'run-1',
    content: 'system notice',
    enabledSkillNames: ['hidden-skill'],
    runMode: 'auto',
    reasoningEffort: 'high',
    runTrigger: 'channel',
    images: [],
    attachments: [],
    messageId: 'hidden-steer',
    thread,
    hidden: true
  })

  const pending = (
    activeRun as {
      pendingSteerInputs?: Array<{
        messageId: string
        hidden?: boolean
        content: string
      }>
    }
  ).pendingSteerInputs
  assert.deepEqual(
    pending?.map((steer) => ({
      content: steer.content,
      hidden: steer.hidden === true,
      messageId: steer.messageId
    })),
    [
      { content: 'system notice', hidden: true, messageId: 'hidden-steer' },
      { content: 'user steer', hidden: false, messageId: 'visible-steer' }
    ]
  )
  assert.deepEqual(activeRun.enabledSkillNames, ['visible-skill'])
  assert.equal(activeRun.reasoningEffort, 'low')
  assert.equal(activeRun.runTrigger, 'local')
})

test('sendChatFlow keeps hidden follow-ups separate from a visible queued draft', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  let id = 0
  const activeRun = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const context: SendChatFlowContext = {
    deps: {
      createId: () => `message-${++id}`,
      timestamp: () => '2026-05-02T00:00:00.000Z',
      requireThread: () => thread,
      readConfig: () => ({ enabledTools: [] }),
      emit: () => {}
    } as unknown as SendChatFlowContext['deps'],
    activeRuns: new Map([['run-1', activeRun]]) as SendChatFlowContext['activeRuns'],
    activeRunByThread: new Map([[thread.id, 'run-1']]),
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: new Map(),
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  const visible = await sendChatFlow(context, {
    threadId: thread.id,
    content: 'visible follow-up',
    mode: 'follow-up'
  })
  const hidden = await sendChatFlow(context, {
    threadId: thread.id,
    content: 'hidden notice',
    mode: 'follow-up',
    hidden: true
  })

  const draft = context.queuedFollowUpDrafts.get(thread.id)
  assert.equal(visible.kind, 'active-run-follow-up')
  assert.equal(hidden.kind, 'active-run-follow-up')
  assert.equal(draft?.userMessage.id, visible.userMessage.id)
  assert.equal(draft?.userMessage.hidden, undefined)
  assert.equal(draft?.userMessage.content, 'visible follow-up')
  assert.deepEqual(
    draft?.hiddenDrafts?.map((hiddenDraft) => ({
      content: hiddenDraft.userMessage.content,
      hidden: hiddenDraft.userMessage.hidden === true
    })),
    [{ content: 'hidden notice', hidden: true }]
  )
})

test('sendChatFlow keeps an earlier hidden follow-up hidden when a visible draft arrives', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  let id = 0
  const activeRun = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const context: SendChatFlowContext = {
    deps: {
      createId: () => `message-${++id}`,
      timestamp: () => '2026-05-02T00:00:00.000Z',
      requireThread: () => thread,
      readConfig: () => ({ enabledTools: [] }),
      emit: () => {}
    } as unknown as SendChatFlowContext['deps'],
    activeRuns: new Map([['run-1', activeRun]]) as SendChatFlowContext['activeRuns'],
    activeRunByThread: new Map([[thread.id, 'run-1']]),
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: new Map(),
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  const hidden = await sendChatFlow(context, {
    threadId: thread.id,
    content: 'hidden notice',
    mode: 'follow-up',
    hidden: true
  })
  const visible = await sendChatFlow(context, {
    threadId: thread.id,
    content: 'visible follow-up',
    mode: 'follow-up'
  })

  const draft = context.queuedFollowUpDrafts.get(thread.id)
  assert.equal(hidden.kind, 'active-run-follow-up')
  assert.equal(visible.kind, 'active-run-follow-up')
  assert.equal(draft?.userMessage.id, visible.userMessage.id)
  assert.equal(draft?.userMessage.hidden, undefined)
  assert.equal(draft?.userMessage.content, 'visible follow-up')
  assert.deepEqual(
    draft?.hiddenDrafts?.map((hiddenDraft) => ({
      content: hiddenDraft.userMessage.content,
      hidden: hiddenDraft.userMessage.hidden === true
    })),
    [{ content: 'hidden notice', hidden: true }]
  )
})

test('sendChatFlow does not expose hidden-only follow-up drafts as visible queued messages', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  let id = 0
  const threadUpdates: ThreadRecord[] = []
  const activeRun = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const context: SendChatFlowContext = {
    deps: {
      createId: () => `message-${++id}`,
      timestamp: () => '2026-05-02T00:00:00.000Z',
      requireThread: () => thread,
      readConfig: () => ({ enabledTools: [] }),
      emit: (event: { type: string; thread?: ThreadRecord }) => {
        if (event.type === 'thread.updated' && event.thread) {
          threadUpdates.push(event.thread)
        }
      }
    } as unknown as SendChatFlowContext['deps'],
    activeRuns: new Map([['run-1', activeRun]]) as SendChatFlowContext['activeRuns'],
    activeRunByThread: new Map([[thread.id, 'run-1']]),
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: new Map(),
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  const hidden = await sendChatFlow(context, {
    threadId: thread.id,
    content: 'hidden notice',
    mode: 'follow-up',
    hidden: true
  })
  const projectedSnapshot = projectQueuedFollowUpDraftSnapshot(context.queuedFollowUpDrafts, {
    thread,
    messages: [],
    toolCalls: []
  })

  assert.equal(hidden.kind, 'active-run-follow-up')
  assert.equal(hidden.thread.queuedFollowUpMessageId, undefined)
  assert.equal(threadUpdates.at(-1)?.queuedFollowUpMessageId, undefined)
  assert.equal(projectedSnapshot.thread.queuedFollowUpMessageId, undefined)
  assert.deepEqual(projectedSnapshot.messages, [])
  assert.equal(context.queuedFollowUpDrafts.get(thread.id)?.userMessage.hidden, true)
})

test('deleteQueuedFollowUpDraft preserves hidden notices attached to a visible draft', async () => {
  let currentThread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  let id = 0
  const activeRun = {
    threadId: currentThread.id,
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const activeRunByThread = new Map([[currentThread.id, 'run-1']])
  const queuedFollowUpDrafts = new Map<string, QueuedFollowUpDraft>()
  const sendContext: SendChatFlowContext = {
    deps: {
      createId: () => `message-${++id}`,
      timestamp: () => '2026-05-02T00:00:00.000Z',
      requireThread: () => currentThread,
      readConfig: () => ({ enabledTools: [] }),
      emit: () => {}
    } as unknown as SendChatFlowContext['deps'],
    activeRuns: new Map([['run-1', activeRun]]) as SendChatFlowContext['activeRuns'],
    activeRunByThread,
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: queuedFollowUpDrafts as SendChatFlowContext['queuedFollowUpDrafts'],
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  const visible = await sendChatFlow(sendContext, {
    threadId: currentThread.id,
    content: 'visible follow-up',
    mode: 'follow-up',
    enabledTools: ['read'],
    runMode: 'auto',
    enabledSkillNames: ['visible-skill'],

    runTrigger: 'local',
    reasoningEffort: 'low'
  })
  assert.equal(visible.kind, 'active-run-follow-up')
  await sendChatFlow(sendContext, {
    threadId: currentThread.id,
    content: 'hidden notice',
    mode: 'follow-up',
    hidden: true,
    enabledTools: ['bash'],
    runMode: 'custom',
    enabledSkillNames: ['hidden-skill'],

    runTrigger: 'channel',
    reasoningEffort: 'high'
  })

  const startRunInputs: Array<{ userMessage?: { content: string; hidden?: boolean } }> = []
  const startActiveRunInputs: Array<{
    enabledSkillNames?: string[]
    enabledTools: string[]
    runMode: string
    reasoningEffort?: string
    runTrigger: string
  }> = []
  const followUpContext: FollowUpQueueContext = {
    deps: {
      createId: () => `run-${++id}`,
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => currentThread,
      loadThreadMessages: () => [],
      loadThreadToolCalls: () => [],
      readConfig: () => ({ enabledTools: [] }),
      storage: {
        getThread: () => currentThread,
        updateThread: (thread: ThreadRecord) => {
          currentThread = thread
        },
        updateMessage: () => {},
        startRun: (input: { userMessage?: { content: string; hidden?: boolean } }) => {
          startRunInputs.push(input)
        }
      },
      emit: () => {}
    } as unknown as FollowUpQueueContext['deps'],
    activeRunByThread,
    queuedFollowUpDrafts: sendContext.queuedFollowUpDrafts,
    isClosing: () => false,
    startActiveRun: (input) => {
      startActiveRunInputs.push({
        enabledTools: input.enabledTools,
        enabledSkillNames: input.enabledSkillNames,
        runMode: input.runMode,
        runTrigger: input.runTrigger,
        reasoningEffort: input.reasoningEffort
      })
    },
    startRecoveredRun: () => {}
  }

  deleteQueuedFollowUpDraft(followUpContext, {
    threadId: currentThread.id,
    messageId: visible.userMessage.id
  })
  const remainingDraft = sendContext.queuedFollowUpDrafts.get(currentThread.id)

  assert.equal(currentThread.queuedFollowUpMessageId, undefined)
  assert.equal(remainingDraft?.userMessage.content, 'hidden notice')
  assert.equal(remainingDraft?.userMessage.hidden, true)

  activeRunByThread.clear()
  startQueuedFollowUpIfPresent(followUpContext, currentThread.id)

  assert.deepEqual(
    startRunInputs.map((input) => ({
      content: input.userMessage?.content,
      hidden: input.userMessage?.hidden === true
    })),
    [{ content: 'hidden notice', hidden: true }]
  )
  assert.deepEqual(startActiveRunInputs, [
    {
      enabledTools: ['bash'],
      runMode: 'custom',
      enabledSkillNames: ['hidden-skill'],

      runTrigger: 'channel',
      reasoningEffort: 'high'
    }
  ])
})

test('listActiveRunIds returns user-visible active runs only', () => {
  const domain = createDomain()
  const activeRun = {
    threadId: 'thread-1',
    requestMessageId: 'user-1',
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const recapRun = {
    ...activeRun,
    threadId: 'thread-2',
    recap: true
  }
  const domainState = domain as unknown as {
    activeRuns: Map<string, typeof activeRun | typeof recapRun>
    activeRunByThread: Map<string, string>
  }

  domainState.activeRuns.set('run-1', activeRun)
  domainState.activeRuns.set('run-recap', recapRun)
  domainState.activeRunByThread.set('thread-1', 'run-1')
  domainState.activeRunByThread.set('thread-2', 'run-recap')

  assert.deepEqual(domain.listActiveRunIds(), ['run-1'])
})

test('cancelActiveRuns stops every user-visible active run', () => {
  const domain = createDomain()
  const runOneController = new AbortController()
  const runTwoController = new AbortController()
  const recapController = new AbortController()
  const activeRun = {
    threadId: 'thread-1',
    requestMessageId: 'user-1',
    abortController: runOneController,
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const secondActiveRun = {
    ...activeRun,
    threadId: 'thread-2',
    abortController: runTwoController
  }
  const recapRun = {
    ...activeRun,
    threadId: 'thread-3',
    abortController: recapController,
    recap: true
  }
  const domainState = domain as unknown as {
    activeRuns: Map<string, typeof activeRun | typeof secondActiveRun | typeof recapRun>
    activeRunByThread: Map<string, string>
  }

  domainState.activeRuns.set('run-1', activeRun)
  domainState.activeRuns.set('run-2', secondActiveRun)
  domainState.activeRuns.set('run-recap', recapRun)
  domainState.activeRunByThread.set('thread-1', 'run-1')
  domainState.activeRunByThread.set('thread-2', 'run-2')
  domainState.activeRunByThread.set('thread-3', 'run-recap')

  domain.cancelActiveRuns()

  assert.equal(runOneController.signal.aborted, true)
  assert.equal(runTwoController.signal.aborted, true)
  assert.equal(recapController.signal.aborted, false)
})

test('startRecoveredRun restores the persisted run trigger instead of deriving from channel hint', () => {
  const thread: ThreadRecord = {
    id: 'thread-recovered',
    title: 'Recovered',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRuns = new Map()
  const activeRunByThread = new Map<string, string>()
  const runLoopInputs: Array<{ runTrigger?: string }> = []
  const checkpoint = {
    runId: 'run-recovered',
    threadId: thread.id,
    requestMessageId: 'user-recovered',
    assistantMessageId: 'assistant-recovered',
    content: 'partial',
    enabledTools: ['read'],
    runMode: 'auto',
    runTrigger: 'local',
    channelHint: '<channel_reply_instruction>reply outside local app</channel_reply_instruction>',
    updateHeadOnComplete: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    recoveryAttempts: 1
  } as unknown as RunRecoveryCheckpoint

  startRecoveredRun(
    {
      deps: {
        requireThread: () => thread,
        loadThreadToolCalls: () => [],
        emit: () => {}
      } as unknown as Parameters<typeof startRecoveredRun>[0]['deps'],
      activeRuns,
      activeRunByThread,
      activeRunTasks: new Map(),
      isClosing: () => false,
      runLoop: async (input) => {
        runLoopInputs.push({ runTrigger: input.runTrigger })
      },
      threadTitleRunner: { schedule: () => {} } as unknown as Parameters<
        typeof startRecoveredRun
      >[0]['threadTitleRunner']
    },
    checkpoint
  )

  assert.equal(activeRuns.get('run-recovered')?.runTrigger, 'local')
  assert.equal(runLoopInputs[0]?.runTrigger, 'local')
})

test('startRecoveredRun derives missing run mode from checkpoint tools', () => {
  const thread: ThreadRecord = {
    id: 'thread-recovered',
    title: 'Recovered',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRuns = new Map()
  const activeRunByThread = new Map<string, string>()
  const runLoopInputs: Array<{ runMode?: string }> = []
  const checkpoint = {
    runId: 'run-recovered',
    threadId: thread.id,
    requestMessageId: 'user-recovered',
    assistantMessageId: 'assistant-recovered',
    content: 'partial',
    enabledTools: ['read', 'grep', 'glob', 'webRead', 'webSearch'],
    runTrigger: 'local',
    updateHeadOnComplete: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    recoveryAttempts: 1
  } as unknown as RunRecoveryCheckpoint

  startRecoveredRun(
    {
      deps: {
        requireThread: () => thread,
        loadThreadToolCalls: () => [],
        emit: () => {}
      } as unknown as Parameters<typeof startRecoveredRun>[0]['deps'],
      activeRuns,
      activeRunByThread,
      activeRunTasks: new Map(),
      isClosing: () => false,
      runLoop: async (input) => {
        runLoopInputs.push({ runMode: input.runMode })
      },
      threadTitleRunner: { schedule: () => {} } as unknown as Parameters<
        typeof startRecoveredRun
      >[0]['threadTitleRunner']
    },
    checkpoint
  )

  assert.equal(activeRuns.get('run-recovered')?.runMode, 'explore')
  assert.equal(runLoopInputs[0]?.runMode, 'explore')
})
