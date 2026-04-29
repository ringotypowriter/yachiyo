import assert from 'node:assert/strict'
import test from 'node:test'

import type { FolderRecord, Thread } from '../../../app/types.ts'
import {
  buildSidebarItems,
  buildSidebarRows,
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
