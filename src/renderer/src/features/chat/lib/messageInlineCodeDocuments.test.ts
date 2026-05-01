import assert from 'node:assert/strict'
import test from 'node:test'

import type { Message } from '@renderer/app/types'
import type { MessageGroup } from './messageThreadPresentation.ts'
import {
  collectInlineCodeMarkdownDocumentsFromRows,
  type MessageTimelineRow
} from './messageTimelineRows.ts'

const TIMESTAMP = '2026-04-18T00:00:00.000Z'

function createUserMessage(): Message {
  return {
    id: 'user-1',
    threadId: 'thread-1',
    role: 'user',
    content: 'Question',
    status: 'completed',
    createdAt: TIMESTAMP
  }
}

function createAssistantMessage(input: {
  id: string
  content: string
  status?: Message['status']
  visibleReply?: string
}): Message {
  return {
    id: input.id,
    threadId: 'thread-1',
    parentMessageId: 'user-1',
    role: 'assistant',
    content: input.content,
    status: input.status ?? 'completed',
    createdAt: TIMESTAMP,
    ...(input.visibleReply !== undefined ? { visibleReply: input.visibleReply } : {})
  }
}

function createGroup(assistantMessage: Message): MessageGroup {
  return {
    userMessage: createUserMessage(),
    assistantBranches: [{ message: assistantMessage, isActive: true }],
    activeBranchIndex: 0,
    hideActiveBranchWhilePreparing: false,
    showPreparing: false
  }
}

test('collectInlineCodeMarkdownDocumentsFromRows scans displayed assistant text blocks', () => {
  const assistantMessage = createAssistantMessage({
    id: 'assistant-1',
    content: 'stale `src/stale.ts`'
  })
  const group = createGroup(assistantMessage)
  const rows: MessageTimelineRow[] = [
    {
      kind: 'group-assistant-text-block',
      key: 'assistant-1:block-1',
      time: TIMESTAMP,
      requestMessageId: 'user-1',
      group,
      assistantMessage,
      textBlock: {
        id: 'block-1',
        content: 'displayed `src/foo.ts`',
        createdAt: TIMESTAMP
      },
      hasRunningToolCall: false,
      isLastTextBlock: true,
      isStreaming: false,
      compactBottomSpacing: false
    }
  ]

  assert.deepEqual(collectInlineCodeMarkdownDocumentsFromRows(rows), ['displayed `src/foo.ts`'])
})

test('collectInlineCodeMarkdownDocumentsFromRows keeps root assistant content behavior', () => {
  const rows: MessageTimelineRow[] = [
    {
      kind: 'assistant-root',
      key: 'assistant-root-1',
      time: TIMESTAMP,
      scrollMessageId: 'assistant-root-1',
      data: createAssistantMessage({
        id: 'assistant-root-1',
        content: 'raw `src/raw.ts`',
        visibleReply: 'visible `src/visible.ts`'
      })
    },
    {
      kind: 'assistant-root',
      key: 'assistant-root-2',
      time: TIMESTAMP,
      scrollMessageId: 'assistant-root-2',
      data: createAssistantMessage({
        id: 'assistant-root-2',
        content: 'streaming `src/streaming.ts`',
        status: 'streaming'
      })
    }
  ]

  assert.deepEqual(collectInlineCodeMarkdownDocumentsFromRows(rows), ['visible `src/visible.ts`'])
})
