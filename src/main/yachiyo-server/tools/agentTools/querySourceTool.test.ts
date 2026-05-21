import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ActivitySourceRecord,
  FolderRecord,
  MessageRecord,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { createTool as createQuerySourceTool } from './querySourceTool.ts'

const BASE_TIME = '2026-05-16T09:00:00.000Z'

function makeThread(overrides: Partial<ThreadRecord> & { id: string }): ThreadRecord {
  return {
    title: 'Untitled',
    updatedAt: BASE_TIME,
    ...overrides
  }
}

function makeMessage(
  overrides: Partial<MessageRecord> & { id: string; threadId: string }
): MessageRecord {
  return {
    role: 'user',
    content: '',
    status: 'completed',
    createdAt: BASE_TIME,
    ...overrides
  }
}

function makeFolder(overrides: Partial<FolderRecord> & { id: string }): FolderRecord {
  return {
    title: 'Folder',
    colorTag: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides
  }
}

function makeActivityRecord(overrides: Partial<ActivitySourceRecord> = {}): ActivitySourceRecord {
  return {
    id: 'activity-1',
    threadId: 'thread-source',
    runId: 'run-1',
    requestMessageId: 'msg-1',
    startedAt: '2026-05-16T09:20:00.000Z',
    endedAt: '2026-05-16T09:30:00.000Z',
    totalDurationMs: 600_000,
    uniqueApps: 1,
    summaryText: 'Worked in Example Editor on source database design.',
    entries: [
      {
        appName: 'Example Editor',
        bundleId: 'com.example.editor',
        windowTitle: 'source-query.ts',
        durationMs: 600_000
      }
    ],
    createdAt: '2026-05-16T09:31:00.000Z',
    ...overrides
  }
}

function createMemoryService(): MemoryService {
  return {
    hasHiddenSearchCapability: () => true,
    isConfigured: () => true,
    searchMemories: async ({ query, topic }) => [
      {
        id: 'memory-1',
        title: 'Durable source preference',
        content: `User prefers ${query} to stay queryable as source data.`,
        labels: topic ? [`topic:${topic}`] : ['topic:source-system'],
        importance: 0.8,
        unitType: 'preference',
        score: 0.91,
        sourceThreadId: 'thread-source',
        sourceThreadIds: ['thread-source'],
        sourceThreadRowIds: ['thread:thread-source'],
        sourceMessageRowIds: ['thread_message:thread-source:msg-1']
      }
    ],
    recallForContext: async ({ thread }) => ({
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
      thread
    }),
    createMemory: async () => ({ savedCount: 0 }),
    validateAndCreateMemory: async () => ({ savedCount: 0 }),
    distillCompletedRun: async () => ({ savedCount: 0 }),
    saveThread: async () => ({ savedCount: 0 })
  }
}

function parseToolJson(result: unknown): {
  error?: string
  rows?: Array<Record<string, unknown>>
} {
  const output = result as { content: Array<{ type: string; text?: string }>; error?: string }
  const text = output.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  return { ...JSON.parse(text), ...(output.error ? { error: output.error } : {}) }
}

test('querySource discovers thread spans with folder community and expands messages', async () => {
  const storage = createInMemoryYachiyoStorage()
  const folder = makeFolder({ id: 'folder-source', title: 'Source System', colorTag: 'azure' })
  storage.createFolder(folder)
  storage.createThread({
    thread: makeThread({
      id: 'thread-source',
      title: 'Activity Tracker durable source',
      folderId: folder.id,
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-1',
        threadId: 'thread-source',
        content: 'Move Activity Tracker data into a durable source.',
        createdAt: '2026-05-16T09:10:00.000Z'
      }),
      makeMessage({
        id: 'msg-2',
        threadId: 'thread-source',
        role: 'assistant',
        content: 'Use an encrypted sqlite table and expose it as a source table.',
        createdAt: '2026-05-16T09:11:00.000Z'
      }),
      makeMessage({
        id: 'msg-3',
        threadId: 'thread-source',
        content: 'Then design querySource as a model-facing virtual source database.',
        createdAt: '2026-05-16T09:12:00.000Z'
      })
    ]
  })

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const spanResult = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { text: 'durable source' },
        view: 'index',
        limit: 5
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc1', messages: [] }
    )
  )

  assert.equal(spanResult.error, undefined)
  assert.equal(spanResult.rows?.length, 1)
  const row = spanResult.rows![0]!
  assert.equal(row['table'], 'thread_spans')
  assert.equal(String(row['rowId']).startsWith('thread_span:'), true)
  assert.equal(row['sourceKind'], 'thread')
  assert.equal(row['threadTitle'], 'Activity Tracker durable source')
  assert.deepEqual(row['folder'], {
    id: 'folder-source',
    title: 'Source System',
    colorTag: 'azure'
  })
  assert.deepEqual(row['availableViews'], ['content', 'detail'])

  const messagesResult = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_messages',
        where: { parentRowId: String(row['rowId']) },
        view: 'detail'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc2', messages: [] }
    )
  )

  assert.equal(messagesResult.error, undefined)
  assert.deepEqual(
    messagesResult.rows?.map((message) => message['messageId']),
    ['msg-1', 'msg-2', 'msg-3']
  )
  assert.equal(messagesResult.rows?.[0]?.['table'], 'thread_messages')
  assert.equal(String(messagesResult.rows?.[0]?.['rowId']).startsWith('thread_message:'), true)
  assert.ok(
    String(messagesResult.rows?.[1]?.['content']).includes('encrypted sqlite table'),
    'expanded messages should include surrounding thread context'
  )
})

test('querySource delegates thread span text search without bootstrapping storage', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.bootstrap = () => {
    throw new Error('blocking bootstrap should not run')
  }
  let delegatedInput: unknown
  const tool = createQuerySourceTool({
    storage,
    sourceQueryExecutor: {
      query: async (input) => {
        delegatedInput = input
        return {
          rows: [
            {
              table: 'thread_spans',
              rowId: 'thread_span:thread-1:msg-1:msg-1',
              sourceKind: 'thread',
              threadId: 'thread-1',
              threadTitle: 'Source query design',
              title: 'Source query design',
              startedAt: '2026-05-16T09:00:00.000Z',
              endedAt: '2026-05-16T09:00:00.000Z',
              summary: 'user: querySource should not block the app.',
              matchedEvidence: ['querySource should not block the app.'],
              availableViews: ['messages']
            }
          ]
        }
      }
    }
  })

  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { text: 'querySource performance' },
        orderBy: 'match',
        view: 'index',
        limit: 3
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-delegate', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.equal(result.rows?.[0]?.['threadTitle'], 'Source query design')
  assert.deepEqual(delegatedInput, {
    from: 'thread_spans',
    where: { text: 'querySource performance' },
    orderBy: 'match',
    view: 'index',
    limit: 3
  })
})

test('querySource reranks text spans by normalized bm25 coverage and density', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-partial',
      title: 'Partial sample notes',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'partial-1',
        threadId: 'thread-partial',
        content: 'Alpha appears in the sample notes.',
        createdAt: '2026-05-16T09:10:00.000Z'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({
      id: 'thread-focused',
      title: 'Focused sample notes',
      updatedAt: '2026-05-16T09:30:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'focused-1',
        threadId: 'thread-focused',
        content: 'Alpha beta gamma delta use compact sample spans.',
        createdAt: '2026-05-16T09:20:00.000Z'
      })
    ]
  })
  storage.searchThreadsAndMessagesFts = () => [
    {
      threadId: 'thread-partial',
      threadTitle: 'Partial sample notes',
      threadUpdatedAt: '2026-05-16T09:40:00.000Z',
      titleMatched: true,
      messageMatches: [{ messageId: 'partial-1', snippet: 'Alpha appears in the sample notes.' }]
    },
    {
      threadId: 'thread-focused',
      threadTitle: 'Focused sample notes',
      threadUpdatedAt: '2026-05-16T09:30:00.000Z',
      titleMatched: false,
      messageMatches: [
        {
          messageId: 'focused-1',
          snippet: 'Alpha beta gamma delta use compact sample spans.'
        }
      ]
    }
  ]

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { text: 'alpha beta gamma delta' },
        view: 'index',
        limit: 2
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-span-rerank', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['threadId']),
    ['thread-focused', 'thread-partial']
  )
})

test('querySource splits distant text hits into granular content spans', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-wide',
      title: 'Wide sample discussion',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'wide-1',
        threadId: 'thread-wide',
        content: 'Alpha draft note.',
        createdAt: '2026-05-16T09:01:00.000Z'
      }),
      makeMessage({
        id: 'wide-2',
        threadId: 'thread-wide',
        content: 'Filler two.',
        createdAt: '2026-05-16T09:02:00.000Z'
      }),
      makeMessage({
        id: 'wide-3',
        threadId: 'thread-wide',
        content: 'Filler three.',
        createdAt: '2026-05-16T09:03:00.000Z'
      }),
      makeMessage({
        id: 'wide-4',
        threadId: 'thread-wide',
        content: 'Filler four.',
        createdAt: '2026-05-16T09:04:00.000Z'
      }),
      makeMessage({
        id: 'wide-5',
        threadId: 'thread-wide',
        content: 'Beta gamma delta draft.',
        createdAt: '2026-05-16T09:05:00.000Z'
      }),
      makeMessage({
        id: 'wide-6',
        threadId: 'thread-wide',
        content: 'Filler six.',
        createdAt: '2026-05-16T09:06:00.000Z'
      }),
      makeMessage({
        id: 'wide-7',
        threadId: 'thread-wide',
        content: 'Filler seven.',
        createdAt: '2026-05-16T09:07:00.000Z'
      }),
      makeMessage({
        id: 'wide-8',
        threadId: 'thread-wide',
        content: 'Filler eight.',
        createdAt: '2026-05-16T09:08:00.000Z'
      }),
      makeMessage({
        id: 'wide-9',
        threadId: 'thread-wide',
        content: 'Alpha beta gamma delta final.',
        createdAt: '2026-05-16T09:09:00.000Z'
      })
    ]
  })
  storage.searchThreadsAndMessagesFts = () => [
    {
      threadId: 'thread-wide',
      threadTitle: 'Wide sample discussion',
      threadUpdatedAt: '2026-05-16T09:40:00.000Z',
      titleMatched: false,
      messageMatches: [
        { messageId: 'wide-1', snippet: 'Alpha draft note.' },
        { messageId: 'wide-5', snippet: 'Beta gamma delta draft.' },
        { messageId: 'wide-9', snippet: 'Alpha beta gamma delta final.' }
      ]
    }
  ]

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { text: 'alpha beta gamma delta' },
        view: 'content',
        limit: 5
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-span-split', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['messageCount']),
    [2, 3, 2]
  )
  assert.equal(result.rows?.[0]?.['messages'], undefined)
})

test('querySource opens only the requested thread span rowId', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-target',
      title: 'Target sample discussion',
      updatedAt: '2026-05-16T09:20:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'target-1',
        threadId: 'thread-target',
        content: 'Alpha setup note.',
        createdAt: '2026-05-16T09:01:00.000Z'
      }),
      makeMessage({
        id: 'target-2',
        threadId: 'thread-target',
        content: 'Alpha beta gamma delta target note.',
        createdAt: '2026-05-16T09:02:00.000Z'
      }),
      makeMessage({
        id: 'target-3',
        threadId: 'thread-target',
        content: 'Target follow-up note.',
        createdAt: '2026-05-16T09:03:00.000Z'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({
      id: 'thread-current',
      title: 'Current unrelated discussion',
      updatedAt: '2026-05-16T10:00:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'current-1',
        threadId: 'thread-current',
        content: 'Current unrelated note.',
        createdAt: '2026-05-16T10:00:00.000Z'
      })
    ]
  })
  storage.searchThreadsAndMessagesFts = () => [
    {
      threadId: 'thread-target',
      threadTitle: 'Target sample discussion',
      threadUpdatedAt: '2026-05-16T09:20:00.000Z',
      titleMatched: false,
      messageMatches: [{ messageId: 'target-2', snippet: 'Alpha beta gamma delta target note.' }]
    }
  ]

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const indexResult = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { text: 'alpha beta gamma delta' },
        view: 'index',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-rowid-index', messages: [] }
    )
  )
  const rowId = String(indexResult.rows?.[0]?.['rowId'])

  const contentResult = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { rowId },
        view: 'content',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-rowid-content', messages: [] }
    )
  )
  const detailResult = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { rowId },
        view: 'detail',
        limit: 2
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-rowid-detail', messages: [] }
    )
  )
  const invalidResult = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: { rowId: 'thread_span:missing:missing:missing' },
        view: 'content',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-rowid-invalid', messages: [] }
    )
  )

  assert.equal(contentResult.error, undefined)
  assert.equal(contentResult.rows?.length, 1)
  assert.equal(contentResult.rows?.[0]?.['threadId'], 'thread-target')
  assert.equal(contentResult.rows?.[0]?.['messages'], undefined)
  assert.deepEqual(
    detailResult.rows?.map((message) => message['messageId']),
    ['target-1', 'target-2']
  )
  assert.equal(detailResult.rows?.[0]?.['table'], 'thread_messages')
  assert.deepEqual(invalidResult.rows, [])
})

test('querySource maps thread views to span and message child tables', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-drilldown',
      title: 'Thread drilldown sample',
      updatedAt: '2026-05-16T09:20:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'drill-1',
        threadId: 'thread-drilldown',
        content: 'First drilldown message.',
        createdAt: '2026-05-16T09:01:00.000Z'
      }),
      makeMessage({
        id: 'drill-2',
        threadId: 'thread-drilldown',
        content: 'Second drilldown message.',
        createdAt: '2026-05-16T09:02:00.000Z'
      })
    ]
  })

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const contentResult = parseToolJson(
    await tool.execute!(
      {
        from: 'threads',
        where: { rowId: 'thread:thread-drilldown' },
        view: 'content',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-thread-content', messages: [] }
    )
  )
  const detailResult = parseToolJson(
    await tool.execute!(
      {
        from: 'threads',
        where: { rowId: 'thread:thread-drilldown' },
        view: 'detail',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-thread-detail', messages: [] }
    )
  )

  assert.equal(contentResult.rows?.[0]?.['table'], 'thread_spans')
  assert.equal(contentResult.rows?.[0]?.['messages'], undefined)
  assert.deepEqual(
    detailResult.rows?.map((message) => message['messageId']),
    ['drill-1']
  )
  assert.equal(detailResult.rows?.[0]?.['table'], 'thread_messages')
})

test('querySource maps source event views to their source rows', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-source-drilldown',
      title: 'Source event drilldown sample',
      updatedAt: '2026-05-16T09:20:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'source-drill-1',
        threadId: 'thread-source-drilldown',
        content: 'Source event first message.',
        createdAt: '2026-05-16T09:01:00.000Z'
      }),
      makeMessage({
        id: 'source-drill-2',
        threadId: 'thread-source-drilldown',
        content: 'Source event second message.',
        createdAt: '2026-05-16T09:02:00.000Z'
      })
    ]
  })

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const indexResult = parseToolJson(
    await tool.execute!(
      {
        from: 'source_events',
        where: {
          since: '2026-05-16T09:00:00.000Z',
          until: '2026-05-16T09:10:00.000Z'
        },
        view: 'index',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-source-index', messages: [] }
    )
  )
  const eventRowId = String(indexResult.rows?.[0]?.['rowId'])
  const contentResult = parseToolJson(
    await tool.execute!(
      {
        from: 'source_events',
        where: { rowId: eventRowId },
        view: 'content',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-source-content', messages: [] }
    )
  )
  const detailResult = parseToolJson(
    await tool.execute!(
      {
        from: 'source_events',
        where: { rowId: eventRowId },
        view: 'detail',
        limit: 1
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-source-detail', messages: [] }
    )
  )

  assert.equal(contentResult.rows?.[0]?.['table'], 'thread_spans')
  assert.equal(contentResult.rows?.[0]?.['messages'], undefined)
  assert.deepEqual(
    detailResult.rows?.map((message) => message['messageId']),
    ['source-drill-1']
  )
  assert.equal(detailResult.rows?.[0]?.['table'], 'thread_messages')
})

test('querySource auto orders range thread spans by event time, not thread list order', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-updated-late',
      title: 'Updated later but older discussion',
      updatedAt: '2026-05-16T12:00:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-older',
        threadId: 'thread-updated-late',
        content: 'Older source discussion.',
        createdAt: '2026-05-16T09:05:00.000Z'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({
      id: 'thread-updated-early',
      title: 'Updated earlier but newer discussion',
      updatedAt: '2026-05-16T09:30:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-newer',
        threadId: 'thread-updated-early',
        content: 'Newer source discussion.',
        createdAt: '2026-05-16T10:15:00.000Z'
      })
    ]
  })

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'thread_spans',
        where: {
          since: '2026-05-16T09:00:00.000Z',
          until: '2026-05-16T11:00:00.000Z'
        },
        orderBy: 'auto',
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-auto-spans', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['threadId']),
    ['thread-updated-early', 'thread-updated-late']
  )
})

test('querySource auto orders source events by timeline time across sources', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-source',
      title: 'Source database design',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-thread',
        threadId: 'thread-source',
        content: 'Conversation event happened first.',
        createdAt: '2026-05-16T09:05:00.000Z'
      })
    ]
  })
  storage.saveActivitySourceRecord(
    makeActivityRecord({
      id: 'activity-later',
      threadId: 'thread-source',
      startedAt: '2026-05-16T09:50:00.000Z',
      endedAt: '2026-05-16T09:55:00.000Z',
      summaryText: 'Later editor activity.'
    })
  )

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'source_events',
        where: {
          since: '2026-05-16T09:00:00.000Z',
          until: '2026-05-16T10:00:00.000Z'
        },
        orderBy: 'auto',
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-auto-events', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['sourceKind']),
    ['activity', 'thread']
  )
})

test('querySource exposes window text previews without raw snapshot payloads', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-source',
      title: 'Source database design',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [makeMessage({ id: 'msg-1', threadId: 'thread-source', content: 'Owner message.' })]
  })
  storage.saveActivitySourceRecord(
    makeActivityRecord({
      snapshots: [
        {
          id: 'snapshot-1',
          capturedAt: '2026-05-16T09:25:00.000Z',
          appName: 'Example Editor',
          bundleId: 'com.example.editor',
          windowTitle: 'source-query.ts',
          source: 'screen',
          trigger: 'initial-blur',
          ocr: {
            engine: 'apple-vision',
            revision: 3,
            confidence: 0.9,
            lineCount: 2,
            contentHash: 'sha256:rare',
            excerpt: 'rare oscilloscope calibration note',
            text: 'rare oscilloscope calibration note with full captured-window detail'
          }
        }
      ]
    })
  )

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const quietIndexResult = parseToolJson(
    await tool.execute!(
      { from: 'activity_records', view: 'index' },
      {
        abortSignal: new AbortController().signal,
        toolCallId: 'tc-window-text-quiet-index',
        messages: []
      }
    )
  )
  const indexResult = parseToolJson(
    await tool.execute!(
      { from: 'activity_records', where: { text: 'oscilloscope' }, view: 'index' },
      {
        abortSignal: new AbortController().signal,
        toolCallId: 'tc-window-text-index',
        messages: []
      }
    )
  )
  const contentResult = parseToolJson(
    await tool.execute!(
      {
        from: 'activity_records',
        where: { rowId: 'activity_record:activity-1' },
        view: 'content'
      },
      {
        abortSignal: new AbortController().signal,
        toolCallId: 'tc-window-text-content',
        messages: []
      }
    )
  )
  const detailResult = parseToolJson(
    await tool.execute!(
      {
        from: 'activity_records',
        where: { rowId: 'activity_record:activity-1' },
        view: 'detail'
      },
      {
        abortSignal: new AbortController().signal,
        toolCallId: 'tc-window-text-detail',
        messages: []
      }
    )
  )
  const sourceEventsResult = parseToolJson(
    await tool.execute!(
      { from: 'source_events', where: { text: 'oscilloscope' }, view: 'index' },
      {
        abortSignal: new AbortController().signal,
        toolCallId: 'tc-window-text-source-events',
        messages: []
      }
    )
  )

  assert.equal(quietIndexResult.rows?.length, 1)
  assert.equal(quietIndexResult.rows?.[0]['windowTextSnapshotCount'], 1)
  assert.equal(quietIndexResult.rows?.[0]['matchedEvidence'], undefined)
  assert.equal(quietIndexResult.rows?.[0]['windowTextPreviews'], undefined)
  assert.equal(quietIndexResult.rows?.[0]['snapshotCount'], undefined)
  assert.equal(quietIndexResult.rows?.[0]['snapshotExcerpts'], undefined)
  assert.equal(quietIndexResult.rows?.[0]['snapshots'], undefined)
  assert.doesNotMatch(String(quietIndexResult.rows?.[0]['summary'] ?? ''), /oscilloscope/)

  assert.equal(indexResult.rows?.length, 1)
  assert.equal(indexResult.rows?.[0]['windowTextSnapshotCount'], 1)
  assert.match(String(indexResult.rows?.[0]['matchedEvidence'] ?? ''), /oscilloscope/)
  assert.equal(indexResult.rows?.[0]['windowTextPreviews'], undefined)

  assert.equal(sourceEventsResult.rows?.length, 1)
  assert.equal(sourceEventsResult.rows?.[0]['sourceKind'], 'activity')
  assert.equal(sourceEventsResult.rows?.[0]['windowTextSnapshotCount'], 1)
  assert.match(String(sourceEventsResult.rows?.[0]['matchedEvidence'] ?? ''), /oscilloscope/)

  assert.deepEqual(contentResult.rows?.[0]['windowTextPreviews'], [
    {
      capturedAt: '2026-05-16T09:25:00.000Z',
      appName: 'Example Editor',
      bundleId: 'com.example.editor',
      windowTitle: 'source-query.ts',
      textPreview: 'rare oscilloscope calibration note'
    }
  ])
  assert.equal(contentResult.rows?.[0]['snapshots'], undefined)
  assert.equal(contentResult.rows?.[0]['snapshotExcerpts'], undefined)

  assert.deepEqual(detailResult.rows?.[0]['windowTextSnapshots'], [
    {
      capturedAt: '2026-05-16T09:25:00.000Z',
      appName: 'Example Editor',
      bundleId: 'com.example.editor',
      windowTitle: 'source-query.ts',
      text: 'rare oscilloscope calibration note with full captured-window detail'
    }
  ])
  assert.equal(detailResult.rows?.[0]['snapshots'], undefined)
})

test('querySource rejects match ordering for non-match-ranked tables', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-source',
      title: 'Source database design',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-thread',
        threadId: 'thread-source',
        content: 'Activity record owner thread.',
        createdAt: '2026-05-16T09:05:00.000Z'
      })
    ]
  })
  storage.saveActivitySourceRecord(makeActivityRecord())

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'activity_records',
        where: { text: 'Example Editor' },
        orderBy: 'match',
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-match-activity', messages: [] }
    )
  )

  assert.equal(
    result.error,
    'orderBy.match is only supported for memories and text-filtered thread_spans.'
  )
  assert.deepEqual(result.rows, [])
})

test('querySource rejects time ordering for memories', async () => {
  const tool = createQuerySourceTool({
    storage: createInMemoryYachiyoStorage(),
    memoryService: createMemoryService()
  })

  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'memories',
        where: { text: 'durable source' },
        orderBy: 'timeDesc',
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-memory-time', messages: [] }
    )
  )

  assert.equal(result.error, 'memories only supports orderBy.auto or orderBy.match.')
  assert.deepEqual(result.rows, [])
})

test('querySource fallback excludes privacy-mode thread data and related activity', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-public',
      title: 'Public source design',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-public',
        threadId: 'thread-public',
        content: 'Public querySource design note.',
        createdAt: '2026-05-16T09:10:00.000Z'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({
      id: 'thread-private',
      title: 'Private salary negotiation',
      privacyMode: true,
      updatedAt: '2026-05-16T09:50:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-private',
        threadId: 'thread-private',
        content: 'Private salary details should never appear in source queries.',
        createdAt: '2026-05-16T09:20:00.000Z'
      })
    ]
  })
  storage.saveActivitySourceRecord(
    makeActivityRecord({
      id: 'activity-private',
      threadId: 'thread-private',
      summaryText: 'Private salary spreadsheet work.',
      entries: [
        {
          appName: 'Numbers',
          bundleId: 'com.apple.Numbers',
          windowTitle: 'Private salary plan',
          durationMs: 600_000
        }
      ]
    })
  )

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const threadRows = parseToolJson(
    await tool.execute!(
      { from: 'threads', where: { text: 'salary' }, view: 'index' },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-private-threads', messages: [] }
    )
  )
  const messageRows = parseToolJson(
    await tool.execute!(
      { from: 'thread_messages', where: { text: 'salary' }, view: 'index' },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-private-messages', messages: [] }
    )
  )
  const activityRows = parseToolJson(
    await tool.execute!(
      { from: 'activity_records', where: { text: 'salary' }, view: 'index' },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-private-activity', messages: [] }
    )
  )

  assert.deepEqual(threadRows.rows, [])
  assert.deepEqual(messageRows.rows, [])
  assert.deepEqual(activityRows.rows, [])
})

test('querySource source_events returns event-like sources for a time range without memories', async () => {
  const storage = createInMemoryYachiyoStorage()
  const folder = makeFolder({ id: 'folder-source', title: 'Source System' })
  storage.createFolder(folder)
  storage.createThread({
    thread: makeThread({
      id: 'thread-source',
      title: 'Source database design',
      folderId: folder.id,
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-1',
        threadId: 'thread-source',
        content: 'Timeline should show thread events.',
        createdAt: '2026-05-16T09:05:00.000Z'
      })
    ]
  })
  storage.saveActivitySourceRecord(makeActivityRecord())

  const memoryService = createMemoryService()
  memoryService.searchMemories = async () => {
    throw new Error('source_events must not read memories')
  }

  const tool = createQuerySourceTool({ storage, memoryService })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'source_events',
        where: {
          since: '2026-05-16T09:00:00.000Z',
          until: '2026-05-16T10:00:00.000Z'
        },
        orderBy: 'timeAsc',
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc3', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['sourceKind']),
    ['thread', 'activity']
  )
  assert.equal((result.rows?.[0]?.['folder'] as { title?: string }).title, 'Source System')
  assert.equal(
    result.rows?.some((row) => row['sourceKind'] === 'memory'),
    false
  )
})

test('querySource normalizes offset timestamps before filtering activity records', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-source',
      title: 'Source database design',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-1',
        threadId: 'thread-source',
        content: 'Timeline should show activity events.',
        createdAt: '2026-05-16T09:05:00.000Z'
      })
    ]
  })
  storage.saveActivitySourceRecord(makeActivityRecord())

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'activity_records',
        where: {
          since: '2026-05-16T17:00:00+08:00',
          until: '2026-05-16T18:00:00+08:00'
        },
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-offset-time', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['activityId']),
    ['activity-1']
  )
})

test('querySource source_events applies text filters to thread events', async () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-matching',
      title: 'Query source matching',
      updatedAt: '2026-05-16T09:40:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-matching',
        threadId: 'thread-matching',
        content: 'Needle topic belongs in this event.',
        createdAt: '2026-05-16T09:10:00.000Z'
      })
    ]
  })
  storage.createThread({
    thread: makeThread({
      id: 'thread-unrelated',
      title: 'Unrelated work',
      updatedAt: '2026-05-16T09:41:00.000Z'
    }),
    createdAt: BASE_TIME,
    messages: [
      makeMessage({
        id: 'msg-unrelated',
        threadId: 'thread-unrelated',
        content: 'This event should be filtered out.',
        createdAt: '2026-05-16T09:11:00.000Z'
      })
    ]
  })

  const tool = createQuerySourceTool({ storage, memoryService: createMemoryService() })
  const result = parseToolJson(
    await tool.execute!(
      {
        from: 'source_events',
        where: {
          text: 'needle',
          since: '2026-05-16T09:00:00.000Z',
          until: '2026-05-16T10:00:00.000Z'
        },
        orderBy: 'timeAsc',
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc-source-text', messages: [] }
    )
  )

  assert.equal(result.error, undefined)
  assert.deepEqual(
    result.rows?.map((row) => row['threadId']),
    ['thread-matching']
  )
})

test('querySource memories require text and return semantic memory rows', async () => {
  const tool = createQuerySourceTool({
    storage: createInMemoryYachiyoStorage(),
    memoryService: createMemoryService()
  })

  const invalid = parseToolJson(
    await tool.execute!(
      {
        from: 'memories',
        where: { topic: 'source-system' },
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc4', messages: [] }
    )
  )

  assert.equal(invalid.error, 'memories requires where.text.')

  const valid = parseToolJson(
    await tool.execute!(
      {
        from: 'memories',
        where: { text: 'durable source', topic: 'source-system' },
        view: 'index'
      },
      { abortSignal: new AbortController().signal, toolCallId: 'tc5', messages: [] }
    )
  )

  assert.equal(valid.error, undefined)
  assert.deepEqual(valid.rows, [
    {
      table: 'memories',
      rowId: 'memory:memory-1',
      sourceKind: 'memory',
      memoryId: 'memory-1',
      title: 'Durable source preference',
      topic: 'source-system',
      unitType: 'preference',
      importance: 0.8,
      score: 0.91,
      sourceThreadId: 'thread-source',
      sourceThreadIds: ['thread-source'],
      sourceThreadRowIds: ['thread:thread-source'],
      sourceMessageRowIds: ['thread_message:thread-source:msg-1'],
      summary: 'User prefers durable source to stay queryable as source data.',
      availableViews: ['content']
    }
  ])
})
