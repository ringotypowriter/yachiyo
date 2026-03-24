import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ThreadRecord } from '../../../../shared/yachiyo/protocol.ts'
import {
  buildNextRecallState,
  detectNoveltySignal,
  filterRecalledMemories,
  shouldRecallBeforeRun
} from './recallPolicy.ts'

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

test('shouldRecallBeforeRun always recalls on a new thread cold start', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'user-1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '帮我看一下部署流程'
      })
    ],
    now: '2026-03-23T00:00:00.000Z',
    thread: createThread(),
    userQuery: '帮我看一下部署流程'
  })

  assert.equal(decision.shouldRecall, true)
  assert.deepEqual(decision.reasons, ['thread-cold-start'])
})

test('shouldRecallBeforeRun stays quiet for small local growth after a recent recall', () => {
  const thread = createThread({
    memoryRecall: {
      lastRunAt: '2026-03-23T00:05:00.000Z',
      lastRecallAt: '2026-03-23T00:05:00.000Z',
      lastRecallMessageCount: 4,
      lastRecallCharCount: 120
    }
  })
  const history = [
    createMessage({
      id: 'm1',
      createdAt: '2026-03-23T00:00:00.000Z',
      content: '部署前要跑 smoke test'
    }),
    createMessage({
      id: 'm2',
      createdAt: '2026-03-23T00:01:00.000Z',
      content: '好，我记住了',
      role: 'assistant'
    }),
    createMessage({
      id: 'm3',
      createdAt: '2026-03-23T00:04:00.000Z',
      content: '还有 staging checklist 吗'
    }),
    createMessage({
      id: 'm4',
      createdAt: '2026-03-23T00:05:00.000Z',
      content: '有，不过很短',
      role: 'assistant'
    }),
    createMessage({
      id: 'm5',
      createdAt: '2026-03-23T00:06:00.000Z',
      content: '部署前的 smoke test 呢'
    })
  ]

  const decision = shouldRecallBeforeRun({
    history,
    now: '2026-03-23T00:06:00.000Z',
    thread,
    userQuery: '部署前的 smoke test 呢'
  })

  assert.equal(decision.shouldRecall, false)
  assert.deepEqual(decision.reasons, [])
})

test('shouldRecallBeforeRun stays quiet until six new messages land after the last recall', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '部署前要跑 smoke test'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '收到',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T00:02:00.000Z',
        content: '还要检查配置漂移'
      }),
      createMessage({
        id: 'm4',
        createdAt: '2026-03-23T00:03:00.000Z',
        content: '继续',
        role: 'assistant'
      }),
      createMessage({
        id: 'm5',
        createdAt: '2026-03-23T00:04:00.000Z',
        content: '然后核对回滚策略'
      }),
      createMessage({
        id: 'm6',
        createdAt: '2026-03-23T00:05:00.000Z',
        content: '最后确认值班人'
      }),
      createMessage({
        id: 'm7',
        createdAt: '2026-03-23T00:06:00.000Z',
        content: '再看 release note'
      })
    ],
    now: '2026-03-23T00:06:00.000Z',
    thread: createThread({
      memoryRecall: {
        lastRunAt: '2026-03-23T00:00:00.000Z',
        lastRecallAt: '2026-03-23T00:00:00.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 24
      }
    }),
    userQuery: '再看 release note'
  })

  assert.equal(decision.shouldRecall, false)
  assert.equal(decision.reasons.includes('message-growth'), false)
})

test('shouldRecallBeforeRun triggers after enough growth since the last recall', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-23T00:00:00.000Z',
        content: '部署前要跑 smoke test'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-23T00:01:00.000Z',
        content: '收到',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T00:02:00.000Z',
        content: '还要检查配置漂移'
      }),
      createMessage({
        id: 'm4',
        createdAt: '2026-03-23T00:03:00.000Z',
        content: '还要看 feature flag',
        role: 'assistant'
      }),
      createMessage({
        id: 'm5',
        createdAt: '2026-03-23T00:04:00.000Z',
        content: '然后核对回滚策略'
      }),
      createMessage({ id: 'm6', createdAt: '2026-03-23T00:05:00.000Z', content: '最后确认值班人' }),
      createMessage({
        id: 'm7',
        createdAt: '2026-03-23T00:06:00.000Z',
        content: '补一条发布窗口安排'
      }),
      createMessage({
        id: 'm8',
        createdAt: '2026-03-23T00:07:00.000Z',
        content: '最后确认值班人'
      })
    ],
    now: '2026-03-23T00:07:00.000Z',
    thread: createThread({
      memoryRecall: {
        lastRunAt: '2026-03-23T00:00:00.000Z',
        lastRecallAt: '2026-03-23T00:00:00.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 24
      }
    }),
    userQuery: '最后确认值班人'
  })

  assert.equal(decision.shouldRecall, true)
  assert.equal(decision.reasons.includes('message-growth'), true)
})

test('shouldRecallBeforeRun triggers after a long idle gap in the same thread', () => {
  const decision = shouldRecallBeforeRun({
    history: [
      createMessage({
        id: 'm1',
        createdAt: '2026-03-22T00:00:00.000Z',
        content: '前一天我们聊过 CI 故障'
      }),
      createMessage({
        id: 'm2',
        createdAt: '2026-03-22T00:01:00.000Z',
        content: '嗯，继续吧',
        role: 'assistant'
      }),
      createMessage({
        id: 'm3',
        createdAt: '2026-03-23T09:00:00.000Z',
        content: '我回来继续排查这个线程'
      })
    ],
    now: '2026-03-23T09:00:00.000Z',
    thread: createThread({
      memoryRecall: {
        lastRunAt: '2026-03-22T00:30:00.000Z',
        lastRecallAt: '2026-03-22T00:30:00.000Z',
        lastRecallMessageCount: 2,
        lastRecallCharCount: 20
      }
    }),
    userQuery: '我回来继续排查这个线程'
  })

  assert.equal(decision.shouldRecall, true)
  assert.equal(decision.reasons.includes('idle-gap'), true)
})

test('detectNoveltySignal boosts emphasized and syntax-heavy terms', () => {
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

  assert.equal(novelty.noveltyScore >= 0.75, true)
  assert.equal(novelty.novelTerms.includes('tooltimeout'), true)
  assert.equal(novelty.novelTerms.includes('sonnet-4.6'), true)
  assert.equal(novelty.novelTerms.includes('agent'), true)
})

test('shouldRecallBeforeRun skips topic novelty when only two strong code-switch terms appear', () => {
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
        content: '另外，帮我看 MCP 和 agent 的行为'
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
    userQuery: '另外，帮我看 MCP 和 agent 的行为'
  })

  assert.equal(decision.noveltyScore < 0.75, true)
  assert.equal(decision.novelTerms.length, 2)
  assert.equal(decision.shouldRecall, false)
  assert.equal(decision.reasons.includes('topic-novelty'), false)
})

test('shouldRecallBeforeRun requires three strong novel terms before topic novelty recalls', () => {
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
      noveltyScore: 0.8,
      novelTerms: ['vector index', 'agent scheduling', 'tool timeout']
    }
  })

  assert.equal(decision.shouldRecall, true)
  assert.equal(decision.reasons.includes('topic-novelty'), true)
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
