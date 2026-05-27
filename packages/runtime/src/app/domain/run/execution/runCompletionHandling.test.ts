import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ProviderSettings, ThreadRecord } from '@yachiyo/shared/protocol'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import { createRunToolLifecycleState } from './runToolLifecycleState.ts'
import type { RunExecutionDeps } from './runExecutionTypes.ts'
import { handleCompletedRun } from './runCompletionHandling.ts'

function createPerfCollector(): RunPerfCollector {
  return {
    recordContextPreparation: () => {},
    recordModelStream: () => {},
    recordFirstTextDelta: () => {},
    recordFirstReasoningDelta: () => {},
    recordCheckpointWrite: () => {},
    recordToolCallWrite: () => {},
    recordSnapshotFinalize: () => {},
    recordDeltaEvent: () => {},
    recordReasoningDeltaEvent: () => {},
    addTextChars: () => {},
    finish: () => {}
  }
}

test('completed run preview uses the last assistant text block', async () => {
  const thread: ThreadRecord = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: '2026-05-18T00:00:00.000Z'
  }
  const completedThreads: ThreadRecord[] = []
  const completedMessages: MessageRecord[] = []
  const deps = {
    timestamp: () => '2026-05-18T00:00:02.000Z',
    readThread: () => thread,
    loadThreadToolCalls: () => [],
    emit: () => {},
    storage: {
      completeRun: (input: { updatedThread: ThreadRecord; assistantMessage: MessageRecord }) => {
        completedThreads.push(input.updatedThread)
        completedMessages.push(input.assistantMessage)
      }
    }
  } as unknown as RunExecutionDeps
  const settings: ProviderSettings = {
    providerName: 'test',
    provider: 'openai',
    model: 'test-model',
    apiKey: 'test-key',
    baseUrl: 'https://example.test'
  }

  await handleCompletedRun({
    bindCurrentRunToolCallsToAssistant: () => {},
    deps,
    executionInput: {
      enabledTools: [],
      runMode: 'auto',
      runTrigger: 'local',
      inactivityTimeoutMs: 0,
      runId: 'run-1',
      thread,
      requestMessageId: 'message-user',
      abortController: new AbortController(),
      updateHeadOnComplete: true,
      previousEnabledTools: null,
      previousRunMode: null
    },
    getOutputSnapshot: () => ({
      content: 'First block\nSecond block',
      textBlocks: [
        { id: 'block-1', content: 'First block', createdAt: '2026-05-18T00:00:01.000Z' },
        { id: 'block-2', content: 'Second block', createdAt: '2026-05-18T00:00:02.000Z' }
      ],
      recoveryResponseMessages: []
    }),
    lastUsage: undefined,
    messageId: 'message-assistant',
    perfCollector: createPerfCollector(),
    recoveredFromCheckpoint: false,
    settings,
    snapshotTracker: null,
    toolLifecycle: createRunToolLifecycleState({ initialToolCalls: new Map() })
  })

  assert.equal(completedThreads[0]?.preview, 'Second block')
  assert.equal(completedMessages[0]?.content, 'First block\nSecond block')
})
