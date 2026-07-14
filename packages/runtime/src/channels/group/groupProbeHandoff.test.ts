import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
import type {
  AuxiliaryTextGenerationRequest,
  AuxiliaryTextGenerationResult
} from '../../runtime/models/auxiliaryGeneration.ts'
import {
  pickGroupHandoffCheckpoint,
  summarizeGroupProbeContext,
  type SummarizeGroupProbeContextInput
} from './groupProbeHandoff.ts'

type ProposedHandoffOutcome =
  | { status: 'summarized'; checkpointId: string }
  | {
      status: 'skipped'
      reason:
        | 'below-prompt-threshold'
        | 'generation-unavailable'
        | 'no-checkpoint'
        | 'prompt-usage-unavailable'
        | 'thread-changed'
    }

type ProposedHandoffInput = Omit<SummarizeGroupProbeContextInput, 'recentWindowTokens'> & {
  promptTokens?: number
}

const pickCheckpoint = pickGroupHandoffCheckpoint as unknown as (
  messages: MessageRecord[]
) => string | null
const summarizeContext = summarizeGroupProbeContext as unknown as (
  input: ProposedHandoffInput
) => Promise<ProposedHandoffOutcome>

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
  assert.equal(pickCheckpoint([]), null)
  assert.equal(pickCheckpoint([big('a')]), null)
})

test('pickGroupHandoffCheckpoint keeps the newest half of complete turns', () => {
  const checkpoint = pickCheckpoint([big('a'), big('b'), big('c'), big('d')])
  assert.equal(checkpoint, 'b')
})

test('pickGroupHandoffCheckpoint snaps the boundary so the kept tail starts with a user delta', () => {
  const messages = [
    big('u1', 'user'),
    big('a1', 'assistant'),
    big('u2', 'user'),
    big('a2', 'assistant')
  ]
  assert.equal(pickCheckpoint(messages), 'a1')
})

test('pickGroupHandoffCheckpoint keeps the larger half when the turn count is odd', () => {
  const messages = [big('a'), big('b'), big('c'), big('d'), big('e')]
  assert.equal(pickCheckpoint(messages), 'b')
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

test('summarizeGroupProbeContext writes summary + advances the watermark', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b'), big('c'), big('d')])
  const auxService = { generateText: async () => success('  previously in the group…  ') }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 100,
    handoffThresholdTokens: 100,
    groupName: 'group',
    now: () => '2026-07-01T00:00:00Z'
  })

  assert.deepEqual(outcome, { status: 'summarized', checkpointId: 'b' })
  assert.equal(storage.updated.length, 1)
  assert.equal(storage.updated[0]?.contextHandoffSummary, 'previously in the group…')
  assert.equal(storage.updated[0]?.contextHandoffWatermarkMessageId, 'b')
})

test('summarizeGroupProbeContext includes Yachiyo sent replies (from responseMessages) in the transcript', async () => {
  const storage = fakeStorage(baseThread, [
    big('u1', 'user'),
    sentReply('a1', 'GN everyone, going offline'),
    big('u2', 'user'),
    big('u3', 'user'),
    big('u4', 'user'),
    big('u5', 'user')
  ])
  let captured: AuxiliaryTextGenerationRequest | undefined
  const auxService = {
    generateText: async (request: AuxiliaryTextGenerationRequest) => {
      captured = request
      return success('SUMMARY')
    }
  }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 100,
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.equal(outcome.status, 'summarized')
  const userPrompt = captured?.messages.find((m) => m.role === 'user')?.content
  assert.equal(typeof userPrompt, 'string')
  assert.match(userPrompt as string, /Yachiyo: GN everyone, going offline/)
})

test('summarizeGroupProbeContext trusts provider prompt usage instead of transcript size guesses', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b'), big('c'), big('d')])
  let called = false
  const auxService = {
    generateText: async () => {
      called = true
      return success('x')
    }
  }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 99,
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.deepEqual(outcome, { status: 'skipped', reason: 'below-prompt-threshold' })
  assert.equal(called, false)
  assert.equal(storage.updated.length, 0)
})

test('summarizeGroupProbeContext compacts a provider-reported large prompt even when text is short', async () => {
  const storage = fakeStorage(baseThread, [msg('a', 'x'), msg('b', 'y')])
  const auxService = { generateText: async () => success('x') }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 100,
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.deepEqual(outcome, { status: 'summarized', checkpointId: 'a' })
  assert.equal(storage.updated[0]?.contextHandoffWatermarkMessageId, 'a')
})

test('summarizeGroupProbeContext skips explicitly when provider usage is unavailable', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b')])
  const auxService = { generateText: async () => success('x') }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.deepEqual(outcome, { status: 'skipped', reason: 'prompt-usage-unavailable' })
  assert.equal(storage.updated.length, 0)
})

test('summarizeGroupProbeContext reports when there is no complete older turn to compact', async () => {
  const storage = fakeStorage(baseThread, [big('a')])
  const auxService = { generateText: async () => success('x') }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 100,
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.deepEqual(outcome, { status: 'skipped', reason: 'no-checkpoint' })
  assert.equal(storage.updated.length, 0)
})

test('summarizeGroupProbeContext skips the write when history is cleared mid-summary', async () => {
  const messages = [big('a'), big('b'), big('c'), big('d')]
  const updated: ThreadRecord[] = []
  let cleared = false
  const storage: FakeStorage = {
    updated,
    getThread: () => baseThread,
    listThreadMessages: () => (cleared ? [] : messages),
    updateThread: (next) => updated.push(next)
  }
  const auxService = {
    generateText: async () => {
      // Simulate the user clearing the group history while the model runs.
      cleared = true
      return success('SUMMARY of now-deleted history')
    }
  }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 100,
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.deepEqual(outcome, { status: 'skipped', reason: 'thread-changed' })
  assert.equal(updated.length, 0)
})

test('summarizeGroupProbeContext skips when generation is unavailable', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b'), big('c'), big('d')])
  const auxService = {
    generateText: async () => ({ status: 'unavailable' as const, reason: 'missing-model' as const })
  }

  const outcome = await summarizeContext({
    storage,
    auxService,
    threadId: 't',
    promptTokens: 100,
    handoffThresholdTokens: 100,
    groupName: 'group'
  })

  assert.deepEqual(outcome, { status: 'skipped', reason: 'generation-unavailable' })
  assert.equal(storage.updated.length, 0)
})
