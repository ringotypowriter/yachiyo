import assert from 'node:assert/strict'
import test from 'node:test'
import type { Message, ToolCall } from '@renderer/app/types'
import { buildAssistantResponseTimelineTrace } from './messageThreadPresentation.ts'
import { buildConversationGroupTimelineItems } from './messageTimelineLayout.ts'

for (const anchor of ['assistant-1', 'assistant-2', undefined]) {
  test(`tool decks retain response order when earlier tools are anchored to ${anchor}`, () => {
    const firstBlock = { id: 'text-1', content: 'Starting', createdAt: '2026-09-06T03:07:15.000Z' }
    const secondBlock = {
      id: 'text-2',
      content: 'Continuing',
      createdAt: '2026-09-06T03:12:23.000Z'
    }
    const assistantMessages: Message[] = [
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        status: 'completed',
        content: firstBlock.content,
        createdAt: '2026-09-06T03:10:51.000Z',
        textBlocks: [firstBlock],
        responseMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: firstBlock.content },
              { type: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: {} }
            ]
          }
        ]
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        status: 'streaming',
        content: secondBlock.content,
        createdAt: '2026-09-06T03:18:27.000Z',
        textBlocks: [secondBlock],
        responseMessages: [
          { role: 'assistant', content: [{ type: 'text', text: secondBlock.content }] }
        ]
      }
    ]
    const toolCalls: ToolCall[] = [
      {
        id: 'tool-1',
        threadId: 'thread-1',
        runId: 'run-1',
        assistantMessageId: anchor,
        toolName: 'read',
        status: 'completed',
        inputSummary: 'first',
        startedAt: '2026-09-06T03:07:17.000Z'
      }
    ]
    const textBlocksByAssistantMessageId = new Map([
      ['assistant-1', [firstBlock]],
      ['assistant-2', [secondBlock]]
    ])
    const buildItems = (
      calls: ToolCall[]
    ): ReturnType<typeof buildConversationGroupTimelineItems> =>
      buildConversationGroupTimelineItems({
        hasMemoryRecall: false,
        replyCount: 1,
        showPreparing: false,
        showGenerating: false,
        activeAssistantTextBlocks: [firstBlock, secondBlock],
        visibleToolCalls: calls,
        sourceTrace: buildAssistantResponseTimelineTrace({
          assistantMessages,
          textBlocksByAssistantMessageId,
          toolCalls: calls
        })
      })
    const before = buildItems(toolCalls)
    assert.deepEqual(
      before.map((item) => item.key),
      ['text-1', 'tool-deck:tool-1', 'text-2']
    )

    const after = buildItems([
      ...toolCalls,
      {
        id: 'tool-2',
        threadId: 'thread-1',
        runId: 'run-1',
        toolName: 'bash',
        status: 'running',
        inputSummary: 'new',
        startedAt: '2026-09-06T03:12:25.000Z'
      }
    ])
    assert.deepEqual(after.slice(0, before.length), before)
    assert.deepEqual(after.at(-1), {
      kind: 'tool-call-deck',
      key: 'tool-deck:tool-2',
      startedAt: '2026-09-06T03:12:25.000Z',
      toolCallIds: ['tool-2']
    })

    const withUntracedHistory = buildItems([
      ...toolCalls,
      {
        ...toolCalls[0]!,
        id: 'tool-untraced',
        startedAt: '2026-09-06T03:07:18.000Z'
      }
    ])
    assert.deepEqual(withUntracedHistory, [
      before[0],
      {
        kind: 'tool-call-deck',
        key: 'tool-deck:tool-1',
        startedAt: '2026-09-06T03:07:17.000Z',
        toolCallIds: ['tool-1', 'tool-untraced']
      },
      before[2]
    ])
  })
}
