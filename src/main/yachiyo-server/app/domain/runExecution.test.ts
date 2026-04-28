import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_SETTINGS_CONFIG } from '../../settings/settingsStore.ts'
import { mergeRunUsage, prepareServerRunContext, type RunExecutionDeps } from './runExecution.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import type { ModelUsage } from '../../runtime/types.ts'
import type {
  MessageRecord,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'

function makeUsage(promptTokens: number, completionTokens: number): ModelUsage {
  return {
    promptTokens,
    completionTokens,
    totalPromptTokens: promptTokens,
    totalCompletionTokens: completionTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  }
}

test('mergeRunUsage keeps promptTokens as the current leg size', () => {
  const result = mergeRunUsage(makeUsage(180_000, 1_000), makeUsage(50_000, 2_000))

  assert.deepEqual(result, {
    promptTokens: 50_000,
    completionTokens: 3_000,
    totalPromptTokens: 230_000,
    totalCompletionTokens: 3_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0
  })
})

function createRunContextDeps(input: {
  events: unknown[]
  messages: MessageRecord[]
  workspacePath: string
  updatedMessages?: MessageRecord[]
}): RunExecutionDeps {
  const config: SettingsConfig = {
    ...DEFAULT_SETTINGS_CONFIG,
    subagentProfiles: [],
    workspace: { savedPaths: [] }
  }
  const settings: ProviderSettings = {
    providerName: 'test',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: '',
    baseUrl: ''
  }
  const memoryService = {
    hasHiddenSearchCapability: () => false,
    isConfigured: () => false,
    searchMemories: async () => [],
    testConnection: async () => ({ ok: true, message: 'ok' }),
    recallForContext: async () => ({
      decision: {
        shouldRecall: false,
        score: 0,
        reasons: [],
        messagesSinceLastRecall: 0,
        charsSinceLastRecall: 0,
        idleMs: 0,
        noveltyScore: 0,
        novelTerms: []
      },
      entries: [],
      thread: {
        id: 'thread-1',
        title: 'Thread',
        updatedAt: '2026-04-28T00:00:00.000Z'
      }
    }),
    createMemory: async () => ({ savedCount: 0 }),
    validateAndCreateMemory: async () => ({ savedCount: 0 }),
    distillCompletedRun: async () => ({ savedCount: 0 }),
    saveThread: async () => ({ savedCount: 0 })
  } satisfies MemoryService

  return {
    storage: {
      updateMessage: (message: MessageRecord) => {
        input.updatedMessages?.push(message)
      },
      getChannelUser: () => undefined,
      persistResponseMessagesRepairInBackground: () => {},
      listThreadRuns: () => []
    } as unknown as RunExecutionDeps['storage'],
    createId: () => 'id',
    timestamp: () => '2026-04-28T00:00:00.000Z',
    emit: (event) => {
      input.events.push(event)
    },
    createModelRuntime: () => ({}) as ReturnType<RunExecutionDeps['createModelRuntime']>,
    ensureThreadWorkspace: async () => input.workspacePath,
    memoryService,
    readSoulDocument: async () => null,
    readUserDocument: async () => null,
    readThread: (threadId) => ({
      id: threadId,
      title: 'Thread',
      updatedAt: '2026-04-28T00:00:00.000Z'
    }),
    readConfig: () => config,
    readSettings: () => settings,
    loadThreadMessages: () => input.messages,
    loadThreadToolCalls: () => [],
    listSkills: async () => [],
    onEnabledToolsUsed: () => {},
    activityTracker: {
      finalizeAndConsume: () => ({
        text: 'ACTIVITY BLOCK',
        startedAt: '2026-04-28T00:00:00.000Z',
        totalDurationMs: 1_000,
        uniqueApps: 2
      })
    }
  }
}

test('prepareServerRunContext injects consumed activity and reports it as a context source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-run-context-'))
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-1',
    threadId: thread.id,
    role: 'user',
    content: 'What changed?',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []

  try {
    const context = await prepareServerRunContext(
      createRunContextDeps({ events, messages: [requestMessage], workspacePath: root }),
      {
        runId: 'run-1',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: [],
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        persistTurnContext: false,
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    const userContent = context.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .filter((content): content is string => typeof content === 'string')
      .join('\n')
    assert.match(userContent, /ACTIVITY BLOCK/)

    const compiled = events.find(
      (
        event
      ): event is { type: string; contextSources: Array<{ kind: string; summary?: string }> } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'run.context.compiled'
    )
    assert.deepEqual(
      compiled?.contextSources.find((source) => source.kind === 'activity'),
      {
        kind: 'activity',
        present: true,
        summary: '2 apps'
      }
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareServerRunContext persists consumed activity for replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-run-context-'))
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-1',
    threadId: thread.id,
    role: 'user',
    content: 'What changed?',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const updatedMessages: MessageRecord[] = []

  try {
    await prepareServerRunContext(
      createRunContextDeps({
        events,
        messages: [requestMessage],
        workspacePath: root,
        updatedMessages
      }),
      {
        runId: 'run-1',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: [],
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    assert.equal(updatedMessages.length, 1)
    assert.equal(updatedMessages[0].turnContext?.activityText, 'ACTIVITY BLOCK')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
