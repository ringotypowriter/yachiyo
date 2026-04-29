import assert from 'node:assert/strict'
import test from 'node:test'

import type { Thread } from '../../../app/types.ts'
import {
  TEMPORARY_WORKSPACE_FILTER,
  resolveWorkspaceFilterOptions
} from './threadWorkspaceFilterOptions.ts'

const TIMESTAMP = '2026-03-15T00:00:00.000Z'

function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  return {
    id,
    title: id,
    updatedAt: TIMESTAMP,
    ...overrides
  }
}

test('workspace filter options only include saved workspaces matched by local threads', () => {
  const options = resolveWorkspaceFilterOptions({
    savedPaths: ['/work/user-b', '/work/user-a', '/work/no-thread'],
    threads: [
      thread('thread-z', { workspacePath: '/work/zeta' }),
      thread('thread-a', { workspacePath: '/work/user-a' }),
      thread('thread-b', { workspacePath: '/work/user-b' }),
      thread('thread-m', { workspacePath: '/work/mid' })
    ],
    archivedThreads: []
  })

  assert.deepEqual(
    options.map((option) => option.path),
    ['/work/user-b', '/work/user-a', TEMPORARY_WORKSPACE_FILTER]
  )
  assert.equal(
    options.find((option) => option.path === TEMPORARY_WORKSPACE_FILTER)?.displayName,
    'Temporary'
  )
})

test('workspace filter options exclude schedule and external thread workspaces', () => {
  const options = resolveWorkspaceFilterOptions({
    savedPaths: ['/work/user-schedule-123', '/work/scheduled', '/work/external', '/work/local'],
    threads: [
      thread('user-named-schedule', { workspacePath: '/work/user-schedule-123' }),
      thread('local', { workspacePath: '/work/local' }),
      thread('scheduled', {
        workspacePath: '/work/scheduled',
        createdFromScheduleId: 'schedule-1'
      }),
      thread('external', {
        workspacePath: '/work/external',
        source: 'discord'
      })
    ],
    archivedThreads: [
      thread('archived-external', {
        archivedAt: TIMESTAMP,
        workspacePath: '/work/archived-external',
        channelUserId: 'channel-user-1'
      })
    ]
  })

  assert.deepEqual(
    options.map((option) => option.path),
    ['/work/user-schedule-123', '/work/local']
  )
})
