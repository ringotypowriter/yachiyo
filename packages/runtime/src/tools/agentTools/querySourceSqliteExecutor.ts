import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

import { resolveYachiyoActivitySourceKeyPath } from '../../config/paths.ts'
import type {
  QueryRowsResult,
  QuerySourceExecutor,
  QuerySourceToolInput
} from './querySourceTool.ts'
import { SQLITE_SOURCE_QUERY_WORKER_SCRIPT } from './querySourceSqliteWorkerScript.ts'

interface WorkerMessage {
  error?: string
  handled?: boolean
  result?: QueryRowsResult
}

const appRequire = createRequire(import.meta.url)

function createAbortError(): Error {
  const error = new Error('querySource sqlite query aborted.')
  error.name = 'AbortError'
  return error
}

function normalizeIsoTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value
}

function normalizeQuerySourceInput(input: QuerySourceToolInput): QuerySourceToolInput {
  if (!input.where) return input

  const since = normalizeIsoTimestamp(input.where.since)
  const until = normalizeIsoTimestamp(input.where.until)
  if (since === input.where.since && until === input.where.until) return input

  return {
    ...input,
    where: {
      ...input.where,
      ...(since !== undefined ? { since } : {}),
      ...(until !== undefined ? { until } : {})
    }
  }
}

function normalizeWorkerError(error: unknown): Error {
  if (error instanceof Error) {
    return new Error(error.message, { cause: error })
  }

  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message, { cause: error })
  }

  return new Error(String(error), { cause: error })
}

function runSqliteSourceQueryWorker(input: {
  activitySourceKeyPath: string
  dbPath: string
  queryInput: QuerySourceToolInput
  signal?: AbortSignal
}): Promise<QueryRowsResult | undefined> {
  if (input.signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  const worker = new Worker(SQLITE_SOURCE_QUERY_WORKER_SCRIPT, {
    eval: true,
    workerData: {
      activitySourceKeyPath: input.activitySourceKeyPath,
      betterSqlite3ModulePath: appRequire.resolve('better-sqlite3'),
      dbPath: input.dbPath,
      input: normalizeQuerySourceInput(input.queryInput)
    }
  })

  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      input.signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => {
      void worker.terminate().catch(() => {})
      settle(() => reject(createAbortError()))
    }

    input.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (message: WorkerMessage) => {
      settle(() => {
        if (message.error) {
          reject(new Error(message.error))
          return
        }
        resolve(message.handled === true ? message.result : undefined)
      })
    })
    worker.on('error', (error) => {
      settle(() => reject(normalizeWorkerError(error)))
    })
    worker.on('exit', (code) => {
      if (code !== 0) {
        settle(() => reject(new Error(`querySource sqlite worker exited with code ${code}`)))
      }
    })
  })
}

const SQLITE_SOURCE_QUERY_TABLES = new Set<QuerySourceToolInput['from']>([
  'source_events',
  'thread_folders',
  'threads',
  'thread_spans',
  'thread_messages',
  'activity_records'
])

export function createSqliteSourceQueryExecutor(input: { dbPath: string }): QuerySourceExecutor {
  const activitySourceKeyPath = resolveYachiyoActivitySourceKeyPath()

  return {
    query(queryInput, signal) {
      if (!SQLITE_SOURCE_QUERY_TABLES.has(queryInput.from)) {
        return Promise.resolve(undefined)
      }
      return runSqliteSourceQueryWorker({
        activitySourceKeyPath,
        dbPath: input.dbPath,
        queryInput,
        signal
      })
    }
  }
}
