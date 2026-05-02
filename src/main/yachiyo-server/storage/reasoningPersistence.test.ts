import assert from 'node:assert/strict'
import test from 'node:test'

import {
  toRunRecoveryCheckpoint,
  toStoredRunRecoveryCheckpointRow,
  toThreadRecord
} from './storage.ts'

test('thread conversion preserves queued follow-up reasoning effort', () => {
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
    queuedFollowUpEnabledTools: '["read"]',
    queuedFollowUpEnabledSkillNames: '["workspace-refactor"]',
    queuedFollowUpMessageId: 'user-follow-up',
    queuedFollowUpReasoningEffort: 'high',
    source: 'local',
    channelUserId: null,
    channelGroupId: null,
    rollingSummary: null,
    summaryWatermarkMessageId: null,
    readAt: null,
    createdFromEssentialId: null,
    createdFromScheduleId: null,
    runtimeBinding: null,
    lastDelegatedSession: null,
    recapText: null,
    title: 'Thread',
    updatedAt: '2026-05-02T00:00:00.000Z',
    workspacePath: null
  })

  assert.equal(thread.queuedFollowUpReasoningEffort, 'high')
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
    reasoningEffort: 'off',
    channelHint: null,
    updateHeadOnComplete: '1',
    createdAt: '2026-05-02T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:01.000Z',
    recoveryAttempts: 1,
    lastError: null
  })

  assert.equal(checkpoint.reasoningEffort, 'off')
  assert.equal(
    toStoredRunRecoveryCheckpointRow({ ...checkpoint, reasoningEffort: 'high' }).reasoningEffort,
    'high'
  )
})
