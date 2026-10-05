import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolCall } from '@renderer/app/types'
import { buildConversationGroupTimelineItems } from './messageTimelineLayout.ts'

const call = (id: string, toolName: ToolCall['toolName']): ToolCall => ({
  id,
  threadId: 'thread',
  runId: 'run',
  toolName,
  status: 'completed',
  inputSummary: id,
  startedAt: `2026-01-01T00:00:0${id.slice(-1)}.000Z`
})

for (const mode of ['tool-deck', 'work-summary'] as const) {
  test(`renderUi interrupts ${mode} grouping without changing the call sequence`, () => {
    const items = buildConversationGroupTimelineItems({
      hasMemoryRecall: false,
      replyCount: 1,
      showPreparing: false,
      showGenerating: false,
      activeAssistantTextBlocks: [],
      visibleToolCalls: [
        call('tool-1', 'read'),
        call('tool-2', 'read'),
        call('tool-3', 'renderUi'),
        call('tool-4', 'read'),
        call('tool-5', 'read')
      ],
      toolCallDisplayMode: mode
    })
    assert.deepEqual(
      items.map((item) => item.kind),
      [
        mode === 'tool-deck' ? 'tool-call-deck' : 'tool-call-group',
        'tool-call',
        mode === 'tool-deck' ? 'tool-call-deck' : 'tool-call-group'
      ]
    )
    assert.deepEqual(
      items.flatMap((item) => {
        if (item.kind === 'tool-call') return [item.toolCallId]
        if (item.kind === 'tool-call-group' || item.kind === 'tool-call-deck')
          return item.toolCallIds
        return []
      }),
      ['tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5']
    )
  })
}
