import assert from 'node:assert/strict'
import test from 'node:test'

import type { FolderRecord, Thread, ToolCall } from '../../../app/types.ts'
import {
  buildSidebarItems,
  buildSidebarRows,
  resolveThreadSidebarPreview,
  resolveSidebarFolderDropId
} from './threadSidebarRows.ts'

const NOW = new Date('2026-04-29T12:00:00.000Z')

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    updatedAt: '2026-04-29T10:00:00.000Z',
    ...overrides
  }
}

function folder(id: string, overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id,
    title: id,
    colorTag: null,
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides
  }
}

function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tool-1',
    runId: 'run-1',
    threadId: 'thread-1',
    toolName: 'bash',
    status: 'completed',
    inputSummary: 'done',
    startedAt: '2026-04-29T10:01:00.000Z',
    finishedAt: '2026-04-29T10:02:00.000Z',
    ...overrides
  }
}

test('expanded folders bundle children inside the folder row', () => {
  const items = buildSidebarItems(
    [
      thread('folder-today', { folderId: 'folder-a' }),
      thread('folder-yesterday', {
        folderId: 'folder-a',
        updatedAt: '2026-04-28T10:00:00.000Z'
      }),
      thread('loose-today')
    ],
    [folder('folder-a')],
    NOW
  )

  const rows = buildSidebarRows(items, new Set())

  assert.deepEqual(
    rows.map((row) => [row.kind, row.key]),
    [
      ['folder', 'folder:folder-a'],
      ['date-header', 'date:Today'],
      ['thread', 'thread:loose-today']
    ]
  )

  const folderRow = rows[0]
  assert.equal(folderRow.kind, 'folder')
  if (folderRow.kind === 'folder') {
    assert.deepEqual(
      folderRow.children.map((c) =>
        c.kind === 'folder-date-header' ? ['date-header', c.label] : ['thread', c.thread.id]
      ),
      [
        ['date-header', 'Today'],
        ['thread', 'folder-today'],
        ['date-header', 'Yesterday'],
        ['thread', 'folder-yesterday']
      ]
    )
  }
})

test('collapsed folders keep child threads out of the virtual row set', () => {
  const items = buildSidebarItems(
    [thread('folder-thread', { folderId: 'folder-a' }), thread('loose-thread')],
    [folder('folder-a')],
    NOW
  )

  const rows = buildSidebarRows(items, new Set(['folder-a']))

  assert.deepEqual(
    rows.map((row) => [row.kind, row.key]),
    [
      ['folder', 'folder:folder-a'],
      ['date-header', 'date:Today'],
      ['thread', 'thread:loose-thread']
    ]
  )
})

test('starred loose threads stay above folders and dated loose threads', () => {
  const items = buildSidebarItems(
    [
      thread('folder-thread', { folderId: 'folder-a' }),
      thread('starred-loose', { starredAt: '2026-04-29T11:00:00.000Z' }),
      thread('loose-thread')
    ],
    [folder('folder-a')],
    NOW
  )

  const rows = buildSidebarRows(items, new Set(['folder-a']))

  assert.deepEqual(
    rows.map((row) => [row.kind, row.key]),
    [
      ['starred-header', 'starred'],
      ['thread', 'thread:starred-loose'],
      ['folder', 'folder:folder-a'],
      ['date-header', 'date:Today'],
      ['thread', 'thread:loose-thread']
    ]
  )
})

test('folder row produces a drop target id', () => {
  const items = buildSidebarItems(
    [
      thread('folder-today', { folderId: 'folder-a' }),
      thread('folder-yesterday', {
        folderId: 'folder-a',
        updatedAt: '2026-04-28T10:00:00.000Z'
      })
    ],
    [folder('folder-a')],
    NOW
  )

  const rows = buildSidebarRows(items, new Set())
  const folderRow = rows.find((row) => row.kind === 'folder')
  assert.ok(folderRow && folderRow.kind === 'folder')
  assert.equal(resolveSidebarFolderDropId(folderRow), 'folder-folder-a')
})

test('loose threads with a draft float to the top under a Today header', () => {
  const items = buildSidebarItems(
    [thread('recent-today'), thread('draft-yesterday', { updatedAt: '2026-04-28T10:00:00.000Z' })],
    [],
    NOW,
    new Set(['draft-yesterday'])
  )

  const rows = buildSidebarRows(items, new Set())

  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'date-header'
        ? ['date-header', row.label]
        : row.kind === 'thread'
          ? ['thread', row.thread.id]
          : [row.kind, '']
    ),
    [
      ['date-header', 'Today'],
      ['thread', 'draft-yesterday'],
      ['thread', 'recent-today']
    ]
  )
})

test('multiple draft threads all appear before non-draft threads', () => {
  const items = buildSidebarItems(
    [
      thread('today-a'),
      thread('draft-b', { updatedAt: '2026-04-27T10:00:00.000Z' }),
      thread('draft-c', { updatedAt: '2026-04-26T10:00:00.000Z' })
    ],
    [],
    NOW,
    new Set(['draft-b', 'draft-c'])
  )

  const rows = buildSidebarRows(items, new Set())
  const threadIds = rows
    .filter((r) => r.kind === 'thread')
    .map((r) => (r as { kind: 'thread'; thread: { id: string } }).thread.id)

  assert.equal(threadIds[0], 'draft-b')
  assert.equal(threadIds[1], 'draft-c')
  assert.equal(threadIds[2], 'today-a')
})

test('running thread preview shows a thinking placeholder before current-run tool calls', () => {
  const preview = resolveThreadSidebarPreview({
    activeRunId: 'run-1',
    hasBackgroundWork: false,
    isRunActive: true,
    thread: thread('thread-1', { preview: 'Half-written user request' }),
    toolCalls: []
  })

  assert.equal(preview.state, 'thinking')
  assert.notEqual(preview.text, 'Half-written user request')
})

test('running thread preview shows a working placeholder after a current-run tool call', () => {
  const preview = resolveThreadSidebarPreview({
    activeRunId: 'run-1',
    hasBackgroundWork: false,
    isRunActive: true,
    thread: thread('thread-1', { preview: 'Half-written user request' }),
    toolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'running',
        inputSummary: 'run tests',
        startedAt: '2026-04-29T10:01:00.000Z'
      }
    ]
  })

  assert.equal(preview.state, 'working')
  assert.notEqual(preview.text, 'Half-written user request')
})

test('running thread preview ignores tool calls from previous runs', () => {
  const preview = resolveThreadSidebarPreview({
    activeRunId: 'run-2',
    hasBackgroundWork: false,
    isRunActive: true,
    thread: thread('thread-1', { preview: 'Current user request' }),
    toolCalls: [
      {
        id: 'tool-1',
        runId: 'run-1',
        threadId: 'thread-1',
        toolName: 'bash',
        status: 'completed',
        inputSummary: 'old work',
        startedAt: '2026-04-29T09:00:00.000Z',
        finishedAt: '2026-04-29T09:01:00.000Z'
      }
    ]
  })

  assert.equal(preview.state, 'thinking')
})

test('idle thread preview keeps the saved message preview', () => {
  const preview = resolveThreadSidebarPreview({
    activeRunId: null,
    hasBackgroundWork: false,
    isRunActive: false,
    thread: thread('thread-1', { preview: '**Saved** preview' }),
    toolCalls: []
  })

  assert.deepEqual(preview, {
    state: 'normal',
    text: 'Saved preview'
  })
})

test('idle thread preview shows pending plan approval after the latest exitPlanMode tool', () => {
  const preview = resolveThreadSidebarPreview({
    activeRunId: null,
    hasBackgroundWork: false,
    isRunActive: false,
    pendingPlanApproval: true,
    thread: thread('thread-1', { preview: '' }),
    toolCalls: [
      toolCall({
        id: 'tool-read',
        toolName: 'read',
        startedAt: '2026-04-29T10:01:00.000Z',
        finishedAt: '2026-04-29T10:02:00.000Z'
      }),
      toolCall({
        id: 'tool-exit-plan',
        toolName: 'exitPlanMode',
        startedAt: '2026-04-29T10:03:00.000Z',
        finishedAt: '2026-04-29T10:04:00.000Z'
      })
    ]
  })

  assert.deepEqual(preview, {
    state: 'plan',
    text: 'Pending approval'
  })
})

test('idle thread preview ignores pending plan approval when a later tool exists', () => {
  const preview = resolveThreadSidebarPreview({
    activeRunId: null,
    hasBackgroundWork: false,
    isRunActive: false,
    pendingPlanApproval: true,
    thread: thread('thread-1', { preview: 'Saved preview' }),
    toolCalls: [
      toolCall({
        id: 'tool-exit-plan',
        toolName: 'exitPlanMode',
        startedAt: '2026-04-29T10:01:00.000Z',
        finishedAt: '2026-04-29T10:02:00.000Z'
      }),
      toolCall({
        id: 'tool-read',
        toolName: 'read',
        startedAt: '2026-04-29T10:03:00.000Z',
        finishedAt: '2026-04-29T10:04:00.000Z'
      })
    ]
  })

  assert.deepEqual(preview, {
    state: 'normal',
    text: 'Saved preview'
  })
})

test('running thread placeholders stay one word', () => {
  for (const threadId of ['thread-a', 'thread-b', 'thread-c', 'thread-d']) {
    const thinking = resolveThreadSidebarPreview({
      activeRunId: 'run-1',
      hasBackgroundWork: false,
      isRunActive: true,
      thread: thread(threadId),
      toolCalls: []
    })
    assert.match(thinking.text, /^[A-Za-z]+\.\.\.$/)

    const working = resolveThreadSidebarPreview({
      activeRunId: 'run-1',
      hasBackgroundWork: false,
      isRunActive: true,
      thread: thread(threadId),
      toolCalls: [
        {
          id: `tool-${threadId}`,
          runId: 'run-1',
          threadId,
          toolName: 'bash',
          status: 'running',
          inputSummary: 'run tests',
          startedAt: '2026-04-29T10:01:00.000Z'
        }
      ]
    })
    assert.match(working.text, /^[A-Za-z]+\.\.\.$/)
  }
})
