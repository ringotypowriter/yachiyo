import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ComposerReasoningSelection,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import { YachiyoServerRunDomain } from './runDomain.ts'

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
    abortController: new AbortController(),
    executionPhase: 'generating' as const,
    updateHeadOnComplete: true
  }
  const domainState = domain as unknown as {
    activeRuns: Map<string, typeof activeRun>
    activeRunByThread: Map<string, string>
    sendActiveRunSteer: (input: {
      activeRunId: string
      attachments: []
      content: string
      enabledSkillNames?: string[]
      images: []
      messageId: string
      reasoningEffort?: ComposerReasoningSelection
      thread: ThreadRecord
    }) => unknown
  }

  domainState.activeRuns.set('run-1', activeRun)
  domainState.activeRunByThread.set(thread.id, 'run-1')

  domainState.sendActiveRunSteer({
    activeRunId: 'run-1',
    content: 'steer',
    enabledSkillNames: ['steer-skill'],
    reasoningEffort: 'high',
    images: [],
    attachments: [],
    messageId: 'steer-1',
    thread
  })

  assert.equal(activeRun.reasoningEffort, 'high')

  domain.withdrawPendingSteer(thread.id)

  assert.deepEqual(activeRun.enabledSkillNames, ['original-skill'])
  assert.equal(activeRun.reasoningEffort, 'medium')
})
