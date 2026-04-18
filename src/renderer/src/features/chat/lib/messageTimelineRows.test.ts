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
    ...(input.textBlocks ? { textBlocks: input.textBlocks } : {})
  }
}

function createGroup(input: {
  responseCount?: number
  activeBranchIndex?: number
  showPreparing?: boolean
  hideActiveBranchWhilePreparing?: boolean
  activeAssistant: Message
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
    harnessEvents: [],
    orphanToolCalls: [],
    pendingSteerMessage: null,
    queuedFollowUpMessage: null,
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
