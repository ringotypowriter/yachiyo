import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationRequest
} from '../../runtime/auxiliaryGeneration.ts'
import type { ModelStreamRequest, ModelRuntime } from '../../runtime/types.ts'
import {
  HIDDEN_MEMORY_SEARCH_TOOL_NAME,
  createMemoryService,
  type MemoryCandidate,
  type MemoryProvider
} from './memoryService.ts'

interface AuxiliaryStubOptions {
  text: string
  status?: 'success' | 'failed'
}

function createAuxiliaryGenerationStub(
  options: AuxiliaryStubOptions,
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

const MEMORY_CONFIG: SettingsConfig = {
  providers: [],
  memory: {
    enabled: true,
    provider: 'nowledge-mem',
    baseUrl: 'http://127.0.0.1:14242'
  }
}

function createConfiguredService(input: {
  auxiliaryGeneration: AuxiliaryGenerationService
  provider: MemoryProvider
  runtime?: ModelRuntime
  config?: SettingsConfig
}): ReturnType<typeof createMemoryService> {
  return createMemoryService({
    auxiliaryGeneration: input.auxiliaryGeneration,
    createModelRuntime: () =>
      input.runtime ?? {
        async *streamReply() {
          yield ''
        }
      },
    createProvider: () => input.provider,
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

test('memory service exposes the hidden memory-search capability only when memory is configured', () => {
  const provider: MemoryProvider = {
    async createMemories() {
      return { savedCount: 0 }
    },
    async searchMemories() {
      return []
    },
    async updateMemory() {
      return undefined
    }
  }

  const configured = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    provider
  })

  assert.equal(configured.isConfigured(), true)
  assert.equal(configured.hasHiddenSearchCapability(), true)
  assert.equal(HIDDEN_MEMORY_SEARCH_TOOL_NAME, 'search_memory')

  const disabled = createMemoryService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    createModelRuntime: () => ({
      async *streamReply() {
        yield ''
      }
    }),
    createProvider: () => provider,
    readConfig: () => ({ providers: [] }),
    readSettings: () => ({
      providerName: 'main',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-main',
      baseUrl: ''
    })
  })

  assert.equal(disabled.hasHiddenSearchCapability(), false)
})

test('memory service derives stricter retrieval plans and ranks recalled context', async () => {
  const auxiliaryRequests: AuxiliaryTextGenerationRequest[] = []
  const searchCalls: Array<{ query: string; label?: string }> = []
  const provider: MemoryProvider = {
    async createMemories() {
      return { savedCount: 0 }
    },
    async searchMemories({ query, label }) {
      searchCalls.push({ query, label })

      if (query.includes('deployment')) {
        return [
          {
            id: 'mem-1',
            title: 'Deploy workflow',
            content: 'Always run the staging smoke test before production-adjacent deploy review.',
            score: 0.95
          }
        ]
      }

      return [
        {
          id: 'mem-2',
          title: 'Repo preference',
          content: 'Use the repo root for Yachiyo commands.',
          score: 0.82
        }
      ]
    },
    async updateMemory() {
      return undefined
    }
  }

  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub(
      {
        text: JSON.stringify({
          queries: [
            {
              topic: 'deploy-workflow',
              query: 'deployment checklist and staging validation',
              reason: 'The user is asking about release behavior.',
              weight: 0.9
            },
            {
              topic: 'repo-preference',
              query: 'repo root preference for Yachiyo work',
              reason: 'Workspace conventions may matter.',
              weight: 0.6
            }
          ]
        })
      },
      auxiliaryRequests
    ),
    provider
  })

  const result = await service.recallForContext({
    thread: {
      id: 'thread-1',
      title: 'Deploy thread',
      updatedAt: '2026-03-22T00:00:00.000Z'
    },
    now: '2026-03-22T00:00:00.000Z',
    userQuery: 'How should I handle this deployment?',
    history: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'We are preparing a deploy.',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z'
      }
    ]
  })

  assert.deepEqual(searchCalls, [
    {
      query: 'deployment checklist and staging validation',
      label: undefined
    },
    {
      query: 'repo root preference for Yachiyo work',
      label: undefined
    }
  ])
  assert.match(String(auxiliaryRequests[0]?.messages[0]?.content), /stable canonical topic key/u)
  assert.match(
    String(auxiliaryRequests[0]?.messages[0]?.content),
    /Do not do naive keyword splitting/u
  )
  assert.match(
    String(auxiliaryRequests[0]?.messages[0]?.content),
    /Avoid time words, temporary status, and conversational framing/u
  )
  assert.deepEqual(result.entries, [
    'Deploy workflow: Always run the staging smoke test before production-adjacent deploy review.',
    'Repo preference: Use the repo root for Yachiyo commands.'
  ])
  assert.equal(result.decision.shouldRecall, true)
})

test('memory service skips provider recall when gating says the thread barely changed', async () => {
  const searchCalls: string[] = []
  const provider: MemoryProvider = {
    async createMemories() {
      return { savedCount: 0 }
    },
    async searchMemories({ query }) {
      searchCalls.push(query)
      return []
    },
    async updateMemory() {
      return undefined
    }
  }
  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    provider
  })

  const result = await service.recallForContext({
    thread: {
      id: 'thread-1',
      title: 'Deploy thread',
      updatedAt: '2026-03-22T00:06:00.000Z',
      memoryRecall: {
        lastRunAt: '2026-03-22T00:05:00.000Z',
        lastRecallAt: '2026-03-22T00:05:00.000Z',
        lastRecallMessageCount: 4,
        lastRecallCharCount: 76
      }
    },
    now: '2026-03-22T00:06:00.000Z',
    userQuery: 'ok continue',
    history: [
      {
        id: 'm1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Deploy checklist',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z'
      },
      {
        id: 'm2',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'Smoke test first',
        status: 'completed',
        createdAt: '2026-03-22T00:01:00.000Z'
      },
      {
        id: 'm3',
        threadId: 'thread-1',
        role: 'user',
        content: 'staging first',
        status: 'completed',
        createdAt: '2026-03-22T00:02:00.000Z'
      },
      {
        id: 'm4',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'yes',
        status: 'completed',
        createdAt: '2026-03-22T00:03:00.000Z'
      },
      {
        id: 'm5',
        threadId: 'thread-1',
        role: 'user',
        content: 'ok continue',
        status: 'completed',
        createdAt: '2026-03-22T00:06:00.000Z'
      }
    ]
  })

  assert.deepEqual(searchCalls, [])
  assert.deepEqual(result.entries, [])
  assert.equal(result.decision.shouldRecall, false)
})

test('memory service does not advance lastRecall markers when recall is gated on but no provider is available', async () => {
  const disabled = createMemoryService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    createModelRuntime: () => ({
      async *streamReply() {
        yield ''
      }
    }),
    createProvider: () => {
      throw new Error('should not construct provider while disabled')
    },
    readConfig: () => ({ providers: [] }),
    readSettings: () => ({
      providerName: 'main',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-main',
      baseUrl: ''
    })
  })

  const result = await disabled.recallForContext({
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
    userQuery: '我回来继续排查这个线程',
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
        content: '我回来继续排查这个线程',
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

test('memory service can test Nowledge Mem connectivity and report missing CLI clearly', async () => {
  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    provider: {
      async createMemories() {
        return { savedCount: 0 }
      },
      async searchMemories() {
        const error = new Error('spawn nmem ENOENT') as Error & { code?: string }
        error.code = 'ENOENT'
        throw error
      },
      async updateMemory() {
        return undefined
      }
    }
  })

  const result = await service.testConnection()

  assert.deepEqual(result, {
    ok: false,
    message: 'Nowledge Mem CLI not found. Install `nmem` on this Mac first.'
  })
})

test('memory service can test builtin sqlite memory connectivity without an external base URL', async () => {
  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    provider: {
      async createMemories() {
        return { savedCount: 0 }
      },
      async searchMemories() {
        return []
      },
      async updateMemory() {
        return undefined
      }
    },
    config: {
      providers: [],
      memory: {
        enabled: true,
        provider: 'builtin-memory'
      }
    }
  })

  const result = await service.testConnection()

  assert.deepEqual(result, {
    ok: true,
    message: 'Built-in memory is ready.'
  })
})

test('memory service distills completed runs into canonical topic-aware updates instead of appending duplicates', async () => {
  const auxiliaryRequests: AuxiliaryTextGenerationRequest[] = []
  const created: MemoryCandidate[] = []
  const updated: Array<{ id: string; item: MemoryCandidate }> = []
  const searchCalls: Array<{ query: string; label?: string }> = []
  const provider: MemoryProvider = {
    async createMemories({ items }) {
      created.push(...items)
      return { savedCount: items.length }
    },
    async searchMemories({ query, label }) {
      searchCalls.push({ query, label })

      if (label === 'topic:repo-preference') {
        return [
          {
            id: 'existing-1',
            title: 'Repo preference',
            content: 'Use the Yachiyo repo root for commands.',
            labels: ['topic:repo-preference'],
            importance: 0.55,
            unitType: 'preference'
          }
        ]
      }

      return []
    },
    async updateMemory(input) {
      updated.push(input)
    }
  }

  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub(
      {
        text: JSON.stringify({
          candidates: [
            {
              topic: 'repo-preference',
              title: 'Repo preference',
              content: 'Use the Yachiyo repo root for commands and run work from that root.',
              unitType: 'preference',
              importance: 0.8
            },
            {
              topic: 'repo-preference',
              title: 'Repo root preference',
              content: 'Use the Yachiyo repo root for commands.',
              unitType: 'preference',
              importance: 0.6
            },
            {
              topic: 'testing-workflow',
              title: 'Testing workflow',
              content: 'Run the targeted server tests before shipping memory changes.',
              unitType: 'procedure',
              importance: 0.74
            }
          ]
        })
      },
      auxiliaryRequests
    ),
    provider
  })

  const result = await service.distillCompletedRun({
    thread: {
      id: 'thread-1',
      title: 'Memory run',
      updatedAt: '2026-03-22T00:00:00.000Z'
    },
    userQuery: 'What should we remember?',
    assistantResponse: 'Remember the repo root and the testing flow.'
  })

  assert.equal(result.savedCount, 2)
  assert.deepEqual(searchCalls, [
    {
      query: 'Repo preference',
      label: 'topic:repo-preference'
    },
    {
      query: 'Repo preference Repo Preference',
      label: undefined
    },
    {
      query: 'Repo Preference Use the Yachiyo repo root for commands and run work from that root.',
      label: undefined
    },
    {
      query: 'Testing workflow',
      label: 'topic:testing-workflow'
    },
    {
      query: 'Testing workflow Testing Workflow',
      label: undefined
    },
    {
      query: 'Testing Workflow Run the targeted server tests before shipping memory changes.',
      label: undefined
    }
  ])
  assert.match(
    String(auxiliaryRequests[0]?.messages[0]?.content),
    /stable canonical topic identifier/u
  )
  assert.match(
    String(auxiliaryRequests[0]?.messages[0]?.content),
    /Do not emit multiple near-duplicate candidates/u
  )
  assert.match(
    String(auxiliaryRequests[0]?.messages[0]?.content),
    /When the memory is about the user, prefer "<username> \+ objective description"/u
  )
  assert.match(
    String(auxiliaryRequests[0]?.messages[0]?.content),
    /Good: "<username> prefers concise status updates\."/u
  )
  assert.deepEqual(updated, [
    {
      id: 'existing-1',
      item: {
        topic: 'repo-preference',
        title: 'Repo preference',
        content: 'Use the Yachiyo repo root for commands and run work from that root.',
        importance: 0.8,
        unitType: 'preference'
      },
      signal: undefined
    }
  ])
  assert.deepEqual(created, [
    {
      topic: 'testing-workflow',
      title: 'Testing workflow',
      content: 'Run the targeted server tests before shipping memory changes.',
      importance: 0.74,
      unitType: 'procedure'
    }
  ])
})

test('memory service rejects malformed or weak memory candidates before persistence', async () => {
  const created: MemoryCandidate[] = []
  const updated: Array<{ id: string; item: MemoryCandidate }> = []
  const provider: MemoryProvider = {
    async createMemories({ items }) {
      created.push(...items)
      return { savedCount: items.length }
    },
    async searchMemories() {
      return []
    },
    async updateMemory(input) {
      updated.push(input)
    }
  }

  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({
      text: JSON.stringify({
        candidates: [
          {
            topic: 'repo-preference',
            title: 'Repo preference.',
            content: 'Use the Yachiyo repo root for commands.',
            unitType: 'preference',
            importance: 0.8
          },
          {
            topic: 'chat-summary',
            title: 'We discussed the deploy',
            content: 'We discussed what to do this time.',
            unitType: 'fact',
            importance: 0.4
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
    }),
    provider
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

  assert.equal(result.savedCount, 1)
  assert.deepEqual(updated, [])
  assert.deepEqual(created, [
    {
      topic: 'repo-preference',
      title: 'Repo preference',
      content: 'Use the Yachiyo repo root for commands.',
      importance: 0.8,
      unitType: 'preference'
    }
  ])
})

test('memory service keeps durable candidates that legitimately mention thread or chat', async () => {
  const created: MemoryCandidate[] = []
  const provider: MemoryProvider = {
    async createMemories({ items }) {
      created.push(...items)
      return { savedCount: items.length }
    },
    async searchMemories() {
      return []
    },
    async updateMemory() {
      return undefined
    }
  }

  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({
      text: JSON.stringify({
        candidates: [
          {
            topic: 'release-coordination',
            title: 'Release coordination',
            content: 'Use a Slack thread for release coordination and status handoff.',
            unitType: 'procedure',
            importance: 0.72
          },
          {
            topic: 'chat-model-selection',
            title: 'Chat model selection',
            content: 'The chat model is gpt-5 for the main assistant run path.',
            unitType: 'fact',
            importance: 0.68
          }
        ]
      })
    }),
    provider
  })

  const result = await service.distillCompletedRun({
    thread: {
      id: 'thread-1',
      title: 'Memory run',
      updatedAt: '2026-03-22T00:00:00.000Z'
    },
    userQuery: 'What should we remember?',
    assistantResponse: 'Remember the release coordination and model choice.'
  })

  assert.equal(result.savedCount, 2)
  assert.deepEqual(created, [
    {
      topic: 'release-coordination',
      title: 'Release coordination',
      content: 'Use a Slack thread for release coordination and status handoff.',
      importance: 0.72,
      unitType: 'procedure'
    },
    {
      topic: 'chat-model-selection',
      title: 'Chat model selection',
      content: 'The chat model is gpt-5 for the main assistant run path.',
      importance: 0.68,
      unitType: 'fact'
    }
  ])
})

test('memory service uses the main model for explicit Save Thread extraction with the stricter schema', async () => {
  const requests: ModelStreamRequest[] = []
  const saved: MemoryCandidate[] = []
  const provider: MemoryProvider = {
    async createMemories({ items }) {
      saved.push(...items)
      return { savedCount: items.length }
    },
    async searchMemories() {
      return []
    },
    async updateMemory() {
      return undefined
    }
  }
  const runtime: ModelRuntime = {
    async *streamReply(request) {
      requests.push(request)
      yield JSON.stringify({
        candidates: [
          {
            topic: 'code-review-policy',
            title: 'Code review policy',
            content: 'Present findings first, then summaries.',
            unitType: 'procedure',
            importance: 0.9
          }
        ]
      })
    }
  }

  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({ text: '{"queries":[]}' }),
    provider,
    runtime
  })

  const result = await service.saveThread({
    thread: {
      id: 'thread-1',
      title: 'Saved thread',
      updatedAt: '2026-03-22T00:00:00.000Z'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Review this patch.',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z'
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'Lead with concrete findings.',
        status: 'completed',
        createdAt: '2026-03-22T00:00:05.000Z'
      }
    ]
  })

  assert.equal(result.savedCount, 1)
  assert.equal(requests[0]?.providerOptionsMode, undefined)
  assert.equal(requests[0]?.settings.model, 'gpt-5')
  assert.match(String(requests[0]?.messages[0]?.content), /stable canonical topics/u)
  assert.match(String(requests[0]?.messages[0]?.content), /Do not write conversational summaries/u)
  assert.deepEqual(saved, [
    {
      topic: 'code-review-policy',
      title: 'Code review policy',
      content: 'Present findings first, then summaries.',
      importance: 0.9,
      unitType: 'procedure'
    }
  ])
})

test('memory service lets the query model skip recall for general questions unrelated to memory', async () => {
  const searchCalls: string[] = []
  const provider: MemoryProvider = {
    async createMemories() {
      return { savedCount: 0 }
    },
    async searchMemories({ query }) {
      searchCalls.push(query)
      return []
    },
    async updateMemory() {
      return undefined
    }
  }
  const service = createConfiguredService({
    auxiliaryGeneration: createAuxiliaryGenerationStub({
      text: JSON.stringify({
        skip: true,
        skipReason:
          'The user is asking a general factual question with no relation to durable memories.'
      })
    }),
    provider
  })

  const result = await service.recallForContext({
    thread: {
      id: 'thread-1',
      title: 'General question',
      updatedAt: '2026-03-22T00:00:00.000Z',
      memoryRecall: {
        lastRunAt: '2026-03-21T00:00:00.000Z',
        lastRecallAt: '2026-03-21T00:00:00.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 40
      }
    },
    now: '2026-03-22T00:00:00.000Z',
    userQuery: 'What is the capital of France?',
    history: [
      {
        id: 'm1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Hello',
        status: 'completed',
        createdAt: '2026-03-21T00:00:00.000Z'
      },
      {
        id: 'm2',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'Hi there',
        status: 'completed',
        createdAt: '2026-03-21T00:00:01.000Z'
      },
      {
        id: 'm3',
        threadId: 'thread-1',
        role: 'user',
        content: 'What is the capital of France?',
        status: 'completed',
        createdAt: '2026-03-22T00:00:00.000Z'
      }
    ]
  })

  assert.deepEqual(searchCalls, [])
  assert.deepEqual(result.entries, [])
  assert.equal(result.decision.shouldRecall, true)
  assert.equal(result.decision.modelSkipped, true)
  assert.equal(
    result.decision.modelSkipReason,
    'The user is asking a general factual question with no relation to durable memories.'
  )
  assert.equal(result.thread.memoryRecall?.lastRunAt, '2026-03-22T00:00:00.000Z')
  assert.equal(result.thread.memoryRecall?.lastRecallAt, '2026-03-21T00:00:00.000Z')
  assert.equal(result.thread.memoryRecall?.lastRecallMessageCount, 2)
  assert.equal(result.thread.memoryRecall?.lastRecallCharCount, 40)
})
