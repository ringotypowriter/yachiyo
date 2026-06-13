import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  MessageRecord,
  ProviderSettings,
  ThreadRecord,
  ThreadUpdatedEvent
} from '@yachiyo/shared/protocol'
import type { YachiyoStorage } from '../../../../storage/storage.ts'
import { DEFAULT_SETTINGS_CONFIG } from '../../../../settings/settingsStore.ts'
import { buildThreadHandoffPrompt } from '../../../../runtime/context/threadHandoff.ts'
import type { ModelRuntime, ModelStreamRequest } from '../../../../runtime/models/types.ts'
import {
  SeamlessHandoffCoordinator,
  type SeamlessHandoffCoordinatorDeps
} from './seamlessHandoffCoordinator.ts'
import { prepareThreadHandoffContext } from './threadHandoffContext.ts'

function createThread(): ThreadRecord {
  return {
    id: 'thread-1',
    title: 'Long task',
    runMode: 'chat',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    contextHandoffSummary: '### Goal\nKeep building.\n\n### Original message records\n- `/old.md`',
    contextHandoffWatermarkMessageId: 'a1'
  } as ThreadRecord
}

function createSegmentMessages(thread: ThreadRecord): MessageRecord[] {
  return [
    {
      id: 'u1',
      threadId: thread.id,
      role: 'user',
      content: 'old',
      status: 'completed',
      createdAt: '2026-06-01T00:00:00.000Z'
    },
    {
      id: 'a1',
      threadId: thread.id,
      role: 'assistant',
      content: 'old answer',
      status: 'completed',
      createdAt: '2026-06-01T00:00:01.000Z'
    },
    {
      id: 'u2',
      threadId: thread.id,
      role: 'user',
      parentMessageId: 'a1',
      content: 'new task',
      status: 'completed',
      createdAt: '2026-06-01T00:00:02.000Z'
    },
    {
      id: 'a2',
      threadId: thread.id,
      role: 'assistant',
      parentMessageId: 'u2',
      content: 'new answer',
      status: 'completed',
      createdAt: '2026-06-01T00:00:03.000Z'
    }
  ]
}

function createCoordinator(input: {
  thread: ThreadRecord
  workspacePath: string
  messages: MessageRecord[]
  requests: ModelStreamRequest[]
  events: Array<Omit<ThreadUpdatedEvent, 'eventId' | 'timestamp'>>
  streamReply?: ModelRuntime['streamReply']
  listSkills?: SeamlessHandoffCoordinatorDeps['listSkills']
}): SeamlessHandoffCoordinator {
  const settings: ProviderSettings = {
    providerName: 'work',
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    baseUrl: ''
  }
  const storage = {
    getThread: () => input.thread,
    updateThread: (thread: ThreadRecord) => {
      Object.assign(input.thread, thread)
    },
    updateMessage: () => {},
    getChannelUser: () => undefined,
    listThreadRuns: () => [],
    persistResponseMessagesRepairInBackground: () => {}
  } as Partial<YachiyoStorage> as YachiyoStorage
  const deps = {
    storage,
    createId: () => 'handoff-id',
    timestamp: () => '2026-06-01T00:00:05.000Z',
    emit: (event: Parameters<SeamlessHandoffCoordinatorDeps['emit']>[0]) => {
      if (event.type === 'thread.updated') {
        input.events.push(event as Omit<ThreadUpdatedEvent, 'eventId' | 'timestamp'>)
      }
    },
    runInactivityTimeoutMs: 30_000,
    auxiliaryGeneration: {} as never,
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest) {
        input.requests.push(request)
        if (input.streamReply) {
          yield* input.streamReply(request)
          return
        }
        yield '### Goal\nKeep building.\n\n### Original message records\n- `/old.md`\n- `'
        const prompt = String(
          (request.messages.at(-1) as { content?: unknown } | undefined)?.content ?? ''
        )
        yield prompt.match(/`([^`]+\.md)`/)?.[1] ?? 'missing.md'
        yield '`\n\n### Current focus\nContinue the active run.'
      }
    }),
    ensureThreadWorkspace: async () => input.workspacePath,
    memoryService: { isConfigured: () => false } as never,
    readConfig: () => DEFAULT_SETTINGS_CONFIG,
    readSettings: () => settings,
    listSkills: input.listSkills ?? (async () => []),
    requireThread: () => input.thread,
    loadThreadMessages: () => input.messages,
    loadThreadToolCalls: () => []
  }

  return new SeamlessHandoffCoordinator(deps as SeamlessHandoffCoordinatorDeps)
}

test('SeamlessHandoffCoordinator writes one markdown dump and advances context handoff summary watermark atomically', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = createThread()
    const messages = createSegmentMessages(thread)
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinator = createCoordinator({ thread, workspacePath, messages, requests, events })

    const result = await coordinator.handoffAtCheckpoint(thread.id, 'a2', 'step-boundary')

    assert.equal(result.kind, 'completed')
    assert.equal(thread.contextHandoffWatermarkMessageId, 'a2')
    assert.match(thread.contextHandoffSummary ?? '', /### Original message records/)
    assert.match(thread.contextHandoffSummary ?? '', /Continue the active run/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.purpose, 'thread-handoff')
    assert.ok(requests[0]?.tools)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.thread.contextHandoffWatermarkMessageId, 'a2')

    const dumpDir = join(workspacePath, '.yachiyo', 'context-handoffs')
    const files = await readdir(dumpDir)
    assert.equal(files.filter((file) => file.endsWith('.md')).length, 1)
    const markdown = await readFile(join(dumpDir, files[0]!), 'utf8')
    assert.match(markdown, /new task/)
    assert.doesNotMatch(markdown, /old answer/)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('SeamlessHandoffCoordinator builds summary generation from the shared handoff context prefix', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = createThread()
    const messages = createSegmentMessages(thread)
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinator = createCoordinator({
      thread,
      workspacePath,
      messages,
      requests,
      events
    })

    const coordinatorDeps = (
      coordinator as unknown as {
        deps: ConstructorParameters<typeof SeamlessHandoffCoordinator>[0]
      }
    ).deps
    const referenceContext = await prepareThreadHandoffContext({
      deps: coordinatorDeps,
      sourceThread: thread,
      sourceMessages: messages.slice(2),
      requestContent: buildThreadHandoffPrompt(true),
      runId: 'a2',
      settings: {
        providerName: 'work',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test',
        baseUrl: ''
      },
      config: DEFAULT_SETTINGS_CONFIG,
      abortController: new AbortController()
    })

    const result = await coordinator.handoffAtCheckpoint(thread.id, 'a2', 'step-boundary')

    assert.equal(result.kind, 'completed')
    assert.deepEqual(
      requests[0]?.messages.slice(0, -1),
      referenceContext.preparedContext.messages.slice(0, -1)
    )
    assert.equal(requests[0]?.messages.at(-1)?.role, 'user')
    assert.match(
      String(requests[0]?.messages.at(-1)?.content),
      /Update the context handoff summary/
    )
    assert.notEqual(
      requests[0]?.messages.at(-1)?.content,
      referenceContext.preparedContext.messages.at(-1)?.content
    )
    assert.equal(requests[0]?.promptCacheKey, thread.id)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('SeamlessHandoffCoordinator skips without updating the thread when summary generation fails', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = createThread()
    const originalSummary = thread.contextHandoffSummary
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinator = createCoordinator({
      thread,
      workspacePath,
      messages: createSegmentMessages(thread),
      requests,
      events,
      streamReply: async function* () {
        yield 'partial summary'
        throw new Error('provider unavailable')
      }
    })

    const result = await coordinator.handoffAtCheckpoint(thread.id, 'a2', 'step-boundary')

    assert.deepEqual(result, { kind: 'skipped', reason: 'summary-generation-failed' })
    assert.equal(thread.contextHandoffWatermarkMessageId, 'a1')
    assert.equal(thread.contextHandoffSummary, originalSummary)
    assert.equal(requests.length, 1)
    assert.equal(events.length, 0)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('SeamlessHandoffCoordinator rethrows shared handoff context builder failures', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = createThread()
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinator = createCoordinator({
      thread,
      workspacePath,
      messages: createSegmentMessages(thread),
      requests,
      events,
      listSkills: async () => {
        throw new Error('skill catalog unavailable')
      }
    })

    await assert.rejects(
      () => coordinator.handoffAtCheckpoint(thread.id, 'a2', 'step-boundary'),
      /skill catalog unavailable/
    )
    assert.equal(thread.contextHandoffWatermarkMessageId, 'a1')
    assert.equal(requests.length, 0)
    assert.equal(events.length, 0)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('SeamlessHandoffCoordinator rethrows active aborts from summary generation', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = createThread()
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinatorRef: { current?: SeamlessHandoffCoordinator } = {}
    const coordinator = createCoordinator({
      thread,
      workspacePath,
      messages: createSegmentMessages(thread),
      requests,
      events,
      streamReply: async function* () {
        coordinatorRef.current?.abort()
        yield 'partial summary'
        const error = new Error('Aborted')
        error.name = 'AbortError'
        throw error
      }
    })
    coordinatorRef.current = coordinator

    await assert.rejects(
      () => coordinator.handoffAtCheckpoint(thread.id, 'a2', 'step-boundary'),
      (error: unknown) => error instanceof Error && error.name === 'AbortError'
    )
    assert.equal(thread.contextHandoffWatermarkMessageId, 'a1')
    assert.equal(requests.length, 1)
    assert.equal(events.length, 0)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})

test('SeamlessHandoffCoordinator skips checkpoints already covered by the watermark', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = { ...createThread(), contextHandoffWatermarkMessageId: 'a2' }
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinator = createCoordinator({ thread, workspacePath, messages: [], requests, events })

    const result = await coordinator.handoffAtCheckpoint(thread.id, 'a2', 'preflight')

    assert.deepEqual(result, { kind: 'already-covered' })
    assert.equal(requests.length, 0)
    assert.equal(events.length, 0)
  } finally {
    await rm(workspacePath, { recursive: true, force: true })
  }
})
