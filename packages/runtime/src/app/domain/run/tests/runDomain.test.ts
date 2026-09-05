import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_ENABLED_TOOL_NAMES,
  type ComposerReasoningSelection,
  type ThreadRecord,
  type ToolCallRecord
} from '@yachiyo/shared/protocol'
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
import type {
  DeliverSubagentToParentInput,
  SubagentManager
} from '../../subagents/subagentManager.ts'

function createDomain(
  cancelledRunIds: string[] = [],
  options: {
    toolCalls?: ToolCallRecord[]
    updatedToolCalls?: ToolCallRecord[]
    emittedEvents?: unknown[]
    ensureThreadWorkspace?: (threadId: string) => Promise<string>
    startedRunIds?: string[]
  } = {}
): YachiyoServerRunDomain {
  const toolCalls = options.toolCalls ?? []
  return new YachiyoServerRunDomain({
    storage: {
      cancelRun: (input: { runId: string }) => {
        cancelledRunIds.push(input.runId)
      },
      updateToolCall: (toolCall: ToolCallRecord) => {
        options.updatedToolCalls?.push(toolCall)
        const index = toolCalls.findIndex((candidate) => candidate.id === toolCall.id)
        if (index >= 0) toolCalls[index] = toolCall
      },
      startRun: (input: { runId: string }) => options.startedRunIds?.push(input.runId)
    },
    createId: () => 'id',
    timestamp: () => '2026-05-02T00:00:00.000Z',
    emit: (event: unknown) => {
      options.emittedEvents?.push(event)
    },
    runInactivityTimeoutMs: 30_000,
    auxiliaryGeneration: {},
    createModelRuntime: () => ({}),
    ensureThreadWorkspace: options.ensureThreadWorkspace ?? (async () => '/tmp/yachiyo-test'),
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
    loadThreadToolCalls: () => toolCalls
  } as unknown as ConstructorParameters<typeof YachiyoServerRunDomain>[0])
}
function subagentDetails(
  toolCall: ToolCallRecord
): Extract<NonNullable<ToolCallRecord['details']>, { kind: 'subagent' }> {
  const details = toolCall.details
  if (
    !details ||
    typeof details !== 'object' ||
    !('kind' in details) ||
    details.kind !== 'subagent'
  ) {
    throw new Error('Expected subagent tool details.')
  }
  return details
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
      'pyRepl',
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
    'pyRepl',
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
      'pyRepl',
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

test('sendChatFlow keeps active-run steer on the running tool mode', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const activeRun: RunState = {
    threadId: thread.id,
    requestMessageId: 'user-1',
    enabledTools: [...DEFAULT_ENABLED_TOOL_NAMES],
    runMode: 'auto',
    abortController: new AbortController(),
    executionPhase: 'generating',
    updateHeadOnComplete: true
  }
  const context: SendChatFlowContext = {
    deps: {
      createId: () => 'steer-1',
      timestamp: () => '2026-05-02T00:00:00.000Z',
      requireThread: () => thread,
      readConfig: () => ({ enabledTools: DEFAULT_ENABLED_TOOL_NAMES, runMode: 'auto' }),
      emit: () => {}
    } as unknown as SendChatFlowContext['deps'],
    activeRuns: new Map([['run-1', activeRun]]),
    activeRunByThread: new Map([[thread.id, 'run-1']]),
    debouncedSendChats: new Map(),
    queuedFollowUpDrafts: new Map(),
    threadTitleRunner: {
      schedule: () => {}
    } as unknown as SendChatFlowContext['threadTitleRunner'],
    startActiveRun: () => {}
  }

  const accepted = await sendChatFlow(context, {
    threadId: thread.id,
    content: 'keep going',
    mode: 'steer',
    runMode: 'plan'
  })

  assert.equal(accepted.kind, 'active-run-steer-pending')
  assert.equal(activeRun.runMode, 'auto')
  assert.deepEqual(activeRun.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
  assert.equal(activeRun.pendingSteerInputs?.[0]?.runMode, 'auto')
  assert.deepEqual(activeRun.pendingSteerInputs?.[0]?.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
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
      hidden: hiddenDraft.userMessage.hidden === true,
      hiddenRequestKind: hiddenDraft.userMessage.turnContext?.hiddenRequestKind
    })),
    [{ content: 'hidden notice', hidden: true, hiddenRequestKind: 'follow-up' }]
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
      hidden: hiddenDraft.userMessage.hidden === true,
      hiddenRequestKind: hiddenDraft.userMessage.turnContext?.hiddenRequestKind
    })),
    [{ content: 'hidden notice', hidden: true, hiddenRequestKind: 'follow-up' }]
  )
})

test('sendChatFlow does not expose hidden-only follow-up drafts as visible queued messages', async () => {
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
  const projectedSnapshot = projectQueuedFollowUpDraftSnapshot(context.queuedFollowUpDrafts, {
    thread,
    messages: [],
    toolCalls: []
  })

  assert.equal(hidden.kind, 'active-run-follow-up')
  assert.deepEqual(hidden.queuedFollowUpMessages, [])
  assert.deepEqual(projectedSnapshot.queuedFollowUpMessages, [])
  assert.deepEqual(projectedSnapshot.messages, [])
  assert.equal(context.queuedFollowUpDrafts.get(thread.id)?.userMessage.hidden, true)
  assert.equal(
    context.queuedFollowUpDrafts.get(thread.id)?.userMessage.turnContext?.hiddenRequestKind,
    'follow-up'
  )
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
    toolPreset: ['read'],
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
    toolPreset: [],
    runMode: 'chat',
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
    pendingRecoveredRuns: new Map(),
    queuedFollowUpDrafts: sendContext.queuedFollowUpDrafts,
    isClosing: () => false,
    isRunAdmissionOpen: () => true,
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
      enabledTools: [],
      runMode: 'chat',
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

test('closing run admission returns the active snapshot and rejects local and channel work', async () => {
  const domain = createDomain()
  const domainState = domain as unknown as {
    activeRuns: Map<string, RunState>
  }
  domainState.activeRuns.set('run-existing', {
    threadId: 'thread-existing',
    requestMessageId: 'message-existing',
    abortController: new AbortController(),
    executionPhase: 'generating',
    updateHeadOnComplete: true
  })

  assert.deepEqual(domain.closeRunAdmissionAndGetActiveRunIds('install-1'), ['run-existing'])
  await assert.rejects(
    () => domain.sendChat({ threadId: 'thread-local', content: 'hello', runTrigger: 'local' }),
    /not accepting new runs/i
  )
  await assert.rejects(
    () => domain.sendChat({ threadId: 'thread-channel', content: 'hello', runTrigger: 'channel' }),
    /not accepting new runs/i
  )
})

test('only the install attempt that closed admission can reopen it', async () => {
  const domain = createDomain()

  domain.closeRunAdmissionAndGetActiveRunIds('install-1')
  assert.throws(() => domain.closeRunAdmissionAndGetActiveRunIds('install-2'), /already closed/i)
  domain.openRunAdmission('install-2')

  await assert.rejects(
    () => domain.sendChat({ threadId: 'thread-local', content: 'hello' }),
    /not accepting new runs/i
  )

  domain.openRunAdmission('install-1')
  assert.doesNotThrow(() => domain.closeRunAdmissionAndGetActiveRunIds('install-2'))
})

test('reopening run admission starts a deferred queued follow-up exactly once', () => {
  const domain = createDomain()
  const thread: ThreadRecord = {
    id: 'thread-deferred-follow-up',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const startedRunIds: string[] = []
  const domainState = domain as unknown as {
    activeRunByThread: Map<string, string>
    queuedFollowUpDrafts: Map<string, QueuedFollowUpDraft>
    runAdmissionOwnerId?: string
    createFollowUpQueueContext: () => FollowUpQueueContext
  }
  domainState.queuedFollowUpDrafts.set(thread.id, {
    enabledTools: [],
    runMode: 'chat',
    runTrigger: 'local',
    userMessage: {
      id: 'message-deferred-follow-up',
      threadId: thread.id,
      role: 'user',
      status: 'completed',
      content: 'continue after the failed update',
      createdAt: '2026-05-02T00:00:00.000Z'
    }
  })
  domainState.createFollowUpQueueContext = () => ({
    deps: {
      createId: () => 'run-deferred-follow-up',
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => thread,
      loadThreadMessages: () => [],
      loadThreadToolCalls: () => [],
      storage: {
        getThread: () => thread,
        startRun: (input: { runId: string }) => startedRunIds.push(input.runId)
      },
      emit: () => {}
    } as unknown as FollowUpQueueContext['deps'],
    activeRunByThread: domainState.activeRunByThread,
    pendingRecoveredRuns: new Map(),
    queuedFollowUpDrafts: domainState.queuedFollowUpDrafts,
    isClosing: () => false,
    isRunAdmissionOpen: () => domainState.runAdmissionOwnerId === undefined,
    startActiveRun: () => {},
    startRecoveredRun: () => {}
  })

  domain.closeRunAdmissionAndGetActiveRunIds('install-owner')
  startQueuedFollowUpIfPresent(domainState.createFollowUpQueueContext(), thread.id)
  domain.openRunAdmission('foreign-owner')

  assert.deepEqual(startedRunIds, [])
  assert.equal(domainState.queuedFollowUpDrafts.has(thread.id), true)

  domain.openRunAdmission('install-owner')
  domain.openRunAdmission('install-owner')

  assert.deepEqual(startedRunIds, ['run-deferred-follow-up'])
  assert.equal(domainState.queuedFollowUpDrafts.has(thread.id), false)
})

test('reopening run admission does not start a queued follow-up for an active thread', () => {
  const domain = createDomain()
  const thread: ThreadRecord = {
    id: 'thread-active-follow-up',
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z'
  }
  const startedRunIds: string[] = []
  const domainState = domain as unknown as {
    activeRunByThread: Map<string, string>
    queuedFollowUpDrafts: Map<string, QueuedFollowUpDraft>
    runAdmissionOwnerId?: string
    createFollowUpQueueContext: () => FollowUpQueueContext
  }
  domainState.activeRunByThread.set(thread.id, 'run-active')
  domainState.queuedFollowUpDrafts.set(thread.id, {
    enabledTools: [],
    runMode: 'chat',
    runTrigger: 'local',
    userMessage: {
      id: 'message-active-follow-up',
      threadId: thread.id,
      role: 'user',
      status: 'completed',
      content: 'continue when active run finishes',
      createdAt: '2026-05-02T00:00:00.000Z'
    }
  })
  domainState.createFollowUpQueueContext = () => ({
    deps: {
      createId: () => 'run-active-follow-up',
      timestamp: () => '2026-05-02T00:00:01.000Z',
      requireThread: () => thread,
      loadThreadMessages: () => [],
      loadThreadToolCalls: () => [],
      storage: {
        getThread: () => thread,
        startRun: (input: { runId: string }) => startedRunIds.push(input.runId)
      },
      emit: () => {}
    } as unknown as FollowUpQueueContext['deps'],
    activeRunByThread: domainState.activeRunByThread,
    pendingRecoveredRuns: new Map(),
    queuedFollowUpDrafts: domainState.queuedFollowUpDrafts,
    isClosing: () => false,
    isRunAdmissionOpen: () => domainState.runAdmissionOwnerId === undefined,
    startActiveRun: () => {},
    startRecoveredRun: () => {}
  })

  domain.closeRunAdmissionAndGetActiveRunIds('install-owner')
  domain.openRunAdmission('install-owner')

  assert.deepEqual(startedRunIds, [])
  assert.equal(domainState.queuedFollowUpDrafts.has(thread.id), true)

  domainState.activeRunByThread.delete(thread.id)
  startQueuedFollowUpIfPresent(domainState.createFollowUpQueueContext(), thread.id)

  assert.deepEqual(startedRunIds, ['run-active-follow-up'])
})

test('scheduled recovered runs wait for the admission owner to reopen admission', async () => {
  const emittedEvents: Array<{ type?: string; runId?: string }> = []
  const domain = createDomain([], { emittedEvents })
  const domainState = domain as unknown as {
    runLoop: () => Promise<void>
  }
  domainState.runLoop = async () => {}
  const checkpoint = {
    runId: 'run-deferred-recovery',
    threadId: 'thread-deferred-recovery',
    requestMessageId: 'message-deferred-recovery',
    assistantMessageId: 'assistant-deferred-recovery',
    content: '',
    enabledTools: [],
    runMode: 'chat',
    runTrigger: 'local',
    updateHeadOnComplete: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    recoveryAttempts: 1
  } as unknown as RunRecoveryCheckpoint

  domain.closeRunAdmissionAndGetActiveRunIds('install-owner')
  domain.scheduleRecoveredRuns([checkpoint])
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(
    emittedEvents.filter((event) => event.type === 'run.created'),
    []
  )

  domain.openRunAdmission('foreign-owner')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    emittedEvents.filter((event) => event.type === 'run.created'),
    []
  )

  domain.openRunAdmission('install-owner')
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(
    emittedEvents.filter((event) => event.type === 'run.created').map((event) => event.runId),
    ['run-deferred-recovery']
  )
})

test('a send waiting on attachment setup cannot cross the atomic admission snapshot', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'yachiyo-admission-'))
  let finishWorkspaceSetup!: () => void
  const workspaceSetup = new Promise<void>((resolve) => {
    finishWorkspaceSetup = resolve
  })
  const startedRunIds: string[] = []
  const domain = createDomain([], {
    startedRunIds,
    ensureThreadWorkspace: async () => {
      await workspaceSetup
      return workspacePath
    }
  })

  try {
    const pendingSend = domain.sendChat({
      threadId: 'thread-local',
      content: 'inspect this',
      images: [
        {
          dataUrl: 'data:image/png;base64,AAAA',
          mediaType: 'image/png',
          filename: 'image.png'
        }
      ]
    })
    await Promise.resolve()

    assert.deepEqual(domain.closeRunAdmissionAndGetActiveRunIds('install-1'), [])
    finishWorkspaceSetup()

    await assert.rejects(pendingSend, /not accepting new runs/i)
    assert.deepEqual(
      startedRunIds,
      [],
      'the rejected send must not persist a run after the snapshot'
    )
  } finally {
    rmSync(workspacePath, { recursive: true, force: true })
  }
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

for (const scenario of [
  { name: 'the latest run used plan mode', runMode: 'plan' },
  { name: 'the thread is a synced archive', runMode: 'auto', syncOriginDeviceId: 'other-device' }
]) {
  test(`requestRecap skips when ${scenario.name}`, async () => {
    let startRunCalled = false
    let createdIds = 0
    const domain = new YachiyoServerRunDomain({
      storage: {
        listThreadRuns: () => [{ requestMessageId: 'user-plan' }],
        startRun: () => {
          startRunCalled = true
        }
      },
      createId: () => `id-${++createdIds}`,
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
        source: 'local',
        syncOriginDeviceId: scenario.syncOriginDeviceId,
        updatedAt: '2026-05-02T00:00:00.000Z'
      }),
      loadThreadMessages: () => [
        { id: 'user-plan', turnContext: { runMode: scenario.runMode } },
        { id: 'message-2' },
        { id: 'message-3' },
        { id: 'message-4' },
        { id: 'message-5' },
        { id: 'message-6' }
      ],
      loadThreadToolCalls: () => []
    } as unknown as ConstructorParameters<typeof YachiyoServerRunDomain>[0])

    const result = await domain.requestRecap({ threadId: 'thread-1' })

    assert.equal(result, null)
    assert.equal(startRunCalled, false)
    assert.equal(createdIds, 0, 'skipped recaps must not allocate run or message IDs')
  })
}

test('startRecoveredRun does nothing while run admission is closed', () => {
  const activeRuns = new Map()
  const activeRunByThread = new Map<string, string>()
  const emittedEvents: unknown[] = []
  const context = {
    deps: {
      requireThread: () => ({
        id: 'thread-recovered-closed',
        title: 'Recovered',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }),
      loadThreadToolCalls: () => [],
      emit: (event: unknown) => emittedEvents.push(event)
    },
    activeRuns,
    activeRunByThread,
    activeRunTasks: new Map(),
    isClosing: () => false,
    isRunAdmissionOpen: () => false,
    runLoop: async () => {},
    threadTitleRunner: { schedule: () => {} }
  } as unknown as Parameters<typeof startRecoveredRun>[0]
  const checkpoint = {
    runId: 'run-recovered-closed',
    threadId: 'thread-recovered-closed',
    requestMessageId: 'user-recovered-closed',
    assistantMessageId: 'assistant-recovered-closed',
    content: 'partial',
    enabledTools: [],
    runMode: 'chat',
    runTrigger: 'local',
    updateHeadOnComplete: true,
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    recoveryAttempts: 1
  } as unknown as RunRecoveryCheckpoint

  startRecoveredRun(context, checkpoint)

  assert.equal(activeRuns.size, 0)
  assert.equal(activeRunByThread.size, 0)
  assert.deepEqual(emittedEvents, [])
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
      isRunAdmissionOpen: () => true,
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
      isRunAdmissionOpen: () => true,
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
test('reconciles the latest idle Worker snapshot after delegate details are persisted', async () => {
  const toolCalls: ToolCallRecord[] = []
  const updatedToolCalls: ToolCallRecord[] = []
  const domain = createDomain([], { toolCalls, updatedToolCalls })
  const manager = (domain as unknown as { subagentManager: SubagentManager }).subagentManager

  await manager.launch({
    agentId: 'agent-fast',
    parentThreadId: 'thread-1',
    launchRunId: 'run-1',
    agentName: 'general',
    agentType: 'general',
    codeName: 'Akari',
    workspacePath: '/workspace',
    prompt: 'Return the final output.',
    runnerFactory: () => ({
      runTurn: async () => ({ output: 'final output' }),
      close: async () => {}
    }),
    deliverToParent: () => {}
  })
  await Promise.resolve()
  await Promise.resolve()

  const snapshot = domain.listSubagents('thread-1')[0]
  assert.equal(snapshot?.state, 'idle')
  assert.equal(snapshot?.lastOutput, 'final output')

  const launchToolCall: ToolCallRecord = {
    id: 'agent-fast',
    threadId: 'thread-1',
    runId: 'run-1',
    toolName: 'delegateTask',
    status: 'completed',
    inputSummary: 'Return the final output.',
    outputSummary: 'Worker launched',
    startedAt: '2026-05-02T00:00:00.000Z',
    details: {
      kind: 'subagent',
      agentId: 'agent-fast',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: '/workspace',
      lifecycleState: 'running',
      snapshotId: 'agent-fast'
    }
  } as ToolCallRecord
  toolCalls.push(launchToolCall)

  const reconciled = (
    domain as unknown as {
      reconcilePersistedSubagentToolCall: (toolCall: ToolCallRecord) => ToolCallRecord
    }
  ).reconcilePersistedSubagentToolCall(launchToolCall)

  assert.equal(subagentDetails(reconciled).lifecycleState, 'idle')
  assert.equal(subagentDetails(reconciled).lastOutput, 'final output')
  assert.equal(reconciled.outputSummary, 'final output')
  assert.equal(updatedToolCalls.at(-1), reconciled)
})

test('recoverOrphanedSubagents marks persisted live Worker details interrupted', () => {
  const domain = createDomain()
  const launchToolCall = {
    id: 'agent-1',
    threadId: 'thread-1',
    toolName: 'delegateTask',
    status: 'completed',
    inputSummary: 'Explore the workspace',
    startedAt: '2026-05-02T00:00:00.000Z',
    details: {
      kind: 'subagent',
      agentId: 'agent-1',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: '/workspace',
      lifecycleState: 'idle'
    }
  } as ToolCallRecord
  const terminalToolCall = {
    ...launchToolCall,
    id: 'agent-2',
    details: {
      ...launchToolCall.details,
      agentId: 'agent-2',
      lifecycleState: 'closed'
    }
  } as ToolCallRecord

  const recovered = domain.recoverOrphanedSubagents({
    'thread-1': [launchToolCall, terminalToolCall]
  })

  const recoveredLiveDetails = subagentDetails(recovered['thread-1']![0]!)
  const recoveredTerminalDetails = subagentDetails(recovered['thread-1']![1]!)
  assert.equal(recoveredLiveDetails.lifecycleState, 'interrupted')
  assert.equal(recoveredLiveDetails.error, 'Agent was interrupted when the application restarted.')
  assert.equal(recoveredTerminalDetails.lifecycleState, 'closed')
})
test('Worker delivery after shutdown begins does not create chat work', async () => {
  const domain = createDomain()
  let sendChatCalls = 0
  const runDomain = domain as unknown as {
    isClosing: boolean
    activeRuns: Map<string, unknown>
    queuedFollowUpDrafts: Map<string, unknown>
    subagentManager: {
      deps: {
        deliverToParent: (input: {
          agentId: string
          parentThreadId: string
          launchRunId: string
          message: string
          kind: 'initial-result' | 'message'
          parentDeliveryContext: {
            enabledTools: string[]
            runMode: 'auto'
            runTrigger: 'local'
          }
        }) => Promise<void>
      }
    }
  }
  domain.sendChat = async () => {
    sendChatCalls += 1
    throw new Error('Unexpected parent delivery.')
  }
  runDomain.isClosing = true
  await runDomain.subagentManager.deps.deliverToParent({
    agentId: 'agent-1',
    parentThreadId: 'thread-1',
    launchRunId: 'run-1',
    message: 'late Worker result',
    kind: 'initial-result',
    parentDeliveryContext: {
      enabledTools: [],
      runMode: 'auto',
      runTrigger: 'local'
    }
  })

  assert.equal(runDomain.isClosing, true)
  assert.equal(sendChatCalls, 0)
  assert.equal(runDomain.activeRuns.size, 0)
  assert.equal(runDomain.queuedFollowUpDrafts.size, 0)
})

test('Worker delivery retains output when its parent thread is archived', async () => {
  let archived = false
  const thread = {
    id: 'thread-archived',
    title: 'Archived',
    updatedAt: '2026-05-02T00:00:00.000Z'
  } as ThreadRecord
  const toolCall = {
    id: 'agent-archived',
    threadId: thread.id,
    toolName: 'delegateTask',
    status: 'completed',
    inputSummary: 'Inspect the workspace',
    startedAt: '2026-05-02T00:00:00.000Z',
    details: {
      kind: 'subagent',
      agentId: 'agent-archived',
      agentName: 'general',
      agentType: 'general',
      codeName: 'Akari',
      workspacePath: '/workspace',
      lifecycleState: 'running'
    }
  } as ToolCallRecord
  let persistedToolCall = toolCall
  let resolveTurn: ((result: { output: string }) => void) | undefined
  const domain = new YachiyoServerRunDomain({
    storage: {
      getThread: () => (archived ? undefined : thread),
      getArchivedThread: () => (archived ? thread : undefined),
      listThreadToolCalls: () => [persistedToolCall],
      updateToolCall: (updated: ToolCallRecord) => {
        persistedToolCall = updated
      },
      cancelRun: () => {}
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
    requireThread: () => {
      throw new Error('Archived threads must not start a model run.')
    },
    loadThreadMessages: () => [],
    loadThreadToolCalls: () => [persistedToolCall]
  } as unknown as ConstructorParameters<typeof YachiyoServerRunDomain>[0])
  const manager = (domain as unknown as { subagentManager: SubagentManager }).subagentManager
  const deliveryToParent = (
    manager as unknown as {
      deps: {
        deliverToParent: (input: DeliverSubagentToParentInput) => Promise<void>
      }
    }
  ).deps.deliverToParent

  await manager.launch({
    agentId: toolCall.id,
    parentThreadId: thread.id,
    launchRunId: 'run-1',
    agentName: 'general',
    agentType: 'general',
    codeName: 'Akari',
    workspacePath: '/workspace',
    prompt: 'Inspect the workspace.',
    parentDeliveryContext: {
      enabledTools: [],
      runMode: 'auto',
      runTrigger: 'local'
    },
    runnerFactory: () => ({
      runTurn: () =>
        new Promise<{ output: string }>((resolve) => {
          resolveTurn = resolve
        }),
      close: async () => {}
    }),
    deliverToParent: deliveryToParent
  })

  archived = true
  if (!resolveTurn) throw new Error('Worker turn did not start.')
  resolveTurn({ output: 'retained Worker output' })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  assert.equal(manager.list(thread.id)[0]?.state, 'idle')
  const details = subagentDetails(persistedToolCall)
  assert.equal(details.lastOutput, 'retained Worker output')
  assert.equal(details.lifecycleState, 'idle')
})
