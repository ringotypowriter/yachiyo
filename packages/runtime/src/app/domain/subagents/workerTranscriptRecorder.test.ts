import assert from 'node:assert/strict'
import test from 'node:test'
import type { ThreadRecord } from '@yachiyo/shared/protocol'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { SubagentTurnError } from './subagentManager.ts'
import { createWorkerTranscriptRecorder } from './workerTranscriptRecorder.ts'

const at = '2026-10-26T00:00:00.000Z'

function fixture(overrides: Partial<ThreadRecord> = {}): {
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
  thread: ThreadRecord
  recorder: ReturnType<typeof createWorkerTranscriptRecorder>
} {
  const storage = createInMemoryYachiyoStorage()
  const thread: ThreadRecord = { id: 'parent', title: 'Task', updatedAt: at, ...overrides }
  storage.createThread({ thread, createdAt: at })
  storage.startRun({ runId: 'run', thread, updatedThread: thread, createdAt: at })
  const recorder = createWorkerTranscriptRecorder({
    storage,
    launch: {
      agentId: 'agent',
      parentThreadId: thread.id,
      launchRunId: 'run',
      agentName: 'explore',
      agentType: 'explore',
      codeName: 'Akari',
      workspacePath: '/project',
      prompt: 'Inspect'
    },
    turn: { turnId: 'turn', messages: [], signal: new AbortController().signal },
    modelId: 'test',
    timestamp: () => at
  })
  return { storage, thread, recorder }
}

test('worker evidence keeps live tool inputs, replaces partial output, and survives compaction', () => {
  const { storage, recorder } = fixture()
  recorder.append([{ role: 'user', content: 'Inspect' }])
  const response = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call',
          toolName: 'bash',
          input: { command: 'obelisk --query /tmp/nonce.js' }
        }
      ]
    }
  ]
  recorder.update(response)
  assert.match(JSON.stringify(storage.listWorkerTranscriptTurns('parent')), /nonce\.js/)
  recorder.commit(response)
  response[0]!.content[0]!.input.command = 'mutated prompt history'
  recorder.append([{ role: 'user', content: 'Mailbox update' }], true)
  recorder.compact({ summary: 'Summary', promptTokens: 2, completionTokens: 1 })
  recorder.finish({ output: 'Done', promptTokens: 20, completionTokens: 5 })
  const [saved] = storage.listWorkerTranscriptTurns('parent')
  assert.equal(saved!.messages.length, 3)
  assert.match(JSON.stringify(saved!.messages), /nonce\.js/)
  assert.equal(saved!.messages[2]!.isMeta, true)
  assert.equal(saved!.status, 'completed')
  assert.equal(saved!.promptTokens, 20)
  saved!.messages.length = 0
  assert.equal(storage.listWorkerTranscriptTurns('parent')[0]!.messages.length, 3)
})

test('failed workers retain usage and detached running workers are recovered on restart', () => {
  const { storage, thread, recorder } = fixture()
  recorder.append([{ role: 'user', content: 'Inspect' }])
  storage.completeRun({
    runId: 'run',
    updatedThread: thread,
    assistantMessage: {
      id: 'reply',
      threadId: thread.id,
      role: 'assistant',
      content: 'Worker is running',
      status: 'completed',
      createdAt: at
    }
  })
  storage.recoverInterruptedRuns({ finishedAt: at, error: 'Runtime stopped' })
  assert.equal(storage.listWorkerTranscriptTurns('parent')[0]!.status, 'failed')
  recorder.fail(
    new SubagentTurnError(new Error('Interrupted'), { promptTokens: 12, completionTokens: 4 }),
    true
  )
  const [saved] = storage.listWorkerTranscriptTurns('parent')
  assert.equal(saved!.status, 'cancelled')
  assert.equal(saved!.promptTokens, 12)
  assert.equal(saved!.error, 'Interrupted')
})

for (const action of ['delete', 'reset', 'resetMany'] as const) {
  test(`worker evidence follows parent ${action} and rejects late writes`, () => {
    const { storage, recorder } = fixture()
    recorder.append([{ role: 'user', content: 'Inspect' }])
    assert.equal(storage.listWorkerTranscriptTurns('parent').length, 1)
    if (action === 'delete') storage.deleteThread({ threadId: 'parent' })
    if (action === 'reset') storage.resetThreadHistory({ threadId: 'parent', updatedAt: at })
    if (action === 'resetMany')
      storage.resetThreadsHistory({ threadIds: ['parent'], updatedAt: at })
    recorder.finish({ output: 'Too late' })
    assert.deepEqual(storage.listWorkerTranscriptTurns('parent'), [])
  })
}

test('private and guest channel worker transcripts are not persisted', () => {
  for (const overrides of [
    { privacyMode: true },
    { source: 'telegram', channelUserId: 'guest' }
  ] as Partial<ThreadRecord>[]) {
    const { storage, recorder } = fixture(overrides)
    recorder.append([{ role: 'user', content: 'Private content' }])
    assert.deepEqual(storage.listWorkerTranscriptTurns('parent'), [])
  }
})
