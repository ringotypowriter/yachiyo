import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_SETTINGS_CONFIG } from '../../settings/settingsStore.ts'
import {
  executeServerRun,
  mergeRunUsage,
  prepareServerRunContext,
  type RunExecutionDeps
} from './runExecution.ts'
import { RetryableRunError } from '../../runtime/runtimeErrors.ts'
import type { RunRecoveryCheckpoint } from '../../storage/storage.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import type { ModelUsage } from '../../runtime/types.ts'
import type {
  MessageRecord,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord,
  ToolCallRecord
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

test('executeServerRun keeps an explicit background bash completed when completion wins the race', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-bg-race-'))
  const thread: ThreadRecord = {
    id: 'thread-bg-race',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-bg-race',
    threadId: thread.id,
    role: 'user',
    content: 'run it in background',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const toolCalls = new Map<string, ToolCallRecord>()
  const baseDeps = createRunContextDeps({
    events,
    messages: [requestMessage],
    workspacePath: root
  })
  const logPath = join(root, '.yachiyo', 'tool-output', 'tc-bg.log')
  const backgroundOutput = {
    content: [{ type: 'text', text: JSON.stringify({ taskId: 'tc-bg', logPath }) }],
    details: {
      command: 'true',
      cwd: root,
      stdout: '',
      stderr: '',
      background: true,
      taskId: 'tc-bg',
      logPath
    },
    metadata: { cwd: root }
  }
  const storage: RunExecutionDeps['storage'] = {
    ...baseDeps.storage,
    updateMessage: () => {},
    getChannelUser: () => undefined,
    persistResponseMessagesRepairInBackground: () => {},
    listThreadRuns: () => [],
    upsertRunRecoveryCheckpoint: () => {},
    deleteRunRecoveryCheckpoint: () => {},
    createToolCall: (toolCall: ToolCallRecord) => {
      toolCalls.set(toolCall.id, toolCall)
    },
    updateToolCall: (toolCall: ToolCallRecord) => {
      toolCalls.set(toolCall.id, toolCall)
    },
    listThreadToolCalls: () => [...toolCalls.values()],
    completeRun: () => {},
    cancelRun: () => {},
    failRun: () => {},
    saveThreadMessage: () => {},
    updateRunSnapshot: () => {}
  }
  const deps: RunExecutionDeps = {
    ...baseDeps,
    storage,
    loadThreadToolCalls: () => [...toolCalls.values()],
    createModelRuntime: () => ({
      streamReply: async function* (request) {
        const toolCall = {
          type: 'tool-call',
          dynamic: true,
          toolCallId: 'tc-bg',
          toolName: 'bash',
          input: { command: 'true', timeout: 1, background: true }
        }

        request.onToolCallStart?.({
          abortSignal: request.signal,
          messages: request.messages,
          toolCall
        } as never)

        const started = toolCalls.get('tc-bg')
        assert.equal(started?.status, 'running')
        storage.updateToolCall({
          ...started!,
          status: 'completed',
          outputSummary: 'exit 0',
          details: { ...backgroundOutput.details, exitCode: 0 },
          finishedAt: '2026-04-28T00:00:01.000Z'
        } as ToolCallRecord)

        request.onToolCallFinish?.({
          abortSignal: request.signal,
          durationMs: 0,
          experimental_context: undefined,
          functionId: undefined,
          metadata: undefined,
          model: undefined,
          messages: request.messages,
          output: backgroundOutput,
          stepNumber: undefined,
          success: true,
          toolCall
        } as never)

        yield 'Done.'
        request.onFinish?.({
          promptTokens: 1,
          completionTokens: 1,
          totalPromptTokens: 1,
          totalCompletionTokens: 1
        })
      }
    })
  }

  try {
    const result = await executeServerRun(deps, {
      enabledTools: ['bash'],
      inactivityTimeoutMs: 30_000,
      runId: 'run-bg-race',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null
    })

    assert.equal(result.kind, 'completed')
    const finalToolCall = toolCalls.get('tc-bg')
    assert.equal(finalToolCall?.status, 'completed')
    assert.equal(finalToolCall?.outputSummary, 'exit 0')
    assert.equal((finalToolCall?.details as { exitCode?: number } | undefined)?.exitCode, 0)
    assert.equal(finalToolCall?.finishedAt, '2026-04-28T00:00:01.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun resolves a background bash handle from a completed task snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-bg-snapshot-'))
  const thread: ThreadRecord = {
    id: 'thread-bg-snapshot',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-bg-snapshot',
    threadId: thread.id,
    role: 'user',
    content: 'run it in background',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const toolCalls = new Map<string, ToolCallRecord>()
  const baseDeps = createRunContextDeps({
    events,
    messages: [requestMessage],
    workspacePath: root
  })
  const logPath = join(root, '.yachiyo', 'tool-output', 'tc-bg-snapshot.log')
  const backgroundOutput = {
    content: [
      { type: 'text' as const, text: JSON.stringify({ taskId: 'tc-bg-snapshot', logPath }) }
    ],
    details: {
      command: 'true',
      cwd: root,
      stdout: '',
      stderr: '',
      background: true,
      taskId: 'tc-bg-snapshot',
      logPath
    },
    metadata: { cwd: root }
  }
  const storage: RunExecutionDeps['storage'] = {
    ...baseDeps.storage,
    updateMessage: () => {},
    getChannelUser: () => undefined,
    persistResponseMessagesRepairInBackground: () => {},
    listThreadRuns: () => [],
    upsertRunRecoveryCheckpoint: () => {},
    deleteRunRecoveryCheckpoint: () => {},
    createToolCall: (toolCall: ToolCallRecord) => {
      toolCalls.set(toolCall.id, toolCall)
    },
    updateToolCall: (toolCall: ToolCallRecord) => {
      toolCalls.set(toolCall.id, toolCall)
    },
    listThreadToolCalls: () => [...toolCalls.values()],
    completeRun: () => {},
    cancelRun: () => {},
    failRun: () => {},
    saveThreadMessage: () => {},
    updateRunSnapshot: () => {}
  }
  const deps = {
    ...baseDeps,
    storage,
    loadThreadToolCalls: () => [...toolCalls.values()],
    getCompletedBackgroundBashTask: (taskId: string) =>
      taskId === 'tc-bg-snapshot'
        ? {
            taskId: 'tc-bg-snapshot',
            command: 'true',
            logPath,
            exitCode: 0,
            threadId: thread.id,
            toolCallId: 'tc-bg-snapshot'
          }
        : undefined,
    createModelRuntime: () => ({
      streamReply: async function* (request) {
        const toolCall = {
          type: 'tool-call',
          dynamic: true,
          toolCallId: 'tc-bg-snapshot',
          toolName: 'bash',
          input: { command: 'true', timeout: 1, background: true }
        }

        request.onToolCallStart?.({
          abortSignal: request.signal,
          messages: request.messages,
          toolCall
        } as never)

        request.onToolCallFinish?.({
          abortSignal: request.signal,
          durationMs: 0,
          experimental_context: undefined,
          functionId: undefined,
          metadata: undefined,
          model: undefined,
          messages: request.messages,
          output: backgroundOutput,
          stepNumber: undefined,
          success: true,
          toolCall
        } as never)

        yield 'Done.'
        request.onFinish?.({
          promptTokens: 1,
          completionTokens: 1,
          totalPromptTokens: 1,
          totalCompletionTokens: 1
        })
      }
    })
  } satisfies RunExecutionDeps & {
    getCompletedBackgroundBashTask: (taskId: string) => unknown
  }

  try {
    const result = await executeServerRun(deps, {
      enabledTools: ['bash'],
      inactivityTimeoutMs: 30_000,
      runId: 'run-bg-snapshot',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null
    })

    assert.equal(result.kind, 'completed')
    const finalToolCall = toolCalls.get('tc-bg-snapshot')
    assert.equal(finalToolCall?.status, 'completed')
    assert.equal(finalToolCall?.outputSummary, 'exit 0')
    assert.equal((finalToolCall?.details as { exitCode?: number } | undefined)?.exitCode, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun persists reasoning effort in recovery checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-reasoning-checkpoint-'))
  const thread: ThreadRecord = {
    id: 'thread-reasoning-checkpoint',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-reasoning-checkpoint',
    threadId: thread.id,
    role: 'user',
    content: 'continue with high reasoning',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const checkpoints: RunRecoveryCheckpoint[] = []
  const baseDeps = createRunContextDeps({
    events,
    messages: [requestMessage],
    workspacePath: root
  })
  const storage: RunExecutionDeps['storage'] = {
    ...baseDeps.storage,
    updateMessage: () => {},
    getChannelUser: () => undefined,
    persistResponseMessagesRepairInBackground: () => {},
    listThreadRuns: () => [],
    upsertRunRecoveryCheckpoint: (checkpoint) => {
      checkpoints.push(checkpoint)
    },
    deleteRunRecoveryCheckpoint: () => {},
    createToolCall: () => {},
    updateToolCall: () => {},
    listThreadToolCalls: () => [],
    completeRun: () => {},
    cancelRun: () => {},
    failRun: () => {},
    saveThreadMessage: () => {},
    updateRunSnapshot: () => {}
  }
  const deps: RunExecutionDeps = {
    ...baseDeps,
    storage,
    createModelRuntime: () => ({
      streamReply: async function* () {
        yield 'partial'
        throw new RetryableRunError('temporary transport failure')
      }
    })
  }

  try {
    const result = await executeServerRun(deps, {
      enabledTools: ['read'],
      inactivityTimeoutMs: 30_000,
      reasoningEffort: 'high',
      runId: 'run-reasoning-checkpoint',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null
    })

    assert.equal(result.kind, 'recovering')
    assert.equal(checkpoints.at(-1)?.reasoningEffort, 'high')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
