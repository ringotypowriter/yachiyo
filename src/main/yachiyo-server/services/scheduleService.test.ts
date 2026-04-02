import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import type {
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
  listSchedules: () => ScheduleRecord[]
  getSchedule: (id: string) => ScheduleRecord | undefined
  updateSchedule: (schedule: ScheduleRecord) => void
  deleteSchedule: (id: string) => void
  createScheduleRun: (run: ScheduleRunRecord) => void
  completeScheduleRun: (
    input: Partial<ScheduleRunRecord> & { id: string; completedAt: string }
  ) => void
  recoverInterruptedScheduleRuns: () => void
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

  return {
    schedules,
    runs,
    deletedScheduleIds,
    listSchedules: () => [...schedules.values()],
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

function createDeferredPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await Promise.resolve()
}

describe('createScheduleService', () => {
  it('disarms skipped one-off schedules instead of re-arming them offline', async () => {
    const storage = createMockStorage()
    let fetchCalls = 0
    const fetchRestore = mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1
      if (fetchCalls === 1) {
        return { ok: false } as Response
      }

      return new Promise<Response>(() => {})
    })

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

      assert.equal(fetchCalls, 1)
      assert.equal(storage.runs.length, 1)
      assert.equal(storage.runs[0]?.status, 'skipped')
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
      assert.deepEqual(storage.deletedScheduleIds, [])
    } finally {
      fetchRestore.mock.restore()
    }
  })

  it('keeps completed one-off schedules and their run history', async () => {
    const storage = createMockStorage()
    const fetchRestore = mock.method(globalThis, 'fetch', async () => ({ ok: true }) as Response)
    mock.timers.enable({ apis: ['setTimeout'] })

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
      // completeScheduleRun). Each flushAsyncWork provides ~3 ticks, so we need
      // multiple rounds to fully drain the chain under CI load.
      await flushAsyncWork()
      await flushAsyncWork()
      await flushAsyncWork()

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

  it('does not start an overdue one-off twice when reload runs before connectivity resolves', async () => {
    const storage = createMockStorage(createSchedule({ runAt: '2025-12-31T23:59:00.000Z' }))
    const connectivity = createDeferredPromise<Response>()
    let fetchCalls = 0
    const fetchRestore = mock.method(globalThis, 'fetch', async () => {
      fetchCalls += 1
      return connectivity.promise
    })

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

      assert.equal(fetchCalls, 1)

      connectivity.resolve({ ok: false } as Response)
      await flushAsyncWork()

      assert.equal(storage.runs.length, 1)
      assert.equal(storage.schedules.get('schedule-1')?.enabled, false)
    } finally {
      fetchRestore.mock.restore()
    }
  })

  it('does not recurse when reloading an overdue one-off that is already active', async () => {
    const storage = createMockStorage(createSchedule({ runAt: '2025-12-31T23:59:00.000Z' }))
    const fetchRestore = mock.method(globalThis, 'fetch', async () => ({ ok: true }) as Response)
    const createThreadGate = createDeferredPromise<ThreadRecord>()
    const { server } = createMockServer()
    const gatedServer = {
      ...server,
      createThread: async (input: {
        source?: ThreadRecord['source']
        workspacePath?: string
        title?: string
      }) => {
        void input
        return createThreadGate.promise
      }
    }

    try {
      const service = createScheduleService({
        server: gatedServer,
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
      await flushAsyncWork()
      assert.equal(storage.runs.length, 1)

      service.reload()
      await flushAsyncWork()
      assert.equal(storage.runs.length, 1)

      createThreadGate.resolve({
        id: 'thread-1',
        title: 'Schedule: One-off',
        updatedAt: '2026-01-01T00:00:00.000Z',
        workspacePath: '/tmp',
        source: 'local'
      })
      await flushAsyncWork()
    } finally {
      fetchRestore.mock.restore()
    }
  })
})
