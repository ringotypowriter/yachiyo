import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { useBackgroundTasksStore } from './useBackgroundTasksStore'

describe('useBackgroundTasksStore hydrate', () => {
  beforeEach(() => {
    useBackgroundTasksStore.setState({ tasksByThread: {} })
  })

  it('preserves finished tasks that are missing from a later hydrate snapshot', () => {
    const store = useBackgroundTasksStore.getState()

    store.onStarted({
      type: 'background-task.started',
      eventId: 'evt-start-1',
      timestamp: '2026-04-12T10:00:00.000Z',
      threadId: 'thread-1',
      taskId: 'running-task',
      command: 'sleep 1',
      startedAt: '2026-04-12T10:00:00.000Z'
    })
    store.onStarted({
      type: 'background-task.started',
      eventId: 'evt-start-2',
      timestamp: '2026-04-12T10:00:01.000Z',
      threadId: 'thread-1',
      taskId: 'completed-task',
      command: 'echo done',
      startedAt: '2026-04-12T10:00:01.000Z'
    })
    store.onCompleted({
      type: 'background-task.completed',
      eventId: 'evt-complete-1',
      timestamp: '2026-04-12T10:00:02.000Z',
      threadId: 'thread-1',
      taskId: 'completed-task',
      command: 'echo done',
      logPath: '/tmp/completed.log',
      exitCode: 0
    })

    useBackgroundTasksStore.getState().hydrate('thread-1', [
      {
        taskId: 'running-task',
        threadId: 'thread-1',
        command: 'sleep 1',
        logPath: '/tmp/running.log',
        startedAt: '2026-04-12T10:00:00.000Z',
        status: 'running'
      }
    ])

    const tasks = useBackgroundTasksStore.getState().tasksByThread['thread-1']
    assert.equal(tasks['running-task']?.status, 'running')
    assert.equal(tasks['completed-task']?.status, 'completed')
  })

  it('removes stale running tasks that are absent from the latest hydrate snapshot', () => {
    const store = useBackgroundTasksStore.getState()

    store.onStarted({
      type: 'background-task.started',
      eventId: 'evt-start-3',
      timestamp: '2026-04-12T10:00:00.000Z',
      threadId: 'thread-1',
      taskId: 'ghost-running-task',
      command: 'sleep 1',
      startedAt: '2026-04-12T10:00:00.000Z'
    })

    useBackgroundTasksStore.getState().hydrate('thread-1', [])

    const tasks = useBackgroundTasksStore.getState().tasksByThread['thread-1'] ?? {}
    assert.equal(tasks['ghost-running-task'], undefined)
  })
})
