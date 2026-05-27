import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildMessageGroups,
  getQueuedFollowUpMessage,
  getRootAssistantMessages,
  getTimelineMessages,
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

test('getRootAssistantMessages returns assistant-first messages in timeline order', () => {
  const messages = getRootAssistantMessages([
    {
      id: 'assistant-2',
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Second handoff chunk',
      status: 'streaming',
      createdAt: '2026-03-15T00:00:02.000Z'
    },
    {
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user',
      content: 'Later follow-up',
      status: 'completed',
      createdAt: '2026-03-15T00:00:03.000Z'
    },
    {
      id: 'assistant-1',
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Initial handoff',
      status: 'completed',
      createdAt: TIMESTAMP
    },
    {
      id: 'assistant-child',
      threadId: 'thread-1',
      role: 'assistant',
      parentMessageId: 'user-1',
      content: 'Ordinary reply',
      status: 'completed',
      createdAt: '2026-03-15T00:00:04.000Z'
    }
  ])

  assert.deepEqual(
    messages.map((message) => message.id),
    ['assistant-1', 'assistant-2']
  )
})

test('getTimelineMessages excludes a queued follow-up until the thread starts that run', () => {
  const messages = [
    {
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user' as const,
      content: 'Original request',
      status: 'completed' as const,
      createdAt: TIMESTAMP
    },
    {
      id: 'user-follow-up',
      threadId: 'thread-1',
      role: 'user' as const,
      parentMessageId: 'user-1',
      content: 'Queued follow-up',
      status: 'completed' as const,
      createdAt: '2026-03-15T00:00:01.000Z'
    },
    {
      id: 'background-note',
      threadId: 'thread-1',
      role: 'assistant' as const,
      content: 'Background task finished',
      status: 'completed' as const,
      createdAt: '2026-03-15T00:00:02.000Z'
    }
  ]

  const queuedThread = {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: TIMESTAMP,
    headMessageId: 'user-1',
    queuedFollowUpMessageId: 'user-follow-up'
  }

  assert.deepEqual(
    getTimelineMessages({ thread: queuedThread, messages }).map((message) => message.id),
    ['user-1', 'background-note']
  )
  assert.equal(getQueuedFollowUpMessage({ thread: queuedThread, messages })?.id, 'user-follow-up')

  assert.deepEqual(
    getTimelineMessages({
      thread: {
        id: 'thread-1',
        title: 'Thread',
        updatedAt: TIMESTAMP,
        headMessageId: 'user-follow-up'
      },
      messages
    }).map((message) => message.id),
    ['user-1', 'user-follow-up', 'background-note']
  )
})

test('getTimelineMessages preserves hidden path records for visible grouping', () => {
  const messages = [
    {
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user' as const,
      content: 'Visible request',
      status: 'completed' as const,
      createdAt: TIMESTAMP
    },
    {
      id: 'assistant-before-hidden',
      threadId: 'thread-1',
      role: 'assistant' as const,
      parentMessageId: 'user-1',
      content: 'Initial visible answer',
      status: 'completed' as const,
      createdAt: '2026-03-15T00:00:01.000Z'
    },
    {
      id: 'hidden-background-notice',
      threadId: 'thread-1',
      role: 'user' as const,
      parentMessageId: 'assistant-before-hidden',
      content: '[Background task completed]',
      hidden: true,
      status: 'completed' as const,
      createdAt: '2026-03-15T00:00:02.000Z'
    },
    {
      id: 'assistant-after-hidden',
      threadId: 'thread-1',
      role: 'assistant' as const,
      parentMessageId: 'hidden-background-notice',
      content: 'Continued visible answer',
      status: 'completed' as const,
      createdAt: '2026-03-15T00:00:03.000Z'
    }
  ]

  const timelineMessages = getTimelineMessages({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-after-hidden'
    },
    messages
  })
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-after-hidden'
    },
    messages: timelineMessages,
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.deepEqual(
    timelineMessages.map((message) => message.id),
    ['user-1', 'assistant-before-hidden', 'hidden-background-notice', 'assistant-after-hidden']
  )
  assert.deepEqual(
    group?.activeAssistantMessages.map((message) => message.id),
    ['assistant-before-hidden', 'assistant-after-hidden']
  )
  assert.deepEqual(group?.hiddenRequestMessageIds, ['hidden-background-notice'])
})

test('getTimelineMessages keeps queued follow-up drafts out of grouping input', () => {
  const messages = [
    {
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user' as const,
      content: 'Visible request',
      status: 'completed' as const,
      createdAt: TIMESTAMP
    },
    {
      id: 'queued-hidden-follow-up',
      threadId: 'thread-1',
      role: 'user' as const,
      parentMessageId: 'user-1',
      content: '[Background task completed]',
      hidden: true,
      status: 'completed' as const,
      createdAt: '2026-03-15T00:00:01.000Z'
    }
  ]

  assert.deepEqual(
    getTimelineMessages({
      thread: {
        id: 'thread-1',
        title: 'Thread',
        updatedAt: TIMESTAMP,
        headMessageId: 'user-1',
        queuedFollowUpMessageId: 'queued-hidden-follow-up'
      },
      messages
    }).map((message) => message.id),
    ['user-1']
  )
})

test('buildMessageGroups ignores hidden user messages on the visible head path', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'hidden-background-notice'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Visible request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'hidden-background-notice',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'user-1',
        content: '[Background task completed]',
        hidden: true,
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.deepEqual(
    groups.map((group) => group.userMessage.id),
    ['user-1']
  )
})

test('buildMessageGroups attaches hidden steer continuations to the previous visible assistant group', () => {
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-after-hidden'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Visible request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-before-hidden',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Initial visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'hidden-background-notice',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-before-hidden',
        content: '[Background task completed]',
        hidden: true,
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-after-hidden',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'hidden-background-notice',
        content: 'Continued visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.equal(group?.userMessage.id, 'user-1')
  assert.deepEqual(
    group?.assistantBranches.map((branch) => branch.message.id),
    ['assistant-before-hidden']
  )
  assert.deepEqual(
    group?.activeAssistantMessages.map((message) => message.id),
    ['assistant-before-hidden', 'assistant-after-hidden']
  )
  assert.deepEqual(group?.hiddenRequestMessageIds, ['hidden-background-notice'])
})

test('buildMessageGroups treats hidden follow-up continuations as a separate assistant group', () => {
  const groups = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-after-hidden-follow-up'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Visible request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-before-hidden-follow-up',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Initial visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'hidden-follow-up',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-before-hidden-follow-up',
        content: '[Background task completed]',
        hidden: true,
        turnContext: { hiddenRequestKind: 'follow-up' },
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-after-hidden-follow-up',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'hidden-follow-up',
        content: 'Follow-up visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.userMessage.id, 'user-1')
  assert.deepEqual(
    groups[0]?.activeAssistantMessages.map((message) => message.id),
    ['assistant-before-hidden-follow-up']
  )
  assert.deepEqual(groups[0]?.hiddenRequestMessageIds, [])
  assert.equal(groups[1]?.userMessage.id, 'hidden-follow-up')
  assert.equal(groups[1]?.userMessage.hidden, true)
  assert.deepEqual(
    groups[1]?.activeAssistantMessages.map((message) => message.id),
    ['assistant-after-hidden-follow-up']
  )
})

test('buildMessageGroups includes streaming assistant output for an active hidden steer', () => {
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'hidden-background-notice'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Visible request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-before-hidden',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Initial visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'hidden-background-notice',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-before-hidden',
        content: '[Background task completed]',
        hidden: true,
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-after-hidden',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'hidden-background-notice',
        content: 'Streaming hidden continuation',
        status: 'streaming',
        createdAt: '2026-03-15T00:00:03.000Z'
      }
    ],
    runPhase: 'streaming',
    activeRequestMessageId: 'hidden-background-notice'
  })

  assert.equal(group?.userMessage.id, 'user-1')
  assert.deepEqual(
    group?.activeAssistantMessages.map((message) => message.id),
    ['assistant-before-hidden', 'assistant-after-hidden']
  )
  assert.deepEqual(group?.hiddenRequestMessageIds, ['hidden-background-notice'])
})

test('partitionToolCallsForGroups attaches hidden-steer tool calls to the visible group', () => {
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-after-hidden'
    },
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Visible request',
        status: 'completed',
        createdAt: TIMESTAMP
      },
      {
        id: 'assistant-before-hidden',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Initial visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'hidden-background-notice',
        threadId: 'thread-1',
        role: 'user',
        parentMessageId: 'assistant-before-hidden',
        content: '[Background task completed]',
        hidden: true,
        status: 'completed',
        createdAt: '2026-03-15T00:00:02.000Z'
      },
      {
        id: 'assistant-after-hidden',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'hidden-background-notice',
        content: 'Continued visible answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  const { inlineToolCalls, orphanToolCalls } = partitionToolCallsForGroups({
    groups: group ? [group] : [],
    toolCalls: [
      {
        id: 'tool-hidden-leg',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'result.txt',
        requestMessageId: 'hidden-background-notice',
        assistantMessageId: 'assistant-after-hidden',
        startedAt: '2026-03-15T00:00:02.500Z'
      }
    ]
  })

  assert.deepEqual(
    inlineToolCalls.map((toolCall) => toolCall.id),
    ['tool-hidden-leg']
  )
  assert.deepEqual(orphanToolCalls, [])
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

test('getVisibleToolCallsForGroup hides completed tool calls from the replaced branch while a retry is preparing', () => {
  const [group] = buildMessageGroups({
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

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    activeRunId: 'run-retry',
    toolCalls: [
      {
        id: 'tool-old-branch',
        runId: 'run-old',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'sleep 5',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        startedAt: '2026-03-15T00:00:01.100Z'
      },
      {
        id: 'tool-retry-running',
        runId: 'run-retry',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'running',
        inputSummary: 'sleep 5',
        requestMessageId: 'user-1',
        startedAt: '2026-03-15T00:00:04.100Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ['tool-retry-running']
  )
})

test('getVisibleToolCallsForGroup hides failed tool calls from the replaced branch while a retry is preparing', () => {
  const [group] = buildMessageGroups({
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

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    activeRunId: 'run-retry',
    toolCalls: [
      {
        id: 'tool-old-failed',
        runId: 'run-old',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'failed',
        inputSummary: 'sleep 5',
        outputSummary: 'exit 1',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        startedAt: '2026-03-15T00:00:01.100Z',
        finishedAt: '2026-03-15T00:00:01.900Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    []
  )
})

test('getVisibleToolCallsForGroup hides branchless tool calls from older runs while a retry is preparing', () => {
  const [group] = buildMessageGroups({
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

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    activeRunId: 'run-retry',
    toolCalls: [
      {
        id: 'tool-old-request-only',
        runId: 'run-old',
        threadId: 'thread-1',
        toolName: 'webRead',
        status: 'failed',
        inputSummary: 'old tool',
        requestMessageId: 'user-1',
        startedAt: '2026-03-15T00:00:01.100Z',
        finishedAt: '2026-03-15T00:00:01.900Z'
      },
      {
        id: 'tool-retry-request-only',
        runId: 'run-retry',
        threadId: 'thread-1',
        toolName: 'webSearch',
        status: 'running',
        inputSummary: 'new tool',
        requestMessageId: 'user-1',
        startedAt: '2026-03-15T00:00:04.100Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ['tool-retry-request-only']
  )
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

test('buildMessageGroups folds a user steer into the active request group', () => {
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
      userMessageId: group.userMessage.id,
      userSteerMessageIds: group.userSteerMessages.map((message) => message.id),
      hideActiveBranchWhilePreparing: group.hideActiveBranchWhilePreparing,
      showPreparing: group.showPreparing
    })),
    [
      {
        userMessageId: 'user-1',
        userSteerMessageIds: ['user-steer'],
        hideActiveBranchWhilePreparing: false,
        showPreparing: true
      }
    ]
  )
})

test('getVisibleToolCallsForGroup keeps tool calls with the active branch and hides inactive completed branches and orphaned-run tool calls', () => {
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
    ['tool-active']
  )
})

test('getVisibleToolCallsForGroup keeps recovered tool calls in assistant response order', () => {
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
        content: 'Recovered answer',
        status: 'completed',
        createdAt: '2026-03-15T00:00:03.000Z',
        responseMessages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'tool-earlier', toolName: 'read', input: {} },
              { type: 'tool-call', toolCallId: 'tool-later', toolName: 'write', input: {} }
            ]
          }
        ]
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    toolCalls: [
      {
        id: 'tool-later',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'write',
        status: 'completed',
        inputSummary: 'later',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        startedAt: '2026-03-15T00:00:01.000Z'
      },
      {
        id: 'tool-earlier',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'read',
        status: 'completed',
        inputSummary: 'earlier',
        requestMessageId: 'user-1',
        assistantMessageId: 'assistant-1',
        startedAt: '2026-03-15T00:00:01.000Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ['tool-earlier', 'tool-later']
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

test('getVisibleToolCallsForGroup keeps request-only tool calls visible for a stopped assistant branch after cancellation', () => {
  const [group] = buildMessageGroups({
    thread: {
      id: 'thread-1',
      title: 'Thread',
      updatedAt: TIMESTAMP,
      headMessageId: 'assistant-stopped'
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
        id: 'assistant-stopped',
        threadId: 'thread-1',
        role: 'assistant',
        parentMessageId: 'user-1',
        content: 'Partial answer',
        status: 'stopped',
        createdAt: '2026-03-15T00:00:01.000Z'
      }
    ],
    runPhase: 'idle',
    activeRequestMessageId: null
  })

  const toolCalls = getVisibleToolCallsForGroup({
    group: group!,
    toolCalls: [
      {
        id: 'tool-cancelled',
        runId: 'run-cancelled',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'failed',
        inputSummary: 'sleep 15',
        outputSummary: 'Run cancelled before the tool call finished.',
        requestMessageId: 'user-1',
        startedAt: '2026-03-15T00:00:00.500Z',
        finishedAt: '2026-03-15T00:00:01.500Z'
      }
    ]
  })

  assert.deepEqual(
    toolCalls.map((toolCall) => toolCall.id),
    ['tool-cancelled']
  )
})
