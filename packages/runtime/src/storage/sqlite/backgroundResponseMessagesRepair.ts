import { Worker } from 'node:worker_threads'

export interface BackgroundResponseMessagesRepairJob {
  messageId: string
  responseMessages: string
}

export interface BackgroundResponseMessagesRepairQueue {
  schedule(job: BackgroundResponseMessagesRepairJob): void
  flush(): Promise<void>
  close(): void
}

const RESPONSE_MESSAGES_REPAIR_WORKER_SCRIPT = `
  const { parentPort, workerData } = require('node:worker_threads')
  const BetterSqlite3Module = require('better-sqlite3')
  const BetterSqlite3 =
    typeof BetterSqlite3Module === 'function' ? BetterSqlite3Module : BetterSqlite3Module.default

  if (!BetterSqlite3) {
    throw new Error('Failed to load better-sqlite3 runtime')
  }

  const db = new BetterSqlite3(workerData.dbPath)
  db.pragma('journal_mode = WAL')
  const updateMessageResponseMessages = db.prepare(
    'UPDATE messages SET response_messages = ? WHERE id = ?'
  )

  parentPort.on('message', (message) => {
    if (!message || message.type !== 'persist') {
      return
    }

    try {
      updateMessageResponseMessages.run(message.responseMessages, message.messageId)
      parentPort.postMessage({ type: 'persisted', jobId: message.jobId })
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        jobId: message.jobId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
`

export function createBackgroundResponseMessagesRepairQueue(
  dbPath: string
): BackgroundResponseMessagesRepairQueue {
  let worker: Worker | null = null
  let closing = false
  let nextJobId = 1
  let drainScheduled = false
  const queuedJobsByMessageId = new Map<string, BackgroundResponseMessagesRepairJob>()
  const pendingJobs = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  const inFlightJobs = new Set<Promise<void>>()

  const handleWorkerFailure = (error: Error): void => {
    const pendingEntries = [...pendingJobs.values()]
    pendingJobs.clear()
    worker = null

    for (const pending of pendingEntries) {
      pending.reject(error)
    }
  }

  const ensureWorker = (): Worker => {
    if (worker) {
      return worker
    }

    const createdWorker = new Worker(RESPONSE_MESSAGES_REPAIR_WORKER_SCRIPT, {
      eval: true,
      workerData: { dbPath }
    })

    createdWorker.on('message', (message: unknown) => {
      const payload = message as { type?: string; jobId?: number; error?: string }
      if (typeof payload.jobId !== 'number') {
        return
      }

      const pending = pendingJobs.get(payload.jobId)
      if (!pending) {
        return
      }

      pendingJobs.delete(payload.jobId)

      if (payload.type === 'persisted') {
        pending.resolve()
        return
      }

      pending.reject(new Error(payload.error ?? 'Background responseMessages repair failed'))
    })

    createdWorker.on('error', (error) => {
      if (closing) {
        return
      }

      handleWorkerFailure(error instanceof Error ? error : new Error(String(error)))
    })

    createdWorker.on('exit', (code) => {
      if (closing || code === 0) {
        worker = null
        return
      }

      handleWorkerFailure(new Error(`responseMessages repair worker exited with code ${code}`))
    })

    worker = createdWorker
    return createdWorker
  }

  const trackInFlightJob = (job: Promise<void>): void => {
    inFlightJobs.add(job)
    void job.finally(() => {
      inFlightJobs.delete(job)
    })
  }

  const dispatchQueuedJobs = (): void => {
    drainScheduled = false
    if (queuedJobsByMessageId.size === 0 || closing) {
      return
    }

    const jobs = [...queuedJobsByMessageId.values()]
    queuedJobsByMessageId.clear()
    const activeWorker = ensureWorker()

    for (const job of jobs) {
      const jobId = nextJobId++
      const pendingJob = new Promise<void>((resolve, reject) => {
        pendingJobs.set(jobId, { resolve, reject })
      })

      pendingJob.catch((error) => {
        console.warn('[storage] background responseMessages repair failed', {
          messageId: job.messageId,
          error: error instanceof Error ? error.message : String(error)
        })
      })

      trackInFlightJob(pendingJob)
      activeWorker.postMessage({
        type: 'persist',
        jobId,
        messageId: job.messageId,
        responseMessages: job.responseMessages
      })
    }
  }

  return {
    schedule(job) {
      if (closing) {
        return
      }

      queuedJobsByMessageId.set(job.messageId, job)
      if (drainScheduled) {
        return
      }

      drainScheduled = true
      setImmediate(dispatchQueuedJobs)
    },

    async flush(): Promise<void> {
      if (drainScheduled) {
        dispatchQueuedJobs()
      }

      if (inFlightJobs.size > 0) {
        await Promise.allSettled([...inFlightJobs])
      }
    },

    close() {
      closing = true
      queuedJobsByMessageId.clear()
      const pendingEntries = [...pendingJobs.values()]
      pendingJobs.clear()
      for (const pending of pendingEntries) {
        pending.reject(new Error('responseMessages repair queue closed'))
      }
      worker?.removeAllListeners()
      const currentWorker = worker
      worker = null
      if (currentWorker) {
        void currentWorker.terminate().catch(() => {})
      }
    }
  }
}
