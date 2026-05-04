import assert from 'node:assert/strict'
import test from 'node:test'

import { createRunPerfCollector, getPerfMonitor, stopPerfMonitor } from './perfMonitor.ts'

test('run perf collector records detailed stage timings and context metrics', () => {
  stopPerfMonitor()

  try {
    const collector = createRunPerfCollector('run-perf-1')
    collector.recordContextPreparation(12.345, {
      activeSkillCount: 2,
      availableSkillCount: 5,
      fileMentionCount: 3,
      inlinedFileCount: 1,
      memoryEntryCount: 4,
      messageCount: 9
    })
    collector.recordModelStream(98.765)
    collector.recordFirstTextDelta(7.777)
    collector.recordFirstTextDelta(11.111)
    collector.recordFirstReasoningDelta(8.888)
    collector.recordCheckpointWrite(1.111)
    collector.recordCheckpointWrite(3.333)
    collector.recordToolCallWrite(2.222)
    collector.recordToolCallWrite(6.666)
    collector.recordSnapshotFinalize(4.444)
    collector.recordSnapshotFinalize(5.555)
    collector.recordDeltaEvent()
    collector.recordReasoningDeltaEvent()
    collector.addTextChars(42)
    collector.finish('thread-perf-1')

    const record = getPerfMonitor().getStats().recentRuns[0]
    assert.ok(record)
    assert.equal(record.runId, 'run-perf-1')
    assert.equal(record.threadId, 'thread-perf-1')
    assert.equal(record.contextPrepareMs, 12.35)
    assert.equal(record.contextMessageCount, 9)
    assert.equal(record.activeSkillCount, 2)
    assert.equal(record.availableSkillCount, 5)
    assert.equal(record.memoryEntryCount, 4)
    assert.equal(record.fileMentionCount, 3)
    assert.equal(record.inlinedFileCount, 1)
    assert.equal(record.modelStreamMs, 98.77)
    assert.equal(record.firstTextDeltaMs, 7.78)
    assert.equal(record.firstReasoningDeltaMs, 8.89)
    assert.equal(record.checkpointWriteCount, 2)
    assert.equal(record.checkpointWriteTotalMs, 4.44)
    assert.equal(record.checkpointWriteMaxMs, 3.33)
    assert.equal(record.toolCallWriteCount, 2)
    assert.equal(record.toolCallWriteTotalMs, 8.89)
    assert.equal(record.toolCallWriteMaxMs, 6.67)
    assert.equal(record.snapshotFinalizeCount, 2)
    assert.equal(record.snapshotFinalizeTotalMs, 10)
    assert.equal(record.snapshotFinalizeMaxMs, 5.56)
    assert.equal(record.deltaEventCount, 1)
    assert.equal(record.reasoningDeltaEventCount, 1)
    assert.equal(record.textCharsStreamed, 42)
  } finally {
    stopPerfMonitor()
  }
})
