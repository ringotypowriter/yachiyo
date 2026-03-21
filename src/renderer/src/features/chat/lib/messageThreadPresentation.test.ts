import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMessageGroups,
  getVisibleToolCallsForGroup,
  partitionToolCallsForGroups
} from './messageThreadPresentation.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

test('buildMessageGroups keeps retry replies under the same user request anchor', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-2'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      },
      {
        id: 'assistant-retry',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.equal(groups[0]?.activeBranchIndex, 0)
  assert.deepEqual(
    groups[0]?.assistantBranches.map((branch) => ({
      id: branch.message.id,
      isActive: branch.isActive
    })),
    [
      { id: 'assistant-1', isActive: true },
      { id: 'assistant-retry', isActive: false }
    ]
  )
  assert.equal(groups[1]?.userMessage.id, 'user-2')
  assert.deepEqual(
    groups[1]?.assistantBranches.map((branch) => branch.message.id),
    ['assistant-2']
  )
})

test('buildMessageGroups shows a preparing slot on the retried historical request before the first token arrives', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-1'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    runPhase: 'preparing',
    activeRequestMessageId: 'user-1'
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.showPreparing, true)
  assert.equal(groups[0]?.activeBranchIndex, 0)
  assert.equal(groups[0]?.hideActiveBranchWhilePreparing, true)
})

test('buildMessageGroups hides downstream messages while a historical retry is preparing', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-2'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      }
    ],
    runPhase: 'preparing',
    activeRequestMessageId: 'user-1'
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.equal(groups[0]?.showPreparing, true)
  assert.equal(groups[0]?.hideActiveBranchWhilePreparing, true)
})

test('buildMessageGroups treats the newest assistant branch as active while a retry is streaming', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-2'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      },
      {
        id: 'assistant-retry',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry answer',
        status: 'streaming',
        createdAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'streaming',
    activeRequestMessageId: 'user-1'
  })

  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.activeBranchIndex, 1)
  assert.deepEqual(
    groups[0]?.assistantBranches.map((branch) => ({
      id: branch.message.id,
      isActive: branch.isActive
    })),
    [
      { id: 'assistant-1', isActive: false },
      { id: 'assistant-retry', isActive: true }
    ]
  )
})

test('buildMessageGroups keeps a steer user visible while an active run restarts on a consecutive user path', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: '2026-03-15T00:00:02.000Z',
      headMessageId: 'user-steer'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Original request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'user-steer',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'user-1',
        content: 'Use the screenshot instead',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    runPhase: 'preparing',
    activeRequestMessageId: 'user-steer'
  })

  assert.deepEqual(
    groups.map((group) => ({
      hideActiveBranchWhilePreparing: group.hideActiveBranchWhilePreparing,
      showPreparing: group.showPreparing
    })),
    [
      {
        hideActiveBranchWhilePreparing: false,
        showPreparing: false
      },
      {
        hideActiveBranchWhilePreparing: false,
        showPreparing: true
      }
    ]
  )
})

test('getVisibleToolCallsForGroup keeps tool calls with the active branch and hides inactive completed branches', () => {
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-1'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    toolCalls: [
      {
        id: 'tool-branchless',
        runId: 'run-branchless',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'failed',
        inputSummary: 'draft.txt',
        requestMessageId: 'user-1',
        startedAt: '2026-03-15T00:00:00.500Z'
      },
      {
        id: 'tool-active',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: 'answer.txt',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        startedAt: '2026-03-15T00:00:01.500Z'
      },
      {
        id: 'tool-hidden',
        runId: 'run-2',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'pwd',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-2',
        startedAt: '2026-03-15T00:00:02.500Z'
      },
      {
        id: 'tool-other-request',
        runId: 'run-3',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'notes.txt',
        requestMessageId: 'user-2',
        startedAt: '2026-03-15T00:00:03.000Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ['tool-branchless', 'tool-active']
  )
})

test('getVisibleToolCallsForGroup keeps failed branch tool calls visible even when an older reply stays active', () => {
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-1'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'assistant-failed',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: '',
        status: 'failed',
        createdAt: '2026-03-15T00:00:02.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    toolCalls: [
      {
        id: 'tool-failed-1',
        runId: 'run-failed',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'failed',
        inputSummary: 'try.txt',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-failed',
        startedAt: '2026-03-15T00:00:02.100Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ['tool-failed-1']
  )
})

test('partitionToolCallsForGroups hides anchored tool calls that belong to hidden downstream requests', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-retry'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'First question',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-1',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'First answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'user-2',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-1',
        content: 'Second question',
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-2',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-2',
        content: 'Second answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      },
      {
        id: 'assistant-retry',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Retry answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:04.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  const { inlineToolCalls, orphanToolCalls } = partitionToolCallsForGroups({
    groups,
    toolCalls: [
      {
        id: 'tool-visible',
        runId: 'run-visible',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'a.txt',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-retry',
        startedAt: '2026-03-15T00:00:04.100Z'
      },
      {
        id: 'tool-hidden',
        runId: 'run-hidden',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'pwd',
        requestMessageId: 'user-2',
        assistantMessageId: 'assistant-2',
        startedAt: '2026-03-15T00:00:03.100Z'
      },
      {
        id: 'tool-legacy',
        runId: 'run-legacy',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'failed',
        inputSummary: 'try.txt',
        startedAt: '2026-03-15T00:00:05.000Z'
      }
    ]
  })

  assert.deepEqual(
    inlineToolCalls.map((toolCall) => toolCall.id),
    ['tool-visible']
  )
  assert.deepEqual(
    orphanToolCalls.map((toolCall) => toolCall.id),
    ['tool-legacy']
  )
})
