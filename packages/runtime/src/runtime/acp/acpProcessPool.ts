import type { ChildProcess } from 'node:child_process'

import {
  forceTerminateChildProcess,
  gracefullyTerminateChildProcess,
  processTree
} from '../../app/domain/processes/processTree.ts'
import type { AcpWarmSession } from './acpSessionClient.ts'

export const IDLE_TTL_MS = 5 * 60 * 1_000
export const SIGTERM_TIMEOUT_MS = 3_000

export interface AcpProcessPoolKey {
  threadId: string
  sessionKey: string
}

interface IdleEntry {
  key: AcpProcessPoolKey
  proc: ChildProcess
  session: AcpWarmSession
  timer: AcpProcessPoolTimer
}

export interface AcpProcessPoolTimer {
  cleared?: boolean
  unref?(): void
}

export interface AcpProcessPoolDependencies {
  processTree?: {
    gracefullyTerminate(pid: number): { delivered: boolean; error?: string }
    forceTerminate(pid: number): { delivered: boolean; error?: string }
  }
  setTimeout?: (callback: () => void, delay: number) => AcpProcessPoolTimer
  clearTimeout?: (timer: AcpProcessPoolTimer) => void
}

function stringifyPoolKey(key: AcpProcessPoolKey): string {
  return `${key.threadId}\u0000${key.sessionKey}`
}

export class AcpProcessPool {
  private readonly entries = new Map<string, IdleEntry>()
  private readonly processTree: NonNullable<AcpProcessPoolDependencies['processTree']>
  private readonly schedule: (callback: () => void, delay: number) => AcpProcessPoolTimer
  private readonly cancelTimer: (timer: AcpProcessPoolTimer) => void

  constructor(dependencies: AcpProcessPoolDependencies = {}) {
    this.processTree = dependencies.processTree ?? processTree
    this.schedule = dependencies.setTimeout ?? ((callback, delay) => setTimeout(callback, delay))
    this.cancelTimer =
      dependencies.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout))
  }

  /**
   * Returns the warm idle process for `key` if one exists, removing it
   * from the pool and cancelling its idle timer. Returns null otherwise.
   */
  checkout(key: AcpProcessPoolKey): AcpWarmSession | null {
    const entry = this.entries.get(stringifyPoolKey(key))
    if (!entry) return null
    this.cancelTimer(entry.timer)
    this.entries.delete(stringifyPoolKey(key))
    return entry.session
  }

  /**
   * Returns a completed process to the idle pool. Starts the 5-minute TTL
   * timer; evicts any previously-idle entry for this exact session key.
   */
  checkin(key: AcpProcessPoolKey, session: AcpWarmSession): void {
    const entryId = stringifyPoolKey(key)
    const existing = this.entries.get(entryId)
    if (existing) {
      this.cancelTimer(existing.timer)
      void this._killGracefully(existing.session)
    }

    const timer = this.schedule(() => {
      if (this.entries.get(entryId)?.proc === session.proc) {
        this.entries.delete(entryId)
      }
      void this._killGracefully(session)
    }, IDLE_TTL_MS)
    timer.unref?.()

    this.entries.set(entryId, { key, proc: session.proc, session, timer })

    // Auto-remove if the process exits on its own while idle.
    session.procExited.then(() => {
      const current = this.entries.get(entryId)
      if (current?.proc === session.proc) {
        this.cancelTimer(current.timer)
        this.entries.delete(entryId)
      }
    })
  }

  /** Gracefully shut down the idle process for the exact idle-session key. */
  async evict(key: AcpProcessPoolKey): Promise<void> {
    const entryId = stringifyPoolKey(key)
    const entry = this.entries.get(entryId)
    if (!entry) return
    this.cancelTimer(entry.timer)
    this.entries.delete(entryId)
    await this._killGracefully(entry.session)
  }

  /** Gracefully shut down every idle process associated with a thread. */
  async evictThread(threadId: string): Promise<void> {
    const keys = [...this.entries.entries()]
      .filter(([, entry]) => entry.key.threadId === threadId)
      .map(([entryId]) => entryId)

    await Promise.allSettled(
      keys.map(async (entryId) => {
        const entry = this.entries.get(entryId)
        if (!entry) return
        this.cancelTimer(entry.timer)
        this.entries.delete(entryId)
        await this._killGracefully(entry.session)
      })
    )
  }

  /** Gracefully shut down all idle processes (used on server close). */
  async shutdown(): Promise<void> {
    const keys = [...this.entries.values()].map((entry) => entry.key)
    await Promise.allSettled(keys.map((key) => this.evict(key)))
  }

  /**
   * Synchronous SIGKILL of all idle processes. Used only inside
   * `process.on('exit')` where async is not available.
   */
  syncKillAll(): void {
    for (const entry of this.entries.values()) {
      this.cancelTimer(entry.timer)
      this._syncKill(entry.proc)
    }
    this.entries.clear()
  }

  private async _killGracefully(session: {
    proc: ChildProcess
    procExited: Promise<void>
  }): Promise<void> {
    this._reportTermination(
      'graceful',
      session.proc,
      session.proc.pid == null
        ? gracefullyTerminateChildProcess(session.proc)
        : this.processTree.gracefullyTerminate(session.proc.pid)
    )

    let timedOut = false
    const killTimer = this.schedule(() => {
      timedOut = true
      this._syncKill(session.proc)
    }, SIGTERM_TIMEOUT_MS)

    await session.procExited
    if (!timedOut) this.cancelTimer(killTimer)
  }

  private _syncKill(proc: ChildProcess): void {
    this._reportTermination(
      'force',
      proc,
      proc.pid == null
        ? forceTerminateChildProcess(proc)
        : this.processTree.forceTerminate(proc.pid)
    )
  }

  private _reportTermination(
    operation: 'graceful' | 'force',
    proc: ChildProcess,
    result: { delivered: boolean; error?: string }
  ): void {
    if (result.delivered) return
    console.warn('[yachiyo][acp-process-pool] process-tree termination failed', {
      operation,
      pid: proc.pid,
      error: result.error
    })
  }
}

export function createAcpProcessPool(
  dependencies: AcpProcessPoolDependencies = {}
): AcpProcessPool {
  return new AcpProcessPool(dependencies)
}

export const acpProcessPool = new AcpProcessPool()

// Force-kill all idle processes when the main process exits (handles crashes,
// uncaughtException propagation, and normal shutdown alike).
process.on('exit', () => {
  acpProcessPool.syncKillAll()
})
