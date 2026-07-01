import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
import type { AuxiliaryTextGenerationResult } from '../../runtime/models/auxiliaryGeneration.ts'
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
const big = (id: string): MessageRecord => msg(id, 'x'.repeat(400))

test('pickGroupHandoffCheckpoint returns null when the thread is too short', () => {
  assert.equal(pickGroupHandoffCheckpoint([], 100), null)
  assert.equal(pickGroupHandoffCheckpoint([big('a')], 100), null)
})

test('pickGroupHandoffCheckpoint returns null when the whole thread fits the window', () => {
  assert.equal(pickGroupHandoffCheckpoint([big('a'), big('b')], 10_000), null)
})

test('pickGroupHandoffCheckpoint leaves roughly one window after the checkpoint', () => {
  // 4 turns ≈ 100 tokens each, window 100 → keep the newest turn after the
  // checkpoint, summarize the rest. Checkpoint is the message just before it.
  const checkpoint = pickGroupHandoffCheckpoint([big('a'), big('b'), big('c'), big('d')], 100)
  assert.equal(checkpoint, 'c')
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
  const messages = [big('a'), big('b'), big('c'), big('d')]
  const storage = fakeStorage(baseThread, messages)
  const auxService = {
    generateText: async () => success('  previously in the group…  ')
  }

  const outcome = await summarizeGroupProbeContext({
    storage,
    auxService,
    threadId: 't',
    recentWindowTokens: 100,
    groupName: '杂鱼村',
    now: () => '2026-07-01T00:00:00Z'
  })

  assert.equal(outcome, 'summarized')
  assert.equal(storage.updated.length, 1)
  assert.equal(storage.updated[0]?.contextHandoffSummary, 'previously in the group…')
  assert.equal(storage.updated[0]?.contextHandoffWatermarkMessageId, 'c')
})

test('summarizeGroupProbeContext skips when there is nothing worth compressing', async () => {
  const storage = fakeStorage(baseThread, [big('a'), big('b')])
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
    recentWindowTokens: 10_000,
    groupName: '杂鱼村'
  })

  assert.equal(outcome, 'skipped')
  assert.equal(called, false)
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
    groupName: '杂鱼村'
  })

  assert.equal(outcome, 'skipped')
  assert.equal(storage.updated.length, 0)
})
