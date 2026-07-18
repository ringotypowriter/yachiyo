import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolCallRecord } from '@yachiyo/shared/protocol'
import { canBranchFromAskUserToolCall } from './askUserBranchAction.ts'

function askUserToolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'call-ask',
    threadId: 'thread-1',
    assistantMessageId: 'msg-assistant',
    toolName: 'askUser',
    status: 'completed',
    inputSummary: 'Which DB?',
    details: { kind: 'askUser', question: 'Which DB?', answer: 'sqlite' },
    startedAt: '2026-07-18T00:00:00.000Z',
    ...overrides
  }
}

test('allows a completed askUser call bound to an assistant message', () => {
  assert.equal(canBranchFromAskUserToolCall(askUserToolCall()), true)
})

test('rejects other tools, unfinished calls, and unbound calls', () => {
  assert.equal(canBranchFromAskUserToolCall(askUserToolCall({ toolName: 'readFile' })), false)
  assert.equal(canBranchFromAskUserToolCall(askUserToolCall({ status: 'waiting-for-user' })), false)
  assert.equal(
    canBranchFromAskUserToolCall(askUserToolCall({ assistantMessageId: undefined })),
    false
  )
  assert.equal(canBranchFromAskUserToolCall(askUserToolCall({ details: undefined })), false)
})
