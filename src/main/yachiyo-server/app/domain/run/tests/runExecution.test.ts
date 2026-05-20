import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_SETTINGS_CONFIG } from '../../../../settings/settingsStore.ts'
import { createEphemeralStorageProxy } from '../chat/ephemeralStorage.ts'
import { prepareServerRunContext } from '../context/prepareServerRunContext.ts'
import { executeServerRun } from '../execution/executeServerRun.ts'
import { mergeRunUsage } from '../execution/runUsage.ts'
import type { RunExecutionDeps } from '../execution/runExecutionTypes.ts'
import { RetryableRunError } from '../../../../runtime/models/runtimeErrors.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import type { MemoryService } from '../../../../services/memory/memoryService.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import type {
  MessageRecord,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord,
  ToolCallRecord
} from '../../../../../../shared/yachiyo/protocol.ts'

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
  activitySourceRecords?: unknown[]
  imageToTextService?: RunExecutionDeps['imageToTextService']
  isModelImageCapable?: boolean
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
      listThreadRuns: () => [],
      saveActivitySourceRecord: (record: unknown) => {
        input.activitySourceRecords?.push(record)
      }
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
    ...(input.imageToTextService ? { imageToTextService: input.imageToTextService } : {}),
    ...(input.isModelImageCapable !== undefined
      ? { isModelImageCapable: input.isModelImageCapable }
      : {}),
    activityTracker: {
      finalizeAndConsume: () => ({
        text: 'ACTIVITY BLOCK',
        startedAt: '2026-04-28T00:00:00.000Z',
        endedAt: '2026-04-28T00:00:01.000Z',
        totalDurationMs: 1_000,
        uniqueApps: 2,
        entries: [
          {
            appName: 'Browser',
            bundleId: 'com.example.browser',
            windowTitle: 'Issue tracker',
            durationMs: 1_000
          }
        ]
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
        runMode: 'auto',
        runTrigger: 'local',
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

test('prepareServerRunContext skips foreground activity for hidden steer requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-hidden-steer-context-'))
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-hidden',
    threadId: thread.id,
    role: 'user',
    content: 'internal continuation note',
    hidden: true,
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const updatedMessages: MessageRecord[] = []
  const activitySourceRecords: unknown[] = []

  try {
    const context = await prepareServerRunContext(
      createRunContextDeps({
        events,
        messages: [requestMessage],
        workspacePath: root,
        updatedMessages,
        activitySourceRecords
      }),
      {
        runId: 'run-hidden',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: [],
        runMode: 'auto',
        runTrigger: 'local',
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        isSteerLeg: true,
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    const userContent = context.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .filter((content): content is string => typeof content === 'string')
      .join('\n')
    assert.equal(userContent.includes('ACTIVITY BLOCK'), false)
    assert.equal(userContent.includes('Mid-run steer'), false)
    assert.deepEqual(activitySourceRecords, [])
    assert.equal(updatedMessages.length, 1)
    assert.equal(updatedMessages[0].turnContext?.activityText, undefined)

    const compiled = events.find(
      (
        event
      ): event is { type: string; contextSources: Array<{ kind: string; summary?: string }> } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'run.context.compiled'
    )
    assert.equal(
      compiled?.contextSources.some((source) => source.kind === 'activity'),
      false
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareServerRunContext injects tool availability changes into the current turn reminder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-tool-reminder-'))
  const thread: ThreadRecord = {
    id: 'thread-tool-reminder',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-tool-reminder',
    threadId: thread.id,
    role: 'user',
    content: 'continue',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const updatedMessages: MessageRecord[] = []

  try {
    const context = await prepareServerRunContext(
      createRunContextDeps({
        events,
        messages: [requestMessage],
        updatedMessages,
        workspacePath: root
      }),
      {
        runId: 'run-tool-reminder',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: ['read', 'write', 'bash'],
        runMode: 'auto',
        previousEnabledTools: ['read', 'bash'],
        previousRunMode: 'auto',
        runTrigger: 'local',
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    const userContent = context.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .filter((content): content is string => typeof content === 'string')
      .join('\n')

    assert.match(userContent, /Tool availability changed for this turn/)
    assert.match(userContent, /Enabled: write\./)
    assert.match(updatedMessages[0]?.turnContext?.reminder ?? '', /Enabled: write\./)
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
        runMode: 'auto',
        runTrigger: 'local',
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

test('prepareServerRunContext persists consumed activity as a durable source record', async () => {
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
  const activitySourceRecords: unknown[] = []

  try {
    await prepareServerRunContext(
      createRunContextDeps({
        events: [],
        messages: [requestMessage],
        workspacePath: root,
        activitySourceRecords
      }),
      {
        runId: 'run-1',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: [],
        runMode: 'auto',
        runTrigger: 'local',
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    assert.deepEqual(activitySourceRecords, [
      {
        id: 'id',
        threadId: 'thread-1',
        runId: 'run-1',
        requestMessageId: 'msg-1',
        startedAt: '2026-04-28T00:00:00.000Z',
        endedAt: '2026-04-28T00:00:01.000Z',
        totalDurationMs: 1_000,
        uniqueApps: 2,
        createdAt: '2026-04-28T00:00:00.000Z',
        summaryText: 'ACTIVITY BLOCK',
        entries: [
          {
            appName: 'Browser',
            bundleId: 'com.example.browser',
            windowTitle: 'Issue tracker',
            durationMs: 1_000
          }
        ]
      }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ephemeral recap storage does not persist activity source records', () => {
  let calls = 0
  const storage = createEphemeralStorageProxy({
    saveActivitySourceRecord: () => {
      calls += 1
    }
  } as unknown as RunExecutionDeps['storage'])

  storage.saveActivitySourceRecord({
    id: 'activity-1',
    threadId: 'thread-1',
    runId: 'run-recap',
    requestMessageId: 'msg-recap',
    startedAt: '2026-04-28T00:00:00.000Z',
    endedAt: '2026-04-28T00:00:01.000Z',
    totalDurationMs: 1_000,
    uniqueApps: 1,
    summaryText: 'ACTIVITY BLOCK',
    entries: [
      {
        appName: 'Browser',
        bundleId: 'com.example.browser',
        durationMs: 1_000
      }
    ],
    createdAt: '2026-04-28T00:00:00.000Z'
  })

  assert.equal(calls, 0)
})

test('prepareServerRunContext persists I2T image replay markers when non-vision models consume images', async () => {
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
    content: 'What is in this picture?',
    images: [
      {
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image/png',
        filename: 'cat.png'
      }
    ],
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const updatedMessages: MessageRecord[] = []

  try {
    const context = await prepareServerRunContext(
      createRunContextDeps({
        events,
        messages: [requestMessage],
        workspacePath: root,
        updatedMessages,
        isModelImageCapable: false,
        imageToTextService: {
          describe: async () => ({ imageHash: 'hash', altText: 'a cat on a keyboard' }),
          inspect: async () => null
        }
      }),
      {
        runId: 'run-1',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: [],
        runMode: 'auto',
        runTrigger: 'local',
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        persistTurnContext: false,
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    assert.equal(updatedMessages.length, 1)
    assert.deepEqual(updatedMessages[0].images, [
      {
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image/png',
        filename: 'cat.png',
        altText: 'a cat on a keyboard',
        replayAsText: true
      }
    ])
    const userContent = context.messages.find((message) => message.role === 'user')?.content
    assert.equal(Array.isArray(userContent), true)
    assert.deepEqual(Array.isArray(userContent) ? userContent.slice(0, 2) : [], [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'text', text: '[Image: a cat on a keyboard]' }
    ])
    assert.equal(
      Array.isArray(userContent) && userContent.some((part) => part.type === 'image'),
      false
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareServerRunContext can use I2T without persisting replay markers', async () => {
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
    content: 'What is in this picture?',
    images: [
      {
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image/png',
        filename: 'cat.png'
      }
    ],
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const updatedMessages: MessageRecord[] = []

  try {
    const context = await prepareServerRunContext(
      createRunContextDeps({
        events,
        messages: [requestMessage],
        workspacePath: root,
        updatedMessages,
        isModelImageCapable: false,
        imageToTextService: {
          describe: async () => ({ imageHash: 'hash', altText: 'a cat on a keyboard' }),
          inspect: async () => null
        }
      }),
      {
        runId: 'run-1',
        thread,
        requestMessageId: requestMessage.id,
        enabledTools: [],
        runMode: 'auto',
        runTrigger: 'local',
        abortController: new AbortController(),
        requestMessage,
        historyMessages: [requestMessage],
        persistTurnContext: false,
        persistImageReplayMarkers: false,
        includeMemoryRecall: false,
        applyStripCompact: false
      }
    )

    assert.deepEqual(updatedMessages, [])
    const userContent = context.messages.find((message) => message.role === 'user')?.content
    assert.equal(Array.isArray(userContent), true)
    assert.deepEqual(Array.isArray(userContent) ? userContent.slice(0, 2) : [], [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'text', text: '[Image: a cat on a keyboard]' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun completes the launch tool call when background bash starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-bg-launch-'))
  const thread: ThreadRecord = {
    id: 'thread-bg-launch',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-bg-launch',
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
  const logPath = join(root, '.yachiyo', 'tool-output', 'tc-bg-launch.log')
  const backgroundOutput = {
    content: [{ type: 'text' as const, text: JSON.stringify({ taskId: 'tc-bg-launch', logPath }) }],
    details: {
      command: 'sleep 10',
      cwd: root,
      stdout: '',
      stderr: '',
      background: true,
      taskId: 'tc-bg-launch',
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
          toolCallId: 'tc-bg-launch',
          toolName: 'bash',
          input: { command: 'sleep 10', timeout: 1, background: true }
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

        yield 'Started.'
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
      runMode: 'auto',
      inactivityTimeoutMs: 30_000,
      runTrigger: 'local',
      runId: 'run-bg-launch',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    })

    assert.equal(result.kind, 'completed')
    const finalToolCall = toolCalls.get('tc-bg-launch')
    assert.equal(finalToolCall?.status, 'completed')
    assert.equal(finalToolCall?.outputSummary, 'background: tc-bg-launch')
    assert.equal((finalToolCall?.details as { background?: boolean } | undefined)?.background, true)
    assert.equal((finalToolCall?.details as { exitCode?: number } | undefined)?.exitCode, undefined)

    const toolEvents = events.filter(
      (event): event is { type: string; toolCall: ToolCallRecord } =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'tool.updated'
    )
    assert.equal(toolEvents.at(-1)?.toolCall.status, 'completed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun persists exitPlanMode as a complete tool-call pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-plan-exit-pair-'))
  const thread: ThreadRecord = {
    id: 'thread-plan-exit',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-plan-exit',
    threadId: thread.id,
    role: 'user',
    content: 'plan it',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const toolCalls = new Map<string, ToolCallRecord>()
  let completedAssistantMessage: MessageRecord | undefined
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
    upsertRunRecoveryCheckpoint: () => {},
    deleteRunRecoveryCheckpoint: () => {},
    createToolCall: (toolCall: ToolCallRecord) => {
      toolCalls.set(toolCall.id, toolCall)
    },
    updateToolCall: (toolCall: ToolCallRecord) => {
      toolCalls.set(toolCall.id, toolCall)
    },
    listThreadToolCalls: () => [...toolCalls.values()],
    completeRun: (input: { assistantMessage: MessageRecord }) => {
      completedAssistantMessage = input.assistantMessage
    },
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
          toolCallId: 'tc-exit-plan',
          toolName: 'exitPlanMode',
          input: { ready: true }
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
          output: {
            content: [
              {
                type: 'text' as const,
                text: 'Plan Mode exited. The UI will display the current plan document.'
              }
            ]
          },
          stepNumber: undefined,
          success: true,
          toolCall
        } as never)

        yield ''
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
      enabledTools: [],
      runMode: 'plan',
      inactivityTimeoutMs: 30_000,
      runTrigger: 'local',
      runId: 'run-plan-exit',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    })

    assert.equal(result.kind, 'completed')
    const responseMessages = completedAssistantMessage?.responseMessages as
      | Array<{
          role: string
          content: Array<{ type: string; toolCallId?: string; toolName?: string }>
        }>
      | undefined
    assert.ok(responseMessages, 'responseMessages should be persisted')
    assert.equal(responseMessages[0]?.role, 'assistant')
    assert.deepEqual(responseMessages[0]?.content[0], {
      type: 'tool-call',
      toolCallId: 'tc-exit-plan',
      toolName: 'exitPlanMode',
      input: { ready: true }
    })
    assert.equal(responseMessages[1]?.role, 'tool')
    assert.equal(responseMessages[1]?.content[0]?.type, 'tool-result')
    assert.equal(responseMessages[1]?.content[0]?.toolCallId, 'tc-exit-plan')
    assert.equal(responseMessages[1]?.content[0]?.toolName, 'exitPlanMode')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun lets auto runs recover from disabled exitPlanMode results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-disabled-plan-exit-'))
  const thread: ThreadRecord = {
    id: 'thread-disabled-plan-exit',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-disabled-plan-exit',
    threadId: thread.id,
    role: 'user',
    content: 'answer normally',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  let completedAssistantMessage: MessageRecord | undefined
  const baseDeps = createRunContextDeps({
    events: [],
    messages: [requestMessage],
    workspacePath: root
  })
  const storage: RunExecutionDeps['storage'] = {
    ...baseDeps.storage,
    upsertRunRecoveryCheckpoint: () => {},
    deleteRunRecoveryCheckpoint: () => {},
    createToolCall: () => {},
    updateToolCall: () => {},
    listThreadToolCalls: () => [],
    completeRun: (input: { assistantMessage: MessageRecord }) => {
      completedAssistantMessage = input.assistantMessage
    },
    cancelRun: () => {},
    failRun: () => {},
    saveThreadMessage: () => {},
    updateRunSnapshot: () => {}
  }
  const deps: RunExecutionDeps = {
    ...baseDeps,
    storage,
    loadThreadToolCalls: () => [],
    createModelRuntime: () => ({
      streamReply: async function* (request) {
        const disabledOutput = { error: 'disabled', metadata: { blocked: true } }
        const conditions = Array.isArray(request.stopWhen)
          ? request.stopWhen
          : request.stopWhen
            ? [request.stopWhen]
            : []
        const stopResults = await Promise.all(
          conditions.map((condition) =>
            condition({
              steps: [
                {
                  toolResults: [
                    {
                      toolName: 'exitPlanMode',
                      output: disabledOutput
                    }
                  ]
                }
              ]
            } as never)
          )
        )
        if (stopResults.some(Boolean)) return

        yield 'Recovered answer'
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
    await executeServerRun(deps, {
      enabledTools: [],
      runMode: 'auto',
      inactivityTimeoutMs: 30_000,
      runTrigger: 'local',
      runId: 'run-disabled-plan-exit',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    })

    assert.equal(completedAssistantMessage?.content, 'Recovered answer')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun keeps background bash launch completion separate from task exit race', async () => {
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
      runMode: 'auto',
      inactivityTimeoutMs: 30_000,
      runTrigger: 'local',
      runId: 'run-bg-race',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    })

    assert.equal(result.kind, 'completed')
    const finalToolCall = toolCalls.get('tc-bg')
    assert.equal(finalToolCall?.status, 'completed')
    assert.equal(finalToolCall?.outputSummary, 'background: tc-bg')
    assert.equal((finalToolCall?.details as { exitCode?: number } | undefined)?.exitCode, undefined)
    assert.equal(finalToolCall?.finishedAt, '2026-04-28T00:00:00.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun continues agent step count from prior run legs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-step-carry-'))
  const thread: ThreadRecord = {
    id: 'thread-step-carry',
    title: 'Thread',
    workspacePath: root,
    updatedAt: '2026-04-28T00:00:00.000Z'
  }
  const requestMessage: MessageRecord = {
    id: 'msg-step-carry',
    threadId: thread.id,
    role: 'user',
    content: 'continue work',
    status: 'completed',
    createdAt: '2026-04-28T00:00:00.000Z'
  }
  const events: unknown[] = []
  const toolCalls = new Map<string, ToolCallRecord>()
  const observedSteps: number[] = []
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
    onAgentStepAdvanced: (step) => {
      observedSteps.push(step)
    },
    createModelRuntime: () => ({
      streamReply: async function* (request) {
        const toolCall = {
          type: 'tool-call',
          dynamic: true,
          toolCallId: 'tc-step-carry',
          toolName: 'bash',
          input: { command: 'echo ok' }
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
          output: {
            content: [{ type: 'text' as const, text: 'ok' }],
            metadata: { cwd: root }
          },
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
      runMode: 'auto',
      inactivityTimeoutMs: 30_000,
      runTrigger: 'local',
      runId: 'run-step-carry',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null,
      priorAgentStepCount: 10
    })

    assert.equal(result.kind, 'completed')
    assert.deepEqual(observedSteps, [11])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('executeServerRun ignores completed background task snapshots for launch tool calls', async () => {
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
      runMode: 'auto',
      inactivityTimeoutMs: 30_000,
      runTrigger: 'local',
      runId: 'run-bg-snapshot',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    })

    assert.equal(result.kind, 'completed')
    const finalToolCall = toolCalls.get('tc-bg-snapshot')
    assert.equal(finalToolCall?.status, 'completed')
    assert.equal(finalToolCall?.outputSummary, 'background: tc-bg-snapshot')
    assert.equal((finalToolCall?.details as { exitCode?: number } | undefined)?.exitCode, undefined)
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
      runMode: 'auto',
      inactivityTimeoutMs: 30_000,
      reasoningEffort: 'high',
      runTrigger: 'local',
      channelHint: '<channel_reply_instruction>reply outside local app</channel_reply_instruction>',
      runId: 'run-reasoning-checkpoint',
      thread,
      requestMessageId: requestMessage.id,
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    })

    assert.equal(result.kind, 'recovering')
    assert.equal(checkpoints.at(-1)?.reasoningEffort, 'high')
    assert.equal(checkpoints.at(-1)?.runTrigger, 'local')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
