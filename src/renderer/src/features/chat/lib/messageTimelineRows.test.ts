import assert from 'node:assert/strict'
import test from 'node:test'

import type { Message, MessageTextBlockRecord } from '@renderer/app/types'
import {
  buildConversationGroupRows,
  buildMessageTimelineRows,
  type MessageTimelineRow
} from './messageTimelineRows.ts'
import type { MessageGroup } from './messageThreadPresentation.ts'

const TIMESTAMP = '2026-04-18T00:00:00.000Z'

function createUserMessage(id: string, content: string): Message {
  return {
    id,
    threadId: 'thread-1',
    role: 'user',
    content,
    status: 'completed',
    createdAt: TIMESTAMP
  }
}

function createAssistantMessage(input: {
  id: string
  content: string
  status: Message['status']
  createdAt?: string
  reasoning?: string
  textBlocks?: MessageTextBlockRecord[]
  visibleReply?: string
}): Message {
  return {
    id: input.id,
    threadId: 'thread-1',
    parentMessageId: 'user-1',
    role: 'assistant',
    content: input.content,
    status: input.status,
    createdAt: input.createdAt ?? TIMESTAMP,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.textBlocks ? { textBlocks: input.textBlocks } : {}),
    ...(input.visibleReply !== undefined ? { visibleReply: input.visibleReply } : {})
  }
}

function createGroup(input: {
  responseCount?: number
  activeBranchIndex?: number
  showPreparing?: boolean
  hideActiveBranchWhilePreparing?: boolean
  activeAssistant: Message
  activeAssistantMessages?: Message[]
  hiddenRequestMessageIds?: string[]
  inactiveAssistant?: Message
}): MessageGroup {
  const branches = [
    ...(input.inactiveAssistant
      ? [{ message: input.inactiveAssistant, isActive: false as const }]
      : []),
    { message: input.activeAssistant, isActive: true as const }
  ]

  return {
    userMessage: createUserMessage('user-1', 'Question'),
    assistantBranches: branches,
    activeAssistantMessages: input.activeAssistantMessages ?? [
      branches[branches.length - 1]!.message
    ],
    hiddenRequestMessageIds: input.hiddenRequestMessageIds ?? [],
    activeBranchIndex: input.activeBranchIndex ?? branches.length - 1,
    hideActiveBranchWhilePreparing: input.hideActiveBranchWhilePreparing ?? false,
    showPreparing: input.showPreparing ?? false
  }
}

function rowKinds(rows: MessageTimelineRow[]): string[] {
  return rows.map((row) => row.kind)
}

test('buildConversationGroupRows splits a streaming conversation into user, content, tool, and generating rows', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'streaming',
      textBlocks: [
        {
          id: 'text-1',
          content: 'hello',
          createdAt: TIMESTAMP
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'file.ts',
        startedAt: '2026-04-18T00:00:01.000Z'
      }
    ],
    runs: [],
    activeRunId: 'run-1',
    isActiveGroup: true,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-assistant-text-block',
    'group-tool-call',
    'group-generating'
  ])
})

test('buildConversationGroupRows keeps branch navigation, thinking, and footer as separate rows', () => {
  const inactiveAssistant = createAssistantMessage({
    id: 'assistant-old',
    content: 'Older answer',
    status: 'completed'
  })
  const activeAssistant = createAssistantMessage({
    id: 'assistant-new',
    content: 'Final answer',
    status: 'completed',
    reasoning: 'why this works'
  })

  const group = createGroup({
    activeAssistant,
    inactiveAssistant
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-branch-navigation',
    'group-thinking',
    'group-assistant-text-block',
    'group-footer'
  ])
})

test('buildConversationGroupRows displays channel visible replies instead of raw assistant output', () => {
  const activeAssistant = createAssistantMessage({
    id: 'assistant-owner-dm',
    content: '<internal>tool routing details</internal>',
    status: 'completed',
    textBlocks: [
      {
        id: 'raw-1',
        content: '<internal>',
        createdAt: TIMESTAMP
      },
      {
        id: 'raw-2',
        content: 'tool routing details</internal>',
        createdAt: TIMESTAMP
      }
    ],
    visibleReply: 'Clean channel reply'
  })
  const group = createGroup({ activeAssistant })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })
  const textRows = rows.filter((row) => row.kind === 'group-assistant-text-block')

  assert.deepEqual(
    textRows.map((row) => row.textBlock.content),
    ['Clean channel reply']
  )
})

test('buildConversationGroupRows renders hidden-steer continuation output inside the same group', () => {
  const assistantBeforeHidden = createAssistantMessage({
    id: 'assistant-before-hidden',
    content: 'Initial visible answer',
    status: 'completed',
    createdAt: '2026-04-18T00:00:01.000Z'
  })
  const assistantAfterHidden = createAssistantMessage({
    id: 'assistant-after-hidden',
    content: 'Continued visible answer',
    status: 'completed',
    createdAt: '2026-04-18T00:00:03.000Z'
  })
  const group = createGroup({
    activeAssistant: assistantBeforeHidden,
    activeAssistantMessages: [assistantBeforeHidden, assistantAfterHidden]
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-assistant-text-block',
    'group-assistant-text-block',
    'group-footer'
  ])
  assert.deepEqual(
    rows
      .filter((row) => row.kind === 'group-assistant-text-block')
      .map((row) => ({
        assistantMessageId: row.assistantMessage.id,
        content: row.textBlock.content
      })),
    [
      {
        assistantMessageId: 'assistant-before-hidden',
        content: 'Initial visible answer'
      },
      {
        assistantMessageId: 'assistant-after-hidden',
        content: 'Continued visible answer'
      }
    ]
  )
  assert.equal(
    rows.find((row) => row.kind === 'group-footer')?.assistantMessage.id,
    'assistant-after-hidden'
  )
})

test('buildConversationGroupRows renders one thinking block for hidden-steer continuations', () => {
  const assistantBeforeHidden = createAssistantMessage({
    id: 'assistant-before-hidden',
    content: 'Initial visible answer',
    status: 'completed',
    reasoning: 'Initial thought',
    createdAt: '2026-04-18T00:00:01.000Z'
  })
  const assistantAfterHidden = createAssistantMessage({
    id: 'assistant-after-hidden',
    content: 'Continued visible answer',
    status: 'streaming',
    reasoning: 'Continuation thought',
    createdAt: '2026-04-18T00:00:03.000Z'
  })
  const group = createGroup({
    activeAssistant: assistantBeforeHidden,
    activeAssistantMessages: [assistantBeforeHidden, assistantAfterHidden],
    hiddenRequestMessageIds: ['hidden-background-notice']
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [],
    activeRunId: 'run-hidden',
    isActiveGroup: true,
    subagentActive: false
  })
  const thinkingRows = rows.filter((row) => row.kind === 'group-thinking')

  assert.deepEqual(
    thinkingRows.map((row) => ({
      assistantMessageId: row.assistantMessage.id,
      isActive: row.isActive,
      reasoning: row.reasoning,
      startedAt: row.startedAt
    })),
    [
      {
        assistantMessageId: 'assistant-after-hidden',
        isActive: true,
        reasoning: 'Initial thought\n\nContinuation thought',
        startedAt: '2026-04-18T00:00:01.000Z'
      }
    ]
  )
})

test('buildConversationGroupRows keeps the thinking row key stable when hidden steer appends', () => {
  const assistantBeforeHidden = createAssistantMessage({
    id: 'assistant-before-hidden',
    content: 'Initial visible answer',
    status: 'streaming',
    reasoning: 'Initial thought',
    createdAt: '2026-04-18T00:00:01.000Z'
  })
  const visibleRows = buildConversationGroupRows({
    group: createGroup({
      activeAssistant: assistantBeforeHidden,
      activeAssistantMessages: [assistantBeforeHidden]
    }),
    inlineToolCalls: [],
    runs: [],
    activeRunId: 'run-visible',
    isActiveGroup: true,
    subagentActive: false
  })
  const assistantAfterHidden = createAssistantMessage({
    id: 'assistant-after-hidden',
    content: 'Continued visible answer',
    status: 'streaming',
    reasoning: 'Continuation thought',
    createdAt: '2026-04-18T00:00:03.000Z'
  })
  const hiddenRows = buildConversationGroupRows({
    group: createGroup({
      activeAssistant: assistantBeforeHidden,
      activeAssistantMessages: [
        { ...assistantBeforeHidden, status: 'completed' },
        assistantAfterHidden
      ],
      hiddenRequestMessageIds: ['hidden-background-notice']
    }),
    inlineToolCalls: [],
    runs: [],
    activeRunId: 'run-hidden',
    isActiveGroup: true,
    subagentActive: false
  })

  assert.equal(
    hiddenRows.find((row) => row.kind === 'group-thinking')?.key,
    visibleRows.find((row) => row.kind === 'group-thinking')?.key
  )
})

test('buildConversationGroupRows keeps hidden-steer thinking active before the next reasoning delta', () => {
  const assistantBeforeHidden = createAssistantMessage({
    id: 'assistant-before-hidden',
    content: 'Initial visible answer',
    status: 'completed',
    reasoning: 'Initial thought',
    createdAt: '2026-04-18T00:00:01.000Z'
  })
  const assistantAfterHidden = createAssistantMessage({
    id: 'assistant-after-hidden',
    content: '',
    status: 'streaming',
    createdAt: '2026-04-18T00:00:03.000Z'
  })
  const group = createGroup({
    activeAssistant: assistantBeforeHidden,
    activeAssistantMessages: [assistantBeforeHidden, assistantAfterHidden],
    hiddenRequestMessageIds: ['hidden-background-notice']
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [],
    activeRunId: 'run-hidden',
    isActiveGroup: true,
    subagentActive: false
  })
  const thinkingRows = rows.filter((row) => row.kind === 'group-thinking')

  assert.deepEqual(
    thinkingRows.map((row) => ({
      assistantMessageId: row.assistantMessage.id,
      isActive: row.isActive,
      reasoning: row.reasoning
    })),
    [
      {
        assistantMessageId: 'assistant-before-hidden',
        isActive: true,
        reasoning: 'Initial thought'
      }
    ]
  )
})

test('buildConversationGroupRows uses hidden-steer run metadata for the merged footer', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-after-hidden',
      content: 'Could not continue',
      status: 'failed',
      createdAt: '2026-04-18T00:00:03.000Z'
    }),
    hiddenRequestMessageIds: ['hidden-background-notice']
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [
      {
        id: 'run-hidden',
        threadId: 'thread-1',
        status: 'failed',
        error: 'hidden run failed',
        createdAt: '2026-04-18T00:00:02.000Z',
        requestMessageId: 'hidden-background-notice'
      }
    ],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  assert.equal(rows.find((row) => row.kind === 'group-footer')?.failedRunError, 'hidden run failed')
})

test('buildConversationGroupRows only marks the active appended text block as streaming', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'streaming',
      textBlocks: [
        {
          id: 'text-1',
          content: 'Finished block',
          createdAt: TIMESTAMP
        },
        {
          id: 'text-2',
          content: 'Still appending',
          createdAt: '2026-04-18T00:00:02.000Z'
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [],
    runs: [],
    activeRunId: 'run-1',
    isActiveGroup: true,
    subagentActive: false
  })
  const textRows = rows.filter((row) => row.kind === 'group-assistant-text-block')

  assert.deepEqual(
    textRows.map((row) => row.isStreaming),
    [false, true]
  )
})

test('buildConversationGroupRows summarizes completed agent work before the final text block', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'completed',
      reasoning: 'I should inspect first',
      textBlocks: [
        {
          id: 'text-1',
          content: 'I will inspect the files first.',
          createdAt: '2026-04-18T00:00:01.000Z'
        },
        {
          id: 'text-2',
          content: 'Final handoff',
          createdAt: '2026-04-18T00:00:03.000Z'
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'file.ts',
        startedAt: '2026-04-18T00:00:02.000Z',
        finishedAt: '2026-04-18T00:00:02.500Z'
      }
    ],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-thinking',
    'group-work-summary',
    'group-assistant-text-block',
    'group-footer'
  ])

  const summary = rows.find((row) => row.kind === 'group-work-summary')
  assert.equal(summary?.assistantMessage.id, 'assistant-1')
  assert.deepEqual(
    summary?.items.map((item) => item.kind),
    ['note', 'tool-call']
  )
  assert.equal(
    summary?.items[0]?.kind === 'note' ? summary.items[0].textBlock.content : null,
    'I will inspect the files first.'
  )
  assert.equal(
    summary?.items[1]?.kind === 'tool-call' ? summary.items[1].toolCall.id : null,
    'tool-1'
  )

  const finalText = rows.find((row) => row.kind === 'group-assistant-text-block')
  assert.equal(finalText?.key, 'assistant-text:assistant-1:text-2')
  assert.equal(finalText?.textBlock.content, 'Final handoff')
})

test('buildConversationGroupRows summarizes completed hidden-steer tool work before the final text block', () => {
  const assistantBeforeHidden = createAssistantMessage({
    id: 'assistant-before-hidden',
    content: 'Intermediate note',
    status: 'completed',
    reasoning: 'Initial thought',
    createdAt: '2026-04-18T00:00:01.000Z'
  })
  const assistantAfterHidden = createAssistantMessage({
    id: 'assistant-after-hidden',
    content: 'Final handoff',
    status: 'completed',
    createdAt: '2026-04-18T00:00:04.000Z'
  })
  const group = createGroup({
    activeAssistant: assistantBeforeHidden,
    activeAssistantMessages: [assistantBeforeHidden, assistantAfterHidden],
    hiddenRequestMessageIds: ['hidden-background-notice']
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-hidden',
        runId: 'run-hidden',
        threadId: 'thread-1',
        requestMessageId: 'hidden-background-notice',
        assistantMessageId: 'assistant-after-hidden',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'python3 check.py',
        startedAt: '2026-04-18T00:00:02.000Z',
        finishedAt: '2026-04-18T00:00:03.000Z'
      }
    ],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-thinking',
    'group-work-summary',
    'group-assistant-text-block',
    'group-footer'
  ])

  assert.deepEqual(
    rows
      .filter((row) => row.kind === 'group-assistant-text-block')
      .map((row) => row.textBlock.content),
    ['Final handoff']
  )
})

test('buildConversationGroupRows preserves chronological work trajectory inside the summary', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'completed',
      reasoning: 'Plan with **markdown**',
      textBlocks: [
        {
          id: 'text-1',
          content: 'First note',
          createdAt: '2026-04-18T00:00:02.000Z'
        },
        {
          id: 'text-2',
          content: 'Second note',
          createdAt: '2026-04-18T00:00:05.000Z'
        },
        {
          id: 'text-3',
          content: 'Final handoff',
          createdAt: '2026-04-18T00:00:06.000Z'
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-read-1',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'src/a.ts',
        startedAt: '2026-04-18T00:00:03.000Z'
      },
      {
        id: 'tool-read-2',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'src/b.ts',
        startedAt: '2026-04-18T00:00:04.000Z'
      }
    ],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  const summary = rows.find((row) => row.kind === 'group-work-summary')

  assert.deepEqual(
    summary?.items.map((item) => item.kind),
    ['note', 'tool-call-group', 'note']
  )
  assert.deepEqual(
    summary?.items.map((item) => item.key),
    ['note:text-1', 'tool-group:tool-read-1', 'note:text-2']
  )

  const toolGroup = summary?.items.find((item) => item.kind === 'tool-call-group')
  assert.equal(toolGroup?.toolGroup, 'read-files')
  assert.deepEqual(
    toolGroup?.toolCalls.map((toolCall) => toolCall.id),
    ['tool-read-1', 'tool-read-2']
  )
})

test('buildConversationGroupRows keeps unfinished tool work visible instead of summarizing it', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'completed',
      textBlocks: [
        {
          id: 'text-1',
          content: 'Checking now.',
          createdAt: '2026-04-18T00:00:01.000Z'
        },
        {
          id: 'text-2',
          content: 'Partial handoff',
          createdAt: '2026-04-18T00:00:03.000Z'
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-running',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'bash',
        status: 'running',
        inputSummary: 'pnpm test',
        startedAt: '2026-04-18T00:00:02.000Z'
      }
    ],
    runs: [],
    activeRunId: 'run-1',
    isActiveGroup: false,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-assistant-text-block',
    'group-tool-call',
    'group-assistant-text-block',
    'group-footer'
  ])
})

test('buildConversationGroupRows keeps failed responses visible instead of packaging them as completed work', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'failed',
      textBlocks: [
        {
          id: 'text-1',
          content: 'I tried to inspect this.',
          createdAt: '2026-04-18T00:00:01.000Z'
        },
        {
          id: 'text-2',
          content: 'This failed.',
          createdAt: '2026-04-18T00:00:03.000Z'
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-failed',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'bash',
        status: 'failed',
        inputSummary: 'pnpm test',
        startedAt: '2026-04-18T00:00:02.000Z'
      }
    ],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-assistant-text-block',
    'group-tool-call',
    'group-assistant-text-block',
    'group-footer'
  ])
})

test('buildConversationGroupRows keeps completed work expanded when work summary is disabled', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-1',
      content: '',
      status: 'completed',
      textBlocks: [
        {
          id: 'text-1',
          content: 'I will inspect this.',
          createdAt: '2026-04-18T00:00:01.000Z'
        },
        {
          id: 'text-2',
          content: 'Final handoff',
          createdAt: '2026-04-18T00:00:03.000Z'
        }
      ]
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'file.ts',
        startedAt: '2026-04-18T00:00:02.000Z'
      }
    ],
    runs: [],
    activeRunId: null,
    isActiveGroup: false,
    subagentActive: false,
    workSummaryEnabled: false
  })

  assert.deepEqual(rowKinds(rows), [
    'group-user',
    'group-assistant-text-block',
    'group-tool-call',
    'group-assistant-text-block',
    'group-footer'
  ])
})

test('buildMessageTimelineRows treats hidden request ids as the active group', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-after-hidden',
      content: '',
      status: 'streaming',
      textBlocks: [
        {
          id: 'text-after-hidden',
          content: 'Still appending',
          createdAt: '2026-04-18T00:00:03.000Z'
        }
      ]
    }),
    hiddenRequestMessageIds: ['hidden-background-notice']
  })

  const rows = buildMessageTimelineRows({
    messageGroups: [group],
    rootAssistantMessages: [],
    orphanToolCalls: [],
    pendingSteerMessage: null,
    inlineToolCalls: [],
    runs: [],
    activeRunId: 'run-hidden',
    activeRequestMessageId: 'hidden-background-notice',
    subagentActive: false
  })

  const textRow = rows.find((row) => row.kind === 'group-assistant-text-block')
  assert.equal(textRow?.isStreaming, true)
})

test('buildMessageTimelineRows keeps each conversation flattened into separate virtual rows', () => {
  const rows = buildMessageTimelineRows({
    messageGroups: [
      createGroup({
        showPreparing: true,
        activeAssistant: createAssistantMessage({
          id: 'assistant-1',
          content: '',
          status: 'streaming'
        })
      })
    ],
    rootAssistantMessages: [
      {
        id: 'assistant-root',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'Root note',
        status: 'completed',
        createdAt: '2026-04-18T00:00:03.000Z'
      }
    ],
    orphanToolCalls: [],
    pendingSteerMessage: null,
    inlineToolCalls: [],
    runs: [],
    activeRunId: null,
    activeRequestMessageId: 'user-1',
    subagentActive: false
  })

  assert.deepEqual(rowKinds(rows), ['group-user', 'group-preparing', 'assistant-root'])
})

test('buildConversationGroupRows keeps assistant lookup metadata for tool-only replies', () => {
  const group = createGroup({
    activeAssistant: createAssistantMessage({
      id: 'assistant-tool-only',
      content: '',
      status: 'streaming'
    })
  })

  const rows = buildConversationGroupRows({
    group,
    inlineToolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-tool-only',
        toolName: 'read',
        status: 'running',
        inputSummary: 'file.ts',
        startedAt: '2026-04-18T00:00:01.000Z'
      }
    ],
    runs: [],
    activeRunId: 'run-1',
    isActiveGroup: true,
    subagentActive: false
  })

  assert.equal(
    rows.some(
      (row) => 'assistantMessageId' in row && row.assistantMessageId === 'assistant-tool-only'
    ),
    true
  )
})
