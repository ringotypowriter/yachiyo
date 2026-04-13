import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type {
  MessageRecord,
  ScheduleRecord,
  ScheduleRunRecord,
  ThreadRecord,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import { createScheduleService } from './scheduleService.ts'

interface MockStorage {
  schedules: Map<string, ScheduleRecord>
  runs: ScheduleRunRecord[]
  deletedScheduleIds: string[]
  threadMessages: Map<string, MessageRecord[]>
  listSchedules: () => ScheduleRecord[]
  getSchedule: (id: string) => ScheduleRecord | undefined
  updateSchedule: (schedule: ScheduleRecord) => void
  deleteSchedule: (id: string) => void
  createScheduleRun: (run: ScheduleRunRecord) => void
  completeScheduleRun: (
    input: Partial<ScheduleRunRecord> & { id: string; completedAt: string }
  ) => void
  recoverInterruptedScheduleRuns: () => void
  listThreadMessages: (threadId: string) => MessageRecord[]
}

function createSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'schedule-1',
    name: 'One-off',
    runAt: '2026-01-01T00:00:00.000Z',
    prompt: 'Do the thing',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function createMockStorage(schedule = createSchedule()): MockStorage {
  const schedules = new Map<string, ScheduleRecord>([[schedule.id, { ...schedule }]])
  const runs: ScheduleRunRecord[] = []
  const deletedScheduleIds: string[] = []
  const threadMessages = new Map<string, MessageRecord[]>()

  return {
    schedules,
    runs,
    deletedScheduleIds,
    threadMessages,
    listSchedules: () => [...schedules.values()],
    listThreadMessages: (threadId) => threadMessages.get(threadId) ?? [],
    getSchedule: (id: string) => {
      const schedule = schedules.get(id)
      return schedule ? { ...schedule } : undefined
    },
    updateSchedule: (next) => {
      schedules.set(next.id, { ...next })
    },
    deleteSchedule: (id) => {
      deletedScheduleIds.push(id)
      schedules.delete(id)
    },
    createScheduleRun: (run) => {
      runs.push({ ...run })
    },
    completeScheduleRun: (input) => {
      const existing = runs.find((run) => run.id === input.id)
      if (!existing) {
        throw new Error(`Missing run ${input.id}`)
      }

      Object.assign(existing, {
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.resultStatus ? { resultStatus: input.resultStatus } : {}),
        ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
        ...(input.error ? { error: input.error } : {}),
        ...(input.promptTokens != null ? { promptTokens: input.promptTokens } : {}),
        ...(input.completionTokens != null ? { completionTokens: input.completionTokens } : {}),
        completedAt: input.completedAt
      })
    },
    recoverInterruptedScheduleRuns: () => {}
  }
}

function createMockServer(): {
  server: {
    createThread: (input: {
      source?: ThreadRecord['source']
      workspacePath?: string
      title?: string
    }) => Promise<ThreadRecord>
    setThreadModelOverride: () => Promise<ThreadRecord>
    sendChat: (input: { threadId: string; content: string }) => Promise<{ runId: string }>
    setThreadIcon: () => Promise<ThreadRecord>
    archiveThread: () => Promise<void>
    showNotification: (input: { title: string; body?: string }) => void
    subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
  }
  notifications: Array<{ title: string; body?: string }>
} {
  const listeners = new Set<(event: YachiyoServerEvent) => void>()
  const notifications: Array<{ title: string; body?: string }> = []

  return {
    notifications,
    server: {
      createThread: async ({ workspacePath, title }) => ({
        id: 'thread-1',
        title: title ?? 'Schedule: One-off',
        updatedAt: '2026-01-01T00:00:00.000Z',
        workspacePath,
        source: 'local'
      }),
      setThreadModelOverride: async () => ({
        id: 'thread-1',
        title: 'Schedule: One-off',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }),
      sendChat: async ({ threadId }) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              type: 'run.completed',
              eventId: 'event-1',
              timestamp: '2026-01-01T00:00:01.000Z',
              threadId,
              runId: 'run-1',
              promptTokens: 11,
              completionTokens: 7
            })
          }
        })

        return { runId: 'run-1' }
      },
      setThreadIcon: async () => ({
        id: 'thread-1',
        title: 'Schedule: One-off',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }),
      archiveThread: async () => {},
      showNotification: (input) => {
        notifications.push(input)
      },
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

/**
 * Drain microtasks/macrotasks until `predicate` returns true or `maxAttempts`
 * is reached. This avoids the CI flakiness that comes from hard-coding a
 * fixed number of flushAsyncWork rounds for long sequential-await chains.
 */
async function waitFor(predicate: () => boolean, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (predicate()) return
    await flushAsyncWork()
  }
}

describe('createScheduleService', () => {
  it('disarms skipped one-off schedules instead of re-arming them offline', async () => {
    const storage = createMockStorage(createSchedule({ runAt: '1970-01-01T00:00:05.000Z' }))
    let fetchCalls = 0
    const fetchRestore = mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1
      return { ok: false } as Response
    })
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    try {
      const { server, notifications } = createMockServer()
      const service = createScheduleService({
        server,
        storage,
        createId: (() => {
          let next = 0
          return () => `run-${++next}`
        })(),
        timestamp: (() => {
          let next = 0
          return () => `2026-01-01T00:00:0${next++}.000Z`
        })(),
        tempWorkspaceDir: '/tmp'
      })

      service.reload()
      await flushAsyncWork()
      mock.timers.runAll()
      await flushAsyncWork()
      mock.timers.runAll()
      await flushAsyncWork()
      mock.timers.runAll()
      await flushAsyncWork()

      assert.equal(fetchCalls, 3)
      assert.equal(storage.runs.length, 1)
      assert.equal(storage.runs[0]?.status, 'skipped')
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
      assert.deepEqual(storage.deletedScheduleIds, [])
      // Skipped schedules should notify the user.
      assert.equal(notifications.length, 1)
      assert.equal(notifications[0]?.title, 'One-off — skipped')
      assert.equal(notifications[0]?.body, 'No internet connection.')
    } finally {
      fetchRestore.mock.restore()
      mock.timers.reset()
    }
  })

  it('keeps completed one-off schedules and their run history', async () => {
    const storage = createMockStorage(createSchedule({ runAt: '1970-01-01T00:00:05.000Z' }))
    const fetchRestore = mock.method(globalThis, 'fetch', async () => ({ ok: true }) as Response)
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    try {
      const { server, notifications } = createMockServer()
      const service = createScheduleService({
        server,
        storage,
        createId: (() => {
          let next = 0
          return () => `run-${++next}`
        })(),
        timestamp: (() => {
          let next = 0
          return () => `2026-01-01T00:00:0${next++}.000Z`
        })(),
        tempWorkspaceDir: '/tmp'
      })

      service.reload()
      await flushAsyncWork()
      mock.timers.runAll()
      // fireSchedule chains 7+ sequential awaits (connectivity → createThread →
      // setThreadIcon → setThreadModelOverride → sendChat → event microtask →
      // completeScheduleRun). Rather than hard-coding flush rounds (fragile under
      // CI load), poll until the run reaches its terminal state.
      await waitFor(() => storage.runs[0]?.status === 'completed')

      assert.equal(storage.runs.length, 1)
      assert.equal(storage.runs[0]?.status, 'completed')
      assert.equal(storage.runs[0]?.threadId, 'thread-1')
      assert.equal(storage.runs[0]?.promptTokens, 11)
      assert.equal(storage.runs[0]?.completionTokens, 7)
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
      assert.deepEqual(storage.deletedScheduleIds, [])
      assert.equal(notifications.length, 1)
    } finally {
      fetchRestore.mock.restore()
      mock.timers.reset()
    }
  })

  it('skips an overdue one-off without firing or creating runs', async () => {
    const storage = createMockStorage(createSchedule({ runAt: '1970-01-01T00:00:00.000Z' }))
    let fetchCalls = 0
    const fetchRestore = mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1
      return { ok: false } as Response
    })
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    try {
      const { server } = createMockServer()
      const service = createScheduleService({
        server,
        storage,
        createId: (() => {
          let next = 0
          return () => `run-${++next}`
        })(),
        timestamp: (() => {
          let next = 0
          return () => `2026-01-01T00:00:0${next++}.000Z`
        })(),
        tempWorkspaceDir: '/tmp'
      })

      service.reload()
      service.reload()
      await flushAsyncWork()

      assert.equal(fetchCalls, 0)
      assert.equal(storage.runs.length, 0)
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
    } finally {
      fetchRestore.mock.restore()
      mock.timers.reset()
    }
  })

  it('triggerScheduleNow fires a disabled one-off schedule', async () => {
    // Simulate a one-off schedule that was skipped and auto-disabled.
    const storage = createMockStorage(
      createSchedule({ runAt: '1970-01-01T00:00:05.000Z', enabled: false })
    )
    const fetchRestore = mock.method(globalThis, 'fetch', async () => ({ ok: true }) as Response)
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    let service: ReturnType<typeof createScheduleService> | undefined
    try {
      const { server, notifications } = createMockServer()
      service = createScheduleService({
        server,
        storage,
        createId: (() => {
          let next = 0
          return () => `run-${++next}`
        })(),
        timestamp: (() => {
          let next = 0
          return () => `2026-01-01T00:00:0${next++}.000Z`
        })(),
        tempWorkspaceDir: '/tmp'
      })

      service.start()

      // The schedule is disabled so no timer should have been armed.
      // Manually trigger it.
      await service.triggerScheduleNow('schedule-1')
      await waitFor(() => storage.runs[0]?.status === 'completed')

      assert.equal(storage.runs.length, 1)
      assert.equal(storage.runs[0]?.status, 'completed')
      assert.equal(storage.runs[0]?.threadId, 'thread-1')
      assert.equal(notifications.length, 1)
      // The schedule should remain disabled (it was already disabled).
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
    } finally {
      service?.stop()
      fetchRestore.mock.restore()
      mock.timers.reset()
    }
  })

  it('triggerScheduleNow returns silently for a nonexistent schedule', async () => {
    const storage = createMockStorage()
    const fetchRestore = mock.method(globalThis, 'fetch', async () => ({ ok: true }) as Response)

    let service: ReturnType<typeof createScheduleService> | undefined
    try {
      const { server } = createMockServer()
      service = createScheduleService({
        server,
        storage,
        createId: () => 'run-1',
        timestamp: () => '2026-01-01T00:00:00.000Z',
        tempWorkspaceDir: '/tmp'
      })

      service.start()
      // Should not throw for a missing schedule.
      await service.triggerScheduleNow('nonexistent')
      assert.equal(storage.runs.length, 0)
    } finally {
      service?.stop()
      fetchRestore.mock.restore()
    }
  })

  it('skips an overdue one-off even when reloaded multiple times', async () => {
    const storage = createMockStorage(createSchedule({ runAt: '1970-01-01T00:00:00.000Z' }))
    const fetchRestore = mock.method(globalThis, 'fetch', async () => ({ ok: true }) as Response)
    mock.timers.enable({ apis: ['Date', 'setTimeout'] })

    try {
      const { server } = createMockServer()
      const service = createScheduleService({
        server,
        storage,
        createId: (() => {
          let next = 0
          return () => `run-${++next}`
        })(),
        timestamp: (() => {
          let next = 0
          return () => `2026-01-01T00:00:0${next++}.000Z`
        })(),
        tempWorkspaceDir: '/tmp'
      })

      service.reload()
      await flushAsyncWork()
      assert.equal(storage.runs.length, 0)

      service.reload()
      await flushAsyncWork()
      assert.equal(storage.runs.length, 0)
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
    } finally {
      fetchRestore.mock.restore()
      mock.timers.reset()
    }
  })
})
