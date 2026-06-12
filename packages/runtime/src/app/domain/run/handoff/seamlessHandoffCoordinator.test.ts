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
import type { ModelStreamRequest } from '../../../../runtime/models/types.ts'
import { SeamlessHandoffCoordinator } from './seamlessHandoffCoordinator.ts'

function createThread(): ThreadRecord {
  return {
    id: 'thread-1',
    title: 'Long task',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    rollingSummary: '### Goal\nKeep building.\n\n### Original message records\n- `/old.md`',
    summaryWatermarkMessageId: 'a1'
  } as ThreadRecord
}

function createCoordinator(input: {
  thread: ThreadRecord
  workspacePath: string
  messages: MessageRecord[]
  requests: ModelStreamRequest[]
  events: Array<Omit<ThreadUpdatedEvent, 'eventId' | 'timestamp'>>
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
    }
  } as Partial<YachiyoStorage> as YachiyoStorage

  return new SeamlessHandoffCoordinator({
    storage,
    createId: () => 'handoff-id',
    timestamp: () => '2026-06-01T00:00:05.000Z',
    emit: (event) => {
      if (event.type === 'thread.updated') {
        input.events.push(event as Omit<ThreadUpdatedEvent, 'eventId' | 'timestamp'>)
      }
    },
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest) {
        input.requests.push(request)
        yield '### Goal\nKeep building.\n\n### Original message records\n- `/old.md`\n- `'
        const prompt = String(
          (request.messages.at(-1) as { content?: unknown } | undefined)?.content ?? ''
        )
        yield prompt.match(/`([^`]+\.md)`/)?.[1] ?? 'missing.md'
        yield '`\n\n### Current focus\nContinue the active run.'
      }
    }),
    ensureThreadWorkspace: async () => input.workspacePath,
    loadThreadMessages: () => input.messages,
    loadThreadToolCalls: () => [],
    readConfig: () => ({ providers: [] }),
    readSettings: () => settings
  })
}

test('SeamlessHandoffCoordinator writes one markdown dump and advances rolling summary watermark atomically', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = createThread()
    const messages: MessageRecord[] = [
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
    const requests: ModelStreamRequest[] = []
    const events: ThreadUpdatedEvent[] = []
    const coordinator = createCoordinator({ thread, workspacePath, messages, requests, events })

    const result = await coordinator.handoffAtCheckpoint(thread.id, 'a2', 'step-boundary')

    assert.equal(result.kind, 'completed')
    assert.equal(thread.summaryWatermarkMessageId, 'a2')
    assert.match(thread.rollingSummary ?? '', /### Original message records/)
    assert.match(thread.rollingSummary ?? '', /Continue the active run/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.purpose, 'thread-handoff')
    assert.equal(requests[0]?.tools, undefined)
    assert.equal(events.length, 1)
    assert.equal(events[0]?.thread.summaryWatermarkMessageId, 'a2')

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

test('SeamlessHandoffCoordinator skips checkpoints already covered by the watermark', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'yachiyo-seamless-handoff-'))
  try {
    const thread = { ...createThread(), summaryWatermarkMessageId: 'a2' }
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
