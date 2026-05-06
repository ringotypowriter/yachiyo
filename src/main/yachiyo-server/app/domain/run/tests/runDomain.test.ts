import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ComposerReasoningSelection,
  ThreadRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { startRecoveredRun } from '../active/activeRunStart.ts'
import { sendActiveRunSteer, type SendChatFlowContext } from '../chat/sendChatFlow.ts'
import { YachiyoServerRunDomain } from '../runDomain.ts'

function createDomain(): YachiyoServerRunDomain {
  return new YachiyoServerRunDomain({
    storage: {},
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
    enabledSkillNames: ['original-skill'],
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
      enabledSkillNames: ['steer-skill'],
      reasoningEffort: 'high',
      runTrigger: 'local',
      images: [],
      attachments: [],
      messageId: 'steer-1',
      thread
    }
  )

  assert.equal(activeRun.reasoningEffort, 'high')
  assert.equal(activeRun.runTrigger, 'local')

  domain.withdrawPendingSteer(thread.id)

  assert.deepEqual(activeRun.enabledSkillNames, ['original-skill'])
  assert.equal(activeRun.reasoningEffort, 'medium')
  assert.equal(activeRun.runTrigger, 'channel')
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
