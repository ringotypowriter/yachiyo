import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyStripCompact,
  estimateTokenCount,
  identifyRunSpans,
  STRIP_COMPACT_TOKEN_THRESHOLD
} from './contextStripCompact.ts'
import type { ModelMessage } from './types.ts'

function makeUserMessage(content: string): ModelMessage {
  return { role: 'user', content }
}

function makeAssistantMessage(content: string): ModelMessage {
  return { role: 'assistant', content }
}

function makeToolMessage(toolCallId: string, output: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: 'read',
        result: 'ok',
        output
      }
    ]
  } as unknown as ModelMessage
}

function makeSystemMessage(content: string): ModelMessage {
  return { role: 'system', content }
}

function makeLargeToolOutput(sizeChars: number): { type: string; value: unknown[] } {
  return {
    type: 'content',
    value: [{ type: 'text', text: 'x'.repeat(sizeChars) }]
  }
}

/** Build messages whose estimated token count exceeds the threshold. */
function buildOverThresholdMessages(): ModelMessage[] {
  // Each 400K-char tool output ≈ 100K tokens. Two runs with these outputs push past 200K.
  const largeOutput = makeLargeToolOutput(500_000)
  return [
    makeSystemMessage('system'),
    makeUserMessage('q1'),
    makeAssistantMessage('a1'),
    makeToolMessage('tc1', largeOutput), // old run
    makeUserMessage('q2'),
    makeAssistantMessage('a2'),
    makeToolMessage('tc2', largeOutput) // latest run
  ]
}

test('identifyRunSpans finds contiguous assistant+tool blocks', () => {
  const messages: ModelMessage[] = [
    makeSystemMessage('system'),
    makeUserMessage('hello'),
    makeAssistantMessage('hi'),
    makeToolMessage('tc1', { type: 'text', value: [] }),
    makeUserMessage('next'),
    makeAssistantMessage('reply'),
    makeToolMessage('tc2', { type: 'text', value: [] }),
    makeToolMessage('tc3', { type: 'text', value: [] })
  ]

  const spans = identifyRunSpans(messages)
  assert.equal(spans.length, 2)
  assert.deepEqual(spans[0], { startIndex: 2, endIndex: 3 })
  assert.deepEqual(spans[1], { startIndex: 5, endIndex: 7 })
})

test('identifyRunSpans returns empty for messages with no assistant/tool', () => {
  const messages: ModelMessage[] = [makeSystemMessage('system'), makeUserMessage('hello')]

  const spans = identifyRunSpans(messages)
  assert.equal(spans.length, 0)
})

test('estimateTokenCount returns a positive estimate for non-empty messages', () => {
  const messages: ModelMessage[] = [makeSystemMessage('system'), makeUserMessage('hello')]
  const estimate = estimateTokenCount(messages)
  assert.ok(estimate > 0)
})

test('estimateTokenCount includes nested tool-result output text', () => {
  const messages: ModelMessage[] = [
    makeSystemMessage('system'),
    makeUserMessage('hello'),
    makeAssistantMessage('checking'),
    makeToolMessage('tc1', makeLargeToolOutput(900_000))
  ]

  assert.ok(
    estimateTokenCount(messages) > STRIP_COMPACT_TOKEN_THRESHOLD,
    'nested tool-result text should count toward compaction threshold'
  )
})

test('applyStripCompact returns messages unchanged when under threshold', () => {
  const messages: ModelMessage[] = [
    makeSystemMessage('system'),
    makeUserMessage('hello'),
    makeAssistantMessage('hi'),
    makeToolMessage('tc1', makeLargeToolOutput(100))
  ]

  const result = applyStripCompact(messages)
  assert.deepEqual(result, messages)
})

test('applyStripCompact strips oldest run tool results when over threshold', () => {
  const messages = buildOverThresholdMessages()
  assert.ok(
    estimateTokenCount(messages) > STRIP_COMPACT_TOKEN_THRESHOLD,
    'precondition: messages should exceed threshold'
  )

  const result = applyStripCompact(messages)

  // First run's tool result should be stripped (with summary)
  const firstToolMsg = result[3] as { role: string; content: Array<{ output: unknown }> }
  assert.equal(firstToolMsg.role, 'tool')
  const firstOutput = firstToolMsg.content[0].output as { type: string; value: string }
  assert.match(firstOutput.value, /\[Stripped: read/)

  // Last run's tool result should be preserved
  const lastToolMsg = result[6] as { role: string; content: Array<{ output: unknown }> }
  assert.equal(lastToolMsg.role, 'tool')
  const lastOutput = lastToolMsg.content[0].output as {
    type: string
    value: Array<{ text: string }>
  }
  assert.equal(lastOutput.value[0].text, 'x'.repeat(500_000))
})

test('applyStripCompact preserves system and user messages', () => {
  const messages = buildOverThresholdMessages()
  const result = applyStripCompact(messages)

  assert.deepEqual(result[0], makeSystemMessage('system'))
  assert.deepEqual(result[1], makeUserMessage('q1'))
  assert.deepEqual(result[4], makeUserMessage('q2'))
})

test('applyStripCompact handles single run (no strippable spans)', () => {
  // Single large run — it's the last run, so nothing should be stripped
  const messages: ModelMessage[] = [
    makeSystemMessage('system'),
    makeUserMessage('hello'),
    makeAssistantMessage('hi'),
    makeToolMessage('tc1', makeLargeToolOutput(1_000_000))
  ]
  assert.ok(estimateTokenCount(messages) > STRIP_COMPACT_TOKEN_THRESHOLD)

  const result = applyStripCompact(messages)
  assert.deepEqual(result, messages)
})

test('applyStripCompact skips non-tool messages in run spans', () => {
  const messages = buildOverThresholdMessages()
  const result = applyStripCompact(messages)

  // Assistant text message in the first run should be preserved
  assert.deepEqual(result[2], makeAssistantMessage('a1'))
})

test('applyStripCompact stops stripping once under threshold (recent-first)', () => {
  const largeOutput = makeLargeToolOutput(500_000)
  const smallOutput = makeLargeToolOutput(100)
  const messages: ModelMessage[] = [
    makeSystemMessage('system'),
    makeUserMessage('q1'),
    makeAssistantMessage('a1'),
    makeToolMessage('tc1', smallOutput), // run 1 — small, should be preserved (oldest = cached prefix)
    makeUserMessage('q2'),
    makeAssistantMessage('a2'),
    makeToolMessage('tc2', largeOutput), // run 2 — large, stripped first (newest eligible)
    makeUserMessage('q3'),
    makeAssistantMessage('a3'),
    makeToolMessage('tc3', largeOutput) // run 3 (last — never stripped)
  ]
  assert.ok(estimateTokenCount(messages) > STRIP_COMPACT_TOKEN_THRESHOLD)

  const result = applyStripCompact(messages)

  // Run 2 stripped first (newest eligible, and large enough to bring us under threshold)
  const run2Tool = result[6] as { content: Array<{ output: { type: string; value: string } }> }
  assert.match(run2Tool.content[0].output.value, /\[Stripped: read/)

  // Run 1 should be preserved (stripping run 2 was enough, and it's the cached prefix)
  const run1Tool = result[3] as {
    content: Array<{ output: { type: string; value: Array<{ text: string }> } }>
  }
  assert.equal(run1Tool.content[0].output.value[0].text, 'x'.repeat(100))
})
