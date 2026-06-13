import assert from 'node:assert/strict'
import test from 'node:test'

import {
  toRunRecoveryCheckpoint,
  toStoredRunRecoveryCheckpointRow,
  toThreadRecord
} from './storage.ts'

test('thread conversion preserves composer tool mode', () => {
  const thread = toThreadRecord({
    archivedAt: null,
    starredAt: null,
    branchFromMessageId: null,
    branchFromThreadId: null,
    handoffFromThreadId: null,
    folderId: null,
    colorTag: null,
    headMessageId: null,
    icon: null,
    id: 'thread-1',
    memoryRecallState: null,
    modelOverride: null,
    preview: null,
    privacyMode: null,
    enabledTools: '["read"]',
    runMode: 'explore',
    reasoningEffort: null,
    source: 'local',
    channelUserId: null,
    channelGroupId: null,
    contextHandoffSummary: null,
    contextHandoffWatermarkMessageId: null,
    readAt: null,
    createdFromEssentialId: null,
    createdFromScheduleId: null,
    runtimeBinding: null,
    lastDelegatedSession: null,
    todoItems: null,
    recapText: null,
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z',
    workspacePath: null
  })

  assert.deepEqual(thread.enabledTools, ['read'])
  assert.equal(thread.runMode, 'explore')
})

test('thread conversion preserves composer reasoning effort', () => {
  const thread = toThreadRecord({
    archivedAt: null,
    starredAt: null,
    branchFromMessageId: null,
    branchFromThreadId: null,
    handoffFromThreadId: null,
    folderId: null,
    colorTag: null,
    headMessageId: null,
    icon: null,
    id: 'thread-1',
    memoryRecallState: null,
    modelOverride: null,
    preview: null,
    privacyMode: null,
    enabledTools: null,
    runMode: null,
    reasoningEffort: 'high',
    source: 'local',
    channelUserId: null,
    channelGroupId: null,
    contextHandoffSummary: null,
    contextHandoffWatermarkMessageId: null,
    readAt: null,
    createdFromEssentialId: null,
    createdFromScheduleId: null,
    runtimeBinding: null,
    lastDelegatedSession: null,
    todoItems: null,
    recapText: null,
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z',
    workspacePath: null
  })

  assert.equal(thread.reasoningEffort, 'high')
})

test('run recovery checkpoint conversion preserves reasoning effort', () => {
  const checkpoint = toRunRecoveryCheckpoint({
    runId: 'run-1',
    threadId: 'thread-1',
    requestMessageId: 'user-1',
    assistantMessageId: 'assistant-1',
    content: 'partial',
    textBlocks: null,
    reasoning: null,
    responseMessages: null,
    enabledTools: '["read"]',
    enabledSkillNames: null,
    runMode: 'custom',
    reasoningEffort: 'off',
    runTrigger: 'channel',
    channelHint: null,
    updateHeadOnComplete: '1',
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    recoveryAttempts: 1,
    lastError: null
  })

  assert.equal(checkpoint.reasoningEffort, 'off')
  assert.equal(checkpoint.runMode, 'custom')
  assert.equal(checkpoint.runTrigger, 'channel')
  assert.equal(toStoredRunRecoveryCheckpointRow({ ...checkpoint, runMode: 'chat' }).runMode, 'chat')
  assert.equal(
    toStoredRunRecoveryCheckpointRow({ ...checkpoint, reasoningEffort: 'high' }).reasoningEffort,
    'high'
  )
  assert.equal(
    toStoredRunRecoveryCheckpointRow({ ...checkpoint, runTrigger: 'local' }).runTrigger,
    'local'
  )
})
