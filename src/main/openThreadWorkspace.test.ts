import assert from 'node:assert/strict'
import test from 'node:test'

import { openThreadWorkspace } from './openThreadWorkspace.ts'

test('openThreadWorkspace ensures the workspace and opens it in Finder', async () => {
  const calls: string[] = []

  await openThreadWorkspace('thread-1', undefined, {
    ensureWorkspace: async (threadId: string): Promise<string> => {
      calls.push(`ensure:${threadId}`)
      return `/tmp/workspaces/${threadId}`
    },
    openPath: async (path: string): Promise<string> => {
      calls.push(`open:${path}`)
      return ''
    }
  })

  assert.deepEqual(calls, ['ensure:thread-1', 'open:/tmp/workspaces/thread-1'])
})

test('openThreadWorkspace surfaces Finder open errors', async () => {
  await assert.rejects(
    () =>
      openThreadWorkspace('thread-2', undefined, {
        ensureWorkspace: async (): Promise<string> => '/tmp/workspaces/thread-2',
        openPath: async (): Promise<string> => 'Finder failed'
      }),
    /Finder failed/
  )
})
