import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_SIDEBAR_FILTER } from '../../../app/store/useAppStore.ts'
import type { FolderRecord, Thread } from '../../../app/types.ts'
import {
  resolveBackgroundTaskHydrationThreadIds,
  resolveVisibleSidebarThreads
} from './threadListFilters.ts'
import { TEMPORARY_WORKSPACE_FILTER } from './threadWorkspaceFilterOptions.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    updatedAt: TIMESTAMP,
    ...overrides
  }
}

function folder(id: string, overrides: Partial<FolderRecord> = {}): FolderRecord {
  return {
    id,
    title: id,
    colorTag: null,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides
  }
}

test('active list filters do not include archived thread matches', () => {
  const visibleThreads = resolveVisibleSidebarThreads({
    threads: [
      thread('active-coral', { colorTag: 'coral' }),
      thread('active-azure', { colorTag: 'azure' })
    ],
    folders: [],
    archivedThreads: [
      thread('archived-coral', {
        archivedAt: TIMESTAMP,
        colorTag: 'coral'
      })
    ],
    externalThreads: [],
    showExternalThreads: false,
    sidebarFilter: {
      ...DEFAULT_SIDEBAR_FILTER,
      colorTags: new Set(['coral'])
    },
    threadListMode: 'active',
    runStatusesByThread: {},
    justDoneRunIdsByThread: {}
  })

  assert.deepEqual(
    visibleThreads.map((t) => t.id),
    ['active-coral']
  )
})

test('archived list filters stay scoped to archived threads', () => {
  const visibleThreads = resolveVisibleSidebarThreads({
    threads: [thread('active-coral', { colorTag: 'coral' })],
    folders: [],
    archivedThreads: [
      thread('archived-coral', {
        archivedAt: TIMESTAMP,
        colorTag: 'coral'
      }),
      thread('archived-azure', {
        archivedAt: TIMESTAMP,
        colorTag: 'azure'
      })
    ],
    externalThreads: [],
    showExternalThreads: false,
    sidebarFilter: {
      ...DEFAULT_SIDEBAR_FILTER,
      base: 'archived',
      colorTags: new Set(['coral'])
    },
    threadListMode: 'archived',
    runStatusesByThread: {},
    justDoneRunIdsByThread: {}
  })

  assert.deepEqual(
    visibleThreads.map((t) => t.id),
    ['archived-coral']
  )
})

test('temporary workspace filter includes only local unsaved workspace threads', () => {
  const visibleThreads = resolveVisibleSidebarThreads({
    threads: [
      thread('saved', { workspacePath: '/work/saved' }),
      thread('unsaved', { workspacePath: '/tmp/yachiyo/thread-1' }),
      thread('no-workspace'),
      thread('scheduled', {
        workspacePath: '/tmp/yachiyo/schedule-1',
        createdFromScheduleId: 'schedule-1'
      })
    ],
    folders: [],
    archivedThreads: [],
    externalThreads: [
      thread('external', {
        workspacePath: '/tmp/yachiyo/qq-1',
        source: 'qq'
      })
    ],
    showExternalThreads: true,
    savedWorkspacePaths: ['/work/saved'],
    sidebarFilter: {
      ...DEFAULT_SIDEBAR_FILTER,
      workspacePaths: new Set([TEMPORARY_WORKSPACE_FILTER])
    },
    threadListMode: 'active',
    runStatusesByThread: {},
    justDoneRunIdsByThread: {}
  })

  assert.deepEqual(
    visibleThreads.map((t) => t.id),
    ['unsaved', 'no-workspace']
  )
})

test('color filters include threads inside matching colored folders', () => {
  const visibleThreads = resolveVisibleSidebarThreads({
    threads: [
      thread('in-coral-folder', { folderId: 'folder-coral' }),
      thread('loose-coral', { colorTag: 'coral' }),
      thread('in-azure-folder', { folderId: 'folder-azure' })
    ],
    folders: [
      folder('folder-coral', { colorTag: 'coral' }),
      folder('folder-azure', { colorTag: 'azure' })
    ],
    archivedThreads: [],
    externalThreads: [],
    showExternalThreads: false,
    sidebarFilter: {
      ...DEFAULT_SIDEBAR_FILTER,
      colorTags: new Set(['coral'])
    },
    threadListMode: 'active',
    runStatusesByThread: {},
    justDoneRunIdsByThread: {}
  })

  assert.deepEqual(
    visibleThreads.map((t) => t.id),
    ['in-coral-folder', 'loose-coral']
  )
})

test('running filter includes threads with running background bash tasks', () => {
  const visibleThreads = resolveVisibleSidebarThreads({
    threads: [thread('foreground-run'), thread('background-task'), thread('idle')],
    folders: [],
    archivedThreads: [],
    externalThreads: [],
    showExternalThreads: false,
    sidebarFilter: {
      ...DEFAULT_SIDEBAR_FILTER,
      running: true
    },
    threadListMode: 'active',
    runStatusesByThread: {
      'foreground-run': 'running',
      'background-task': 'completed',
      idle: 'completed'
    },
    backgroundTaskRunningThreadIds: new Set(['background-task']),
    justDoneRunIdsByThread: {}
  })

  assert.deepEqual(
    visibleThreads.map((t) => t.id),
    ['foreground-run', 'background-task']
  )
})

test('background task hydration covers every known sidebar thread before filters run', () => {
  const threadIds = resolveBackgroundTaskHydrationThreadIds({
    threads: [thread('active'), thread('duplicate')],
    archivedThreads: [thread('archived'), thread('duplicate')],
    externalThreads: [thread('external')]
  })

  assert.deepEqual(threadIds, ['active', 'duplicate', 'archived', 'external'])
})
