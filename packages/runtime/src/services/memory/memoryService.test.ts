import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '@yachiyo/shared/protocol'
import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationRequest
} from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelStreamRequest, ModelRuntime } from '../../runtime/models/types.ts'
import { createInMemoryCognitiveMemoryStore } from './cognitiveMemoryStore.ts'
import { createMemoryService, sanitizeMemoryQueryText } from './memoryService.ts'

const MEMORY_CONFIG: SettingsConfig = {
  providers: [],
  memory: { enabled: true }
}

test('notes preserve text and source anchors, revise by id, and delete without rewriting history', async () => {
  const store = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({ cognitiveStore: store })
  const note = 'We discussed logs.\n  Keep the original wording.'
  const created = await service.validateAndCreateMemory({ note }, undefined, {
    threadId: 'source',
    messageId: 'm1',
    toolCallId: 'call-1'
  })
  assert.equal(created.savedCount, 1)
  assert.ok(created.id)
  const row = (await store.readState()).rows[0]!
  assert.equal(row.values.note, note)
  assert.equal(row.evidence[0]?.messageId, 'm1')
  const revised = await service.validateAndCreateMemory({
    id: created.id,
    note: 'Only applies to logs.',
    sources: ['thread_message:later:m2']
  })
  assert.equal(revised.id, created.id)
  assert.equal((await store.readState()).rows.length, 1)
  const results = await service.searchMemories({ query: 'logs' })
  assert.equal(results[0]?.content, 'Only applies to logs.')
  assert.deepEqual(results[0]?.sourceMessageRowIds, [
    'thread_message:source:m1',
    'thread_message:later:m2'
  ])
  const deleted = await service.validateAndCreateMemory({ id: created.id, action: 'delete' })
  assert.equal(deleted.deleted, true)
  assert.equal((await service.searchMemories({ query: 'logs' })).length, 0)
  const missing = await service.validateAndCreateMemory({
    id: created.id,
    note: 'Do not recreate missing notes.'
  })
  assert.ok(missing.rejected)
})

test('revising a legacy memory replaces obsolete fields and activation terms', async () => {
  const store = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({ cognitiveStore: store })
  await service.validateAndCreateMemory({
    key: 'legacy',
    facts: { outdated: 'wrong claim' },
    subjects: ['obsoleteword']
  })
  const id = (await store.readState()).rows[0]!.id
  await service.validateAndCreateMemory({ id, note: 'Corrected understanding.' })
  const row = (await store.readState()).rows[0]!
  assert.deepEqual(row.values, { note: 'Corrected understanding.' })
  assert.deepEqual(row.subjects, [])
  assert.equal((await service.searchMemories({ query: 'obsoleteword' })).length, 0)
})

test('automatic notes use selected original sources, reject invented anchors, and deduplicate repeated extraction', async () => {
  const store = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({
    cognitiveStore: store,
    runtime: {
      async *streamReply() {
        yield JSON.stringify({
          notes: [
            { note: 'We chose original logs for auditability.', sources: ['thread_message:t:m2'] },
            { note: 'Invented evidence', sources: ['thread_message:t:missing'] }
          ]
        })
      }
    }
  })
  const input = {
    thread: { id: 't', title: 'Logs', updatedAt: '2026-09-05T00:00:00Z' },
    messages: [
      {
        id: 'm1',
        threadId: 't',
        role: 'user' as const,
        content: 'Consider logs.',
        status: 'completed' as const,
        createdAt: '2026-09-05T00:00:00Z'
      },
      {
        id: 'm2',
        threadId: 't',
        role: 'user' as const,
        content: 'Choose original logs for auditability.',
        status: 'completed' as const,
        createdAt: '2026-09-05T00:01:00Z'
      }
    ]
  }
  assert.equal((await service.saveThread(input)).savedCount, 1)
  assert.equal((await service.saveThread(input)).savedCount, 0)
  const rows = (await store.readState()).rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.evidence[0]?.messageId, 'm2')
})

test('recall finds note text without keywords, groups shared sources and skips visible originals', async () => {
  const store = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({ cognitiveStore: store })
  await service.validateAndCreateMemory(
    { note: 'We discussed original logs for auditability.' },
    undefined,
    { threadId: 't', messageId: 'm1' }
  )
  await service.validateAndCreateMemory(
    { note: 'Original logs retain the surrounding dialogue.' },
    undefined,
    { threadId: 't', messageId: 'm1' }
  )
  const input = {
    thread: { id: 't', title: 'Logs', updatedAt: '2026-09-05T00:00:00Z' },
    now: '2026-09-05T00:00:00Z',
    userQuery: 'original logs',
    history: []
  }
  const recalled = await service.recallForContext(input)
  assert.equal(recalled.entries.length, 1)
  assert.ok(recalled.entries[0]?.includes('thread_message:t:m1'))
  const visible = await service.recallForContext({
    ...input,
    history: [
      {
        id: 'm1',
        threadId: 't',
        role: 'user',
        content: 'We discussed original logs for auditability.',
        status: 'completed',
        createdAt: input.now
      }
    ]
  })
  assert.equal(visible.entries.length, 0)
  const compressed = await service.recallForContext({
    ...input,
    thread: { ...input.thread, contextHandoffWatermarkMessageId: 'm1' },
    history: [
      {
        id: 'm1',
        threadId: 't',
        role: 'user',
        content: 'We discussed original logs.',
        status: 'completed',
        createdAt: input.now
      }
    ]
  })
  assert.equal(compressed.entries.length, 1)
})

test('legacy facts containing a note field retain all fields in search results', async () => {
  const service = createConfiguredService({})
  await service.validateAndCreateMemory({
    key: 'db',
    facts: { note: 'caveat', decision: 'PostgreSQL', rationale: 'transactions' },
    subjects: ['database']
  })
  const results = await service.searchMemories({ query: 'database' })
  assert.match(results[0]?.content ?? '', /PostgreSQL/)
  assert.match(results[0]?.content ?? '', /transactions/)
})

test('source-linked notes remain discoverable after a month and support Chinese prose queries', async () => {
  const store = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({ cognitiveStore: store })
  await service.validateAndCreateMemory(
    { note: '我们讨论过原始对话的保存方式，笔记只用来定位来源。' },
    undefined,
    { threadId: 't', messageId: 'm' }
  )
  const savedAt = (await store.readState()).rows[0]!.updatedAt
  await store.applyPatch(
    { operations: [] },
    { now: new Date(Date.parse(savedAt) + 40 * 86400000).toISOString() }
  )
  assert.equal((await store.readState()).rows[0]?.status, 'active')
  const found = await service.searchMemories({ query: '之前讨论的对话保存方式是什么' })
  assert.equal(found.length, 1)
})

function createAuxiliaryGenerationStub(
  options: { text: string; status?: 'success' | 'failed' },
  requests: AuxiliaryTextGenerationRequest[] = []
): AuxiliaryGenerationService {
  return {
    async generateText(request) {
      requests.push(request)

      if (options.status === 'failed') {
        return {
          status: 'failed',
          error: 'auxiliary failed',
          settings: {
            providerName: 'tool',
            provider: 'openai',
            model: 'gpt-5-mini',
            apiKey: 'sk-tool',
            baseUrl: ''
          }
        }
      }

      return {
        status: 'success',
        settings: {
          providerName: 'tool',
          provider: 'openai',
          model: 'gpt-5-mini',
          apiKey: 'sk-tool',
          baseUrl: ''
        },
        text: options.text
      }
    }
  }
}

function createConfiguredService(input: {
  auxiliaryGeneration?: AuxiliaryGenerationService
  runtime?: ModelRuntime
  config?: SettingsConfig
  cognitiveStore?: ReturnType<typeof createInMemoryCognitiveMemoryStore>
}): ReturnType<typeof createMemoryService> {
  return createMemoryService({
    auxiliaryGeneration:
      input.auxiliaryGeneration ?? createAuxiliaryGenerationStub({ text: '{"operations":[]}' }),
    cognitiveStore: input.cognitiveStore ?? createInMemoryCognitiveMemoryStore(),
    createModelRuntime: () =>
      input.runtime ?? {
        async *streamReply() {
          yield ''
        }
      },
    readConfig: () => input.config ?? MEMORY_CONFIG,
    readSettings: () => ({
      providerName: 'main',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-main',
      baseUrl: ''
    })
  })
}

test('sanitizeMemoryQueryText strips embedded document blocks', () => {
  const big = 'x'.repeat(50_000)
  const raw = [
    'Please review this file',
    '<file_mentions>',
    '- @EVIDENCE_INVENTORY.md -> /abs/EVIDENCE_INVENTORY.md',
    '</file_mentions>',
    '<referenced_file path="/abs/EVIDENCE_INVENTORY.md">',
    big,
    '</referenced_file>'
  ].join('\n')

  const cleaned = sanitizeMemoryQueryText(raw)
  assert.equal(cleaned, 'Please review this file')
  assert.ok(!cleaned.includes('x'.repeat(100)))
})

test('sanitizeMemoryQueryText truncates very long plain text', () => {
  const raw = 'a'.repeat(10_000)
  const cleaned = sanitizeMemoryQueryText(raw)
  assert.equal(cleaned.length, 2000)
})

test('sanitizeMemoryQueryText strips attached_files and referenced_jotdown blocks', () => {
  const raw = [
    'Hi',
    '<attached_files>',
    'huge attachment body',
    '</attached_files>',
    '<referenced_jotdown path="JotDown">',
    'jot contents',
    '</referenced_jotdown>',
    'thanks'
  ].join('\n')
  assert.equal(sanitizeMemoryQueryText(raw), 'Hi thanks')
})

test('memory service exposes source query memory capability only when memory is configured', () => {
  const configured = createConfiguredService({})
  assert.equal(configured.isConfigured(), true)
  assert.equal(configured.hasHiddenSearchCapability(), true)

  const disabled = createConfiguredService({
    config: { providers: [], memory: { enabled: false } }
  })
  assert.equal(disabled.hasHiddenSearchCapability(), false)
})

test('memory service searches the cognitive store directly', async () => {
  const cognitiveStore = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({ cognitiveStore })

  await service.validateAndCreateMemory({
    key: 'repo_preference',
    facts: { root: 'Use the repository root for Yachiyo commands.' },
    subjects: ['repo root', 'Yachiyo commands'],
    unitType: 'preference',
    importance: 0.8
  })

  const results = await service.searchMemories({
    query: 'Yachiyo commands',
    topic: 'user_preferences'
  })
  assert.equal(results.length, 1)
  assert.equal(results[0]?.title, 'repo_preference')
  assert.match(results[0]?.content ?? '', /repository root/)
})

test('memory service uses cognitive activation without model query planning', async () => {
  const auxiliaryRequests: AuxiliaryTextGenerationRequest[] = []
  const cognitiveStore = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub(
      { text: '{"operations":[]}' },
      auxiliaryRequests
    ),
    cognitiveStore
  })

  await service.validateAndCreateMemory({
    key: 'agent_workflow_roles',
    facts: { role: 'Codex produces dense context artifacts before implementation handoff.' },
    subjects: ['Codex', 'context artifact', 'explorer role'],
    unitType: 'procedure',
    importance: 0.9
  })

  const result = await service.recallForContext({
    thread: {
      id: 'thread-1',
      title: 'Agent workflow',
      updatedAt: '2026-05-19T00:00:00.000Z'
    },
    now: '2026-05-19T00:00:00.000Z',
    userQuery: 'Codex 和 context artifact 的分工是什么？',
    history: []
  })

  assert.equal(auxiliaryRequests.length, 0)
  assert.deepEqual(result.decision.reasons, ['cognitive-activation'])
  assert.equal(result.entries.length, 1)
  assert.match(result.entries[0] ?? '', /Codex produces dense context artifacts/)
})

test('memory service includes source row ids in recalled entries from saved thread evidence', async () => {
  const cognitiveStore = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({
    cognitiveStore,
    runtime: {
      async *streamReply() {
        yield JSON.stringify({
          notes: [
            {
              note: 'Recall entries should expose their source conversation. Memory source bridge.',
              sources: ['thread_message:thread-source:msg-1', 'thread_message:thread-source:msg-2']
            }
          ]
        })
      }
    }
  })

  await service.saveThread({
    thread: {
      id: 'thread-source',
      title: 'Memory source bridge',
      updatedAt: '2026-05-19T00:00:00.000Z'
    },
    messages: [
      {
        id: 'msg-1',
        threadId: 'thread-source',
        role: 'user',
        content: 'Memory recall needs source conversation references.',
        status: 'completed',
        createdAt: '2026-05-19T00:00:00.000Z'
      },
      {
        id: 'msg-2',
        threadId: 'thread-source',
        role: 'assistant',
        content: 'Expose querySource row ids in the recalled memory entry.',
        status: 'completed',
        createdAt: '2026-05-19T00:01:00.000Z'
      }
    ]
  })

  const result = await service.recallForContext({
    thread: {
      id: 'thread-current',
      title: 'Current chat',
      updatedAt: '2026-05-19T00:02:00.000Z'
    },
    now: '2026-05-19T00:02:00.000Z',
    userQuery: 'memory source bridge 的来源是什么？',
    history: []
  })

  assert.equal(result.entries.length, 1)
  assert.match(result.entries[0] ?? '', /thread_message:thread-source:msg-2/)
  assert.match(result.entries[0] ?? '', /thread_message:thread-source:msg-1/)
})

test('memory service does not advance lastRecall markers when cognitive activation misses', async () => {
  const service = createConfiguredService({})

  const result = await service.recallForContext({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: '2026-03-23T09:00:00.000Z',
      memoryRecall: {
        lastRunAt: '2026-03-22T00:30:00.000Z',
        lastRecallAt: '2026-03-22T00:30:00.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 20
      }
    },
    now: '2026-03-23T09:00:00.000Z',
    userQuery: '现在排查向量索引、召回策略和用户画像',
    history: [
      {
        id: 'm1',
        threadId: 'thread-1',
        role: 'user',
        content: '前一天我们聊过 CI 故障',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z'
      },
      {
        id: 'm2',
        threadId: 'thread-1',
        role: 'assistant',
        content: '嗯，继续吧',
        status: 'completed',
        createdAt: '2026-03-22T00:01:00.000Z'
      },
      {
        id: 'm3',
        threadId: 'thread-1',
        role: 'user',
        content: '现在排查向量索引、召回策略和用户画像',
        status: 'completed',
        createdAt: '2026-03-23T09:00:00.000Z'
      }
    ]
  })

  assert.equal(result.decision.shouldRecall, true)
  assert.equal(result.thread.memoryRecall?.lastRunAt, '2026-03-23T09:00:00.000Z')
  assert.equal(result.thread.memoryRecall?.lastRecallAt, '2026-03-22T00:30:00.000Z')
  assert.equal(result.thread.memoryRecall?.lastRecallMessageCount, 2)
  assert.equal(result.thread.memoryRecall?.lastRecallCharCount, 20)
})

test('memory service distills completed runs into cognitive patches', async () => {
  const auxiliaryRequests: AuxiliaryTextGenerationRequest[] = []
  const cognitiveStore = createInMemoryCognitiveMemoryStore()
  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub(
      {
        text: JSON.stringify({
          notes: [{ note: 'Use the Yachiyo repo root for commands.', sources: ['thread:thread-1'] }]
        })
      },
      auxiliaryRequests
    ),
    cognitiveStore
  })

  const result = await service.distillCompletedRun({
    thread: {
      id: 'thread-1',
      title: 'Memory run',
      updatedAt: '2026-03-22T00:00:00.000Z'
    },
    userQuery: 'What should we remember?',
    assistantResponse: 'Remember the repo root.'
  })

  const state = await cognitiveStore.readState()
  assert.equal(result.savedCount, 1)
  assert.equal(auxiliaryRequests[0]?.purpose, 'memory-distill')
  assert.equal(state.rows.length, 1)
  assert.equal(state.rows[0]?.relation, 'notes')
  assert.match(state.rows[0]?.values['note'] ?? '', /Yachiyo repo root/)
})

test('memory service saves thread transcripts as cognitive patches', async () => {
  const cognitiveStore = createInMemoryCognitiveMemoryStore()
  const requests: ModelStreamRequest[] = []
  const service = createConfiguredService({
    cognitiveStore,
    runtime: {
      async *streamReply(request) {
        requests.push(request)
        yield JSON.stringify({
          notes: [
            { note: 'Codex creates context artifacts.', sources: ['thread_message:thread-1:msg-1'] }
          ]
        })
      }
    }
  })

  const saved = await service.saveThread({
    thread: {
      id: 'thread-1',
      title: 'Agent workflow',
      updatedAt: '2026-05-19T00:00:00.000Z'
    },
    messages: [
      {
        id: 'msg-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Codex should create context artifacts.',
        status: 'completed',
        createdAt: '2026-05-19T00:00:00.000Z'
      }
    ]
  })

  const state = await cognitiveStore.readState()
  assert.equal(saved.savedCount, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.providerOptionsMode, undefined)
  assert.equal(requests[0]?.processingTier, undefined)
  assert.equal(requests[0]?.settings.model, 'gpt-5')
  assert.equal(state.relations[0]?.name, 'notes')
  assert.equal(state.rows[0]?.values.note, 'Codex creates context artifacts.')
  assert.equal(state.rows[0]?.evidence[0]?.messageId, 'msg-1')
})
