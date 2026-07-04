import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ThreadRecord } from '@yachiyo/shared/protocol'
import {
  buildNextRecallState,
  detectNoveltySignal,
  filterRecalledMemories,
  shouldRecallBeforeRun,
  whenRecallSegmenterReady
} from './recallPolicy.ts'

// CJK novelty detection depends on the lazily-loaded jieba segmenter.
await whenRecallSegmenterReady()

function createMessage(input: {
  id: string
  createdAt: string
  content: string
  role?: MessageRecord['role']
}): MessageRecord {
  return {
    id: input.id,
    threadId: 'thread-1',
    role: input.role ?? 'user',
    content: input.content,
    status: 'completed',
    createdAt: input.createdAt
  }
}

function createThread(overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-03-23T00:00:00.000Z',
    ...overrides
  }
}

test('shouldRecallBeforeRun recalls for three segmented Chinese new-topic terms', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'user-1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '帮我分析向量索引、召回策略和用户画像'
      })
    ],
    now: '2026-03-23T00:00:00.000Z',
    thread: createThread(),
    userQuery: '帮我分析向量索引、召回策略和用户画像'
  })

  assert.equal(decision.shouldRecall, true)
  assert.deepEqual(decision.reasons, ['topic-novelty'])
  assert.deepEqual(decision.novelTerms.slice(0, 3), ['向量索引', '召回策略', '用户画像'])
})

test('detectNoveltySignal boosts emphasized, syntax-heavy, and acronym terms', () => {
  const novelty = detectNoveltySignal({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们刚刚在聊数据库迁移'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '继续看数据库就好',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T00:02:00.000Z',
        content: '另外，帮我看一下 `toolTimeout`、"Sonnet-4.6" 和 [agent] 这几个点'
      })
    ],
    userQuery: '另外，帮我看一下 `toolTimeout`、"Sonnet-4.6" 和 [agent] 这几个点'
  })

  assert.equal(novelty.noveltyScore >= 0.85, true)
  assert.equal(novelty.novelTerms.includes('tooltimeout'), true)
  assert.equal(novelty.novelTerms.includes('sonnet-4.6'), true)
  assert.equal(novelty.novelTerms.includes('agent'), true)
})

test('detectNoveltySignal segments Chinese terms and ranks them ahead of loose words', () => {
  const novelty = detectNoveltySignal({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们刚刚在聊数据库迁移'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '继续看数据库就好',
        role: 'assistant'
      })
    ],
    userQuery: '现在改看向量索引召回策略和用户画像同步'
  })

  assert.equal(novelty.noveltyScore >= 0.7, true)
  assert.deepEqual(novelty.novelTerms.slice(0, 3), ['向量索引', '召回策略', '用户画像'])
})

test('detectNoveltySignal treats repeated recent Chinese terms as known context', () => {
  const novelty = detectNoveltySignal({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们刚刚在聊向量索引和数据库迁移'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '向量索引先保持原方案',
        role: 'assistant'
      })
    ],
    userQuery: '向量索引先不动，新的召回策略要看用户画像同步'
  })

  assert.equal(novelty.novelTerms.includes('向量索引'), false)
  assert.equal(novelty.novelTerms.includes('召回策略'), true)
  assert.equal(novelty.novelTerms.includes('用户画像'), true)
})

test('detectNoveltySignal suppresses Chinese noun-adverb filler pairs', () => {
  const novelty = detectNoveltySignal({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们刚刚在聊 recall policy'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '仓库其实'
      })
    ],
    userQuery: '仓库其实'
  })

  assert.deepEqual(novelty.novelTerms, [])
})

test('shouldRecallBeforeRun requires three terms for unmarked pure Chinese novelty', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们刚刚在聊数据库迁移'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '继续看数据库就好',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T00:02:00.000Z',
        content: '现在改看用户画像'
      })
    ],
    now: '2026-03-23T00:02:00.000Z',
    thread: createThread(),
    userQuery: '现在改看用户画像'
  })

  assert.deepEqual(decision.novelTerms, ['用户画像'])
  assert.equal(decision.shouldRecall, false)
  assert.deepEqual(decision.reasons, [])
})

test('shouldRecallBeforeRun requires three terms even when one strong new topic appears', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们刚刚在聊数据库迁移'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '继续看数据库就好',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T00:02:00.000Z',
        content: '另外，帮我看 MCP 的行为'
      })
    ],
    now: '2026-03-23T00:02:00.000Z',
    thread: createThread({
      memoryRecall: {
        lastRunAt: '2026-03-23T00:01:30.000Z',
        lastRecallAt: '2026-03-23T00:01:30.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 48
      }
    }),
    userQuery: '另外，帮我看 MCP 的行为'
  })

  assert.equal(decision.noveltyScore >= 0.7, true)
  assert.deepEqual(decision.novelTerms, ['mcp'])
  assert.equal(decision.shouldRecall, false)
  assert.deepEqual(decision.reasons, [])
})

test('shouldRecallBeforeRun requires three terms for supplied novelty signals', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '我们一直在聊部署节奏'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '继续',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T00:02:00.000Z',
        content: '新的问题来了'
      })
    ],
    now: '2026-03-23T00:02:00.000Z',
    thread: createThread({
      memoryRecall: {
        lastRunAt: '2026-03-23T00:01:30.000Z',
        lastRecallAt: '2026-03-23T00:01:30.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 24
      }
    }),
    userQuery: '新的问题来了',
    novelty: {
      noveltyScore: 0.9,
      novelTerms: ['vector index']
    }
  })

  assert.equal(decision.shouldRecall, false)
  assert.deepEqual(decision.reasons, [])

  const enoughTerms = shouldRecallBeforeRun({
    history: [],
    now: '2026-03-23T00:02:00.000Z',
    thread: createThread(),
    userQuery: '新的问题来了',
    novelty: {
      noveltyScore: 0.9,
      novelTerms: ['vector index', 'tooltimeout', 'mcp']
    }
  })

  assert.equal(enoughTerms.shouldRecall, true)
  assert.deepEqual(enoughTerms.reasons, ['topic-novelty'])
})

test('detectNoveltySignal suppresses unmarked pure Chinese filler', () => {
  const novelty = detectNoveltySignal({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '用户刚才在问系统提示词'
      })
    ],
    userQuery: '我觉得这个修改方案可能还要再看一下'
  })

  assert.equal(novelty.noveltyScore < 0.3, true)
  assert.deepEqual(novelty.novelTerms, [])
})

test('detectNoveltySignal suppresses unmarked English filler', () => {
  const novelty = detectNoveltySignal({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: 'We were discussing the system prompt.'
      })
    ],
    userQuery: 'I think this change maybe should be looked at again'
  })

  assert.equal(novelty.noveltyScore < 0.3, true)
  assert.deepEqual(novelty.novelTerms, [])
})

test('filterRecalledMemories suppresses recently injected memories but allows them back after enough distance', () => {
  const thread = createThread({
    memoryRecall: {
      recentInjections: [
        {
          memoryId: 'mem-1',
          fingerprint: 'mem 1 deploy workflow',
          injectedAt: '2026-03-23T00:02:00.000Z',
          messageCount: 3,
          charCount: 24,
          score: 0.91
        }
      ]
    }
  })
  const closeHistory = [
    createMessage({ id: 'm1', createdAt: '2026-03-23T00:00:00.000Z', content: 'deploy workflow' }),
    createMessage({
      id: 'm2',
      createdAt: '2026-03-23T00:01:00.000Z',
      content: 'ok',
      role: 'assistant'
    }),
    createMessage({ id: 'm3', createdAt: '2026-03-23T00:02:00.000Z', content: '继续部署' }),
    createMessage({ id: 'm4', createdAt: '2026-03-23T00:03:00.000Z', content: '继续这个问题' })
  ]

  const suppressed = filterRecalledMemories({
    candidates: [{ id: 'mem-1', entry: 'Deploy workflow: run smoke test first.', score: 0.95 }],
    history: closeHistory,
    now: '2026-03-23T00:03:00.000Z',
    thread,
    userQuery: '继续这个问题'
  })
  assert.deepEqual(suppressed.entries, [])

  const distantHistory = [
    ...closeHistory,
    createMessage({
      id: 'm5',
      createdAt: '2026-03-23T00:04:00.000Z',
      content: '再补充 rollout plan',
      role: 'assistant'
    }),
    createMessage({
      id: 'm6',
      createdAt: '2026-03-23T00:05:00.000Z',
      content: '现在重新看 deploy workflow'
    }),
    createMessage({
      id: 'm7',
      createdAt: '2026-03-23T00:06:00.000Z',
      content: '要不要重新提醒 smoke test'
    }),
    createMessage({
      id: 'm8',
      createdAt: '2026-03-23T00:07:00.000Z',
      content: '这次已经是另一个阶段了',
      role: 'assistant'
    }),
    createMessage({
      id: 'm9',
      createdAt: '2026-03-23T00:08:00.000Z',
      content: '请再把 deploy workflow 记忆提出来'
    })
  ]
  const allowed = filterRecalledMemories({
    candidates: [{ id: 'mem-1', entry: 'Deploy workflow: run smoke test first.', score: 0.95 }],
    history: distantHistory,
    now: '2026-03-23T00:08:00.000Z',
    thread,
    userQuery: '现在重新看 deploy workflow'
  })

  assert.deepEqual(allowed.entries, ['Deploy workflow: run smoke test first.'])
})

test('buildNextRecallState updates lastRunAt even when recall is skipped', () => {
  const nextState = buildNextRecallState({
    decision: {
      shouldRecall: false,
      score: 0,
      reasons: [],
      messagesSinceLastRecall: 1,
      charsSinceLastRecall: 10,
      idleMs: 0,
      noveltyScore: 0.1,
      novelTerms: []
    },
    history: [createMessage({ id: 'm1', createdAt: '2026-03-23T00:00:00.000Z', content: '继续' })],
    now: '2026-03-23T00:00:00.000Z',
    thread: createThread({
      memoryRecall: {
        lastRunAt: '2026-03-22T23:00:00.000Z',
        lastRecallAt: '2026-03-22T22:00:00.000Z',
        lastRecallMessageCount: 3,
        lastRecallCharCount: 42
      }
    })
  })

  assert.equal(nextState.lastRunAt, '2026-03-23T00:00:00.000Z')
  assert.equal(nextState.lastRecallAt, '2026-03-22T22:00:00.000Z')
})
