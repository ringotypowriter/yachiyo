import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
import type {
  AuxiliaryTextGenerationRequest,
  AuxiliaryTextGenerationResult
} from '../../runtime/models/auxiliaryGeneration.ts'
import { pickGroupHandoffCheckpoint, summarizeGroupProbeContext } from './groupProbeHandoff.ts'

const success = (text: string): AuxiliaryTextGenerationResult => ({
  status: 'success',
  text,
  settings: {} as ProviderSettings
})

function msg(id: string, content: string, role: 'user' | 'assistant' = 'user'): MessageRecord {
  return {
    id,
    threadId: 't',
    role,
    content,
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z'
  }
}

// ASCII content: estimateTextTokens ≈ length / 4, so 400 chars ≈ 100 tokens.
const big = (id: string, role: 'user' | 'assistant' = 'user'): MessageRecord =>
  msg(id, 'x'.repeat(400), role)

function sentReply(id: string, text: string): MessageRecord {
  return {
    ...msg(id, 'internal reasoning', 'assistant'),
    responseMessages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'send_group_message',
            input: { message: text }
          }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'send_group_message',
            output: { type: 'text', value: 'Message sent.' }
          }
        ]
      }
    ]
  }
}

test('pickGroupHandoffCheckpoint returns null when the thread is too short', () => {
  assert.equal(pickGroupHandoffCheckpoint([], 100), null)
  assert.equal(pickGroupHandoffCheckpoint([big('a')], 100), null)
})

test('pickGroupHandoffCheckpoint returns null when the whole thread fits the window', () => {
  assert.equal(pickGroupHandoffCheckpoint([big('a'), big('b')], 10_000), null)
})

test('pickGroupHandoffCheckpoint keeps ~one window after the checkpoint', () => {
  const checkpoint = pickGroupHandoffCheckpoint([big('a'), big('b'), big('c'), big('d')], 100)
  assert.equal(checkpoint, 'c')
})

test('pickGroupHandoffCheckpoint snaps the boundary so the kept tail starts with a user delta', () => {
  // Alternating turns; a window boundary that lands on an assistant reply must
  // move older so the reply keeps the user delta it answered.
  const messages = [
    big('u1', 'user'),
    big('a1', 'assistant'),
    big('u2', 'user'),
    big('a2', 'assistant')
  ]
  const checkpoint = pickGroupHandoffCheckpoint(messages, 100)
  // Boundary lands on a2 (assistant) → snap older to u2, watermark = a1.
  assert.equal(checkpoint, 'a1')
  // Everything after 'a1' is [u2, a2] — starts with a user delta.
})

interface FakeStorage {
  getThread(id: string): ThreadRecord | undefined
  listThreadMessages(id: string): MessageRecord[]
  updateThread(thread: ThreadRecord): void
  updated: ThreadRecord[]
}

function fakeStorage(thread: ThreadRecord, messages: MessageRecord[]): FakeStorage {
  const updated: ThreadRecord[] = []
  return {
    updated,
    getThread: () => thread,
    listThreadMessages: () => messages,
    updateThread: (next) => updated.push(next)
  }
}

const baseThread = { id: 't', title: 'g [group probe]' } as unknown as ThreadRecord

test('summarizeGroupProbeContext writes summary + advances watermark to the checkpoint', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b'), big('c'), big('d')])
  const auxService = { generateText: async () => success('  previously in the group…  ') }

  const outcome = await summarizeGroupProbeContext({
    storage,
    auxService,
    threadId: 't',
    recentWindowTokens: 100,
    handoffThresholdTokens: 100,
    groupName: '杂鱼村',
    now: () => '2026-07-01T00:00:00Z'
  })

  assert.equal(outcome, 'summarized')
  assert.equal(storage.updated.length, 1)
  assert.equal(storage.updated[0]?.contextHandoffSummary, 'previously in the group…')
  assert.equal(storage.updated[0]?.contextHandoffWatermarkMessageId, 'c')
})

test('summarizeGroupProbeContext includes Yachiyo sent replies (from responseMessages) in the transcript', async () => {
  const storage = fakeStorage(baseThread, [
    big('u1', 'user'),
    sentReply('a1', 'GN everyone, going offline'),
    big('u2', 'user'),
    big('u3', 'user')
  ])
  let captured: AuxiliaryTextGenerationRequest | undefined
  const auxService = {
    generateText: async (request: AuxiliaryTextGenerationRequest) => {
      captured = request
      return success('SUMMARY')
    }
  }

  const outcome = await summarizeGroupProbeContext({
    storage,
    auxService,
    threadId: 't',
    recentWindowTokens: 100,
    handoffThresholdTokens: 100,
    groupName: '杂鱼村'
  })

  assert.equal(outcome, 'summarized')
  const userPrompt = captured?.messages.find((m) => m.role === 'user')?.content
  assert.equal(typeof userPrompt, 'string')
  assert.match(userPrompt as string, /Yachiyo: GN everyone, going offline/)
})

test('summarizeGroupProbeContext skips when raw transcript is below the handoff threshold', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b'), big('c'), big('d')])
  let called = false
  const auxService = {
    generateText: async () => {
      called = true
      return success('x')
    }
  }

  const outcome = await summarizeGroupProbeContext({
    storage,
    auxService,
    threadId: 't',
    recentWindowTokens: 100,
    handoffThresholdTokens: 100_000, // raw ≈ 400 tokens, far below
    groupName: '杂鱼村'
  })

  assert.equal(outcome, 'skipped')
  assert.equal(called, false)
  assert.equal(storage.updated.length, 0)
})

test('summarizeGroupProbeContext skips when there is nothing worth compressing', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b')])
  const auxService = { generateText: async () => success('x') }

  const outcome = await summarizeGroupProbeContext({
    storage,
    auxService,
    threadId: 't',
    recentWindowTokens: 10_000,
    handoffThresholdTokens: 100,
    groupName: '杂鱼村'
  })

  assert.equal(outcome, 'skipped')
  assert.equal(storage.updated.length, 0)
})

test('summarizeGroupProbeContext skips when generation is unavailable', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b'), big('c'), big('d')])
  const auxService = {
    generateText: async () => ({ status: 'unavailable' as const, reason: 'missing-model' as const })
  }

  const outcome = await summarizeGroupProbeContext({
    storage,
    auxService,
    threadId: 't',
    recentWindowTokens: 100,
    handoffThresholdTokens: 100,
    groupName: '杂鱼村'
  })

  assert.equal(outcome, 'skipped')
  assert.equal(storage.updated.length, 0)
})
