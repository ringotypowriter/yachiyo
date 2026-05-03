import assert from 'node:assert/strict'
import test from 'node:test'

import type { FolderRecord, Thread } from '../../../app/types.ts'
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

test('expanded folders expose their children as virtual sidebar rows', () => {
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
      ['folder-date-header', 'folder-date:folder-a:Today'],
      ['folder-thread', 'folder-thread:folder-a:folder-today'],
      ['folder-date-header', 'folder-date:folder-a:Yesterday'],
      ['folder-thread', 'folder-thread:folder-a:folder-yesterday'],
      ['date-header', 'date:Today'],
      ['thread', 'thread:loose-today']
    ]
  )
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

test('expanded folder rows expose unique parent-folder drop targets', () => {
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

  const folderRows = buildSidebarRows(items, new Set()).filter(
    (row) =>
      row.kind === 'folder' || row.kind === 'folder-date-header' || row.kind === 'folder-thread'
  )
  const dropIds = folderRows.map((row) => resolveSidebarFolderDropId(row))

  assert.deepEqual(dropIds, [
    'folder-folder-a',
    'folder-folder-a-row-folder-date:folder-a:Today',
    'folder-folder-a-row-folder-thread:folder-a:folder-today',
    'folder-folder-a-row-folder-date:folder-a:Yesterday',
    'folder-folder-a-row-folder-thread:folder-a:folder-yesterday'
  ])
  assert.equal(new Set(dropIds).size, dropIds.length)
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
