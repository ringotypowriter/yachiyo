import type { YachiyoServerEvent } from '../../../../shared/yachiyo/protocol.ts'

export const DEFAULT_THREAD_TITLE = 'New Chat'
export const DEFAULT_HARNESS_NAME = 'default.reply'
export const INTERRUPTED_RUN_ERROR = 'Run interrupted before completion.'
export const SHUTDOWN_RUN_ERROR = 'Application shut down before the run completed.'

export type CreateId = () => string
export type Timestamp = () => string

export type EmitServerEvent = <TEvent extends YachiyoServerEvent>(
  event: Omit<TEvent, 'eventId' | 'timestamp'>
) => void

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export interface DeltaBatcher {
  push: (delta: string) => void
  flush: () => void
}

export function createDeltaBatcher(options: {
  intervalMs: number
  onFlush: (batch: string) => void
  isAborted?: () => boolean
}): DeltaBatcher {
  const pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const batch = pending.join('')
    pending.length = 0
    options.onFlush(batch)
  }

  const push = (delta: string): void => {
    if (options.isAborted?.()) {
      return
    }
    pending.push(delta)
    if (!timer) {
      timer = setTimeout(() => {
        if (options.isAborted?.()) {
          // Do not clear pending here; callers may still need to flush
          // buffered deltas synchronously after abort.
          timer = null
          return
        }
        flush()
      }, options.intervalMs)
    }
  }

  return { push, flush }
}
