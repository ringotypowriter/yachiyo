import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
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
          candidates: [
            {
              topic: 'repo-preference',
              title: 'Repo preference',
              content: 'Use the Yachiyo repo root for commands.',
              unitType: 'preference',
              importance: 0.8
            },
            {
              topic: 'weak-memory',
              title: 'Weak memory',
              content: 'Maybe.',
              unitType: 'fact',
              importance: 0.2
            }
          ]
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
  assert.equal(result.savedCount, 2)
  assert.equal(auxiliaryRequests[0]?.purpose, 'memory-distill')
  assert.equal(state.rows.length, 1)
  assert.equal(state.rows[0]?.relation, 'user_preferences')
  assert.match(state.rows[0]?.values['content'] ?? '', /Yachiyo repo root/)
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
          operations: [
            {
              type: 'upsertRelation',
              relation: 'agent_workflow_roles',
              purpose: 'Track agent handoff rules.',
              columns: ['agent', 'role'],
              evidence: []
            },
            {
              type: 'upsertRow',
              relation: 'agent_workflow_roles',
              key: 'codex',
              values: { agent: 'Codex', role: 'Explorer' },
              subjects: ['Codex'],
              triggers: ['context artifact'],
              confidence: 0.9,
              evidence: []
            }
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
  assert.equal(saved.savedCount, 2)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.providerOptionsMode, undefined)
  assert.equal(requests[0]?.settings.model, 'gpt-5')
  assert.equal(state.relations[0]?.name, 'agent_workflow_roles')
  assert.equal(state.rows[0]?.key, 'codex')
  assert.equal(state.rows[0]?.evidence[0]?.messageId, 'msg-1')
})
