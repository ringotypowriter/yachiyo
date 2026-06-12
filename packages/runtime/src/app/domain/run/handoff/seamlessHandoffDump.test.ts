import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ThreadRecord, ToolCallRecord } from '@yachiyo/shared/protocol'
import { createSeamlessHandoffDump } from './seamlessHandoffDump.ts'

const thread: ThreadRecord = {
  id: 'thread-1',
  title: 'Long task',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z'
} as ThreadRecord

function message(
  input: Partial<MessageRecord> & Pick<MessageRecord, 'id' | 'role' | 'content'>
): MessageRecord {
  return {
    threadId: 'thread-1',
    status: 'completed',
    createdAt: `2026-06-01T00:00:0${input.id.at(-1) ?? '0'}.000Z`,
    ...input
  }
}

function toolCall(input: Partial<ToolCallRecord> & Pick<ToolCallRecord, 'id'>): ToolCallRecord {
  return {
    threadId: 'thread-1',
    toolName: 'read',
    status: 'completed',
    inputSummary: 'path: src/main.ts',
    outputSummary: '42 lines',
    startedAt: '2026-06-01T00:00:03.000Z',
    ...input
  }
}

test('createSeamlessHandoffDump includes only messages after the old watermark up to the checkpoint', () => {
  const dump = createSeamlessHandoffDump({
    thread,
    activePathMessages: [
      message({ id: 'u1', role: 'user', content: 'old request' }),
      message({ id: 'a1', role: 'assistant', content: 'old answer' }),
      message({ id: 'u2', role: 'user', content: 'current request' }),
      message({ id: 'a2', role: 'assistant', content: 'checkpoint answer' })
    ],
    toolCalls: [
      toolCall({ id: 'tc-old', requestMessageId: 'u1', assistantMessageId: 'a1' }),
      toolCall({ id: 'tc-new', requestMessageId: 'u2', assistantMessageId: 'a2', cwd: '/work' })
    ],
    checkpointMessageId: 'a2',
    previousWatermarkMessageId: 'a1'
  })

  assert.match(dump.markdown, /current request/)
  assert.match(dump.markdown, /checkpoint answer/)
  assert.match(dump.markdown, /tc-new/)
  assert.match(dump.markdown, /cwd: `\/work`/)
  assert.doesNotMatch(dump.markdown, /old request/)
  assert.doesNotMatch(dump.markdown, /old answer/)
  assert.doesNotMatch(dump.markdown, /tc-old/)
  assert.doesNotMatch(dump.markdown, /runId|requestMessageId|provider|token/i)
})

test('createSeamlessHandoffDump records image and attachment references without embedding data URLs', () => {
  const dump = createSeamlessHandoffDump({
    thread,
    activePathMessages: [
      message({
        id: 'u1',
        role: 'user',
        content: 'see attached',
        images: [
          {
            dataUrl: 'data:image/png;base64,SECRET',
            filename: 'plot.png',
            mediaType: 'image/png',
            workspacePath: '/tmp/plot.png',
            attachmentIndex: 1,
            altText: 'a line chart'
          }
        ],
        attachments: [
          {
            filename: 'paper.pdf',
            mediaType: 'application/pdf',
            workspacePath: '/tmp/paper.pdf',
            attachmentIndex: 2
          }
        ]
      }),
      message({ id: 'a1', role: 'assistant', content: 'looked at both' })
    ],
    toolCalls: [],
    checkpointMessageId: 'a1'
  })

  assert.match(dump.markdown, /plot\.png/)
  assert.match(dump.markdown, /image\/png/)
  assert.match(dump.markdown, /\/tmp\/plot\.png/)
  assert.match(dump.markdown, /a line chart/)
  assert.match(dump.markdown, /paper\.pdf/)
  assert.match(dump.markdown, /application\/pdf/)
  assert.doesNotMatch(dump.markdown, /SECRET|data:image/)
})
