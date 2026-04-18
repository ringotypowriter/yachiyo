import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CHAT_INPUT_BUFFER_EXTEND_WAIT_MS,
  EMPTY_CHAT_INPUT_BUFFER_STATE,
  clearChatInputBuffer,
  getChatInputBufferProgress,
  stageChatInputBuffer,
  type ChatInputBufferPayload,
  type ChatInputBufferState
} from '../lib/chatInputBuffer.ts'

export type ChatInputBufferFlushResult = boolean | void

export interface UseChatInputBufferOptions {
  onFlush: (
    payload: ChatInputBufferPayload
  ) => ChatInputBufferFlushResult | Promise<ChatInputBufferFlushResult>
}

export interface UseChatInputBufferResult {
  staged: ChatInputBufferPayload | null
  progress: number
  remainingMs: number
  waitMs: number | null
  stage: (payload: ChatInputBufferPayload) => void
  flushNow: () => void
  cancel: () => void
}

interface TickInfo {
  progress: number
  remainingMs: number
}

const EMPTY_TICK: TickInfo = { progress: 0, remainingMs: 0 }

function mergePayloadContent(previous: string, next: string): string {
  if (previous.length === 0) return next
  if (next.length === 0) return previous
  return `${previous}\n${next}`
}

export function useChatInputBuffer(options: UseChatInputBufferOptions): UseChatInputBufferResult {
  const [state, setState] = useState<ChatInputBufferState>(EMPTY_CHAT_INPUT_BUFFER_STATE)
  const [tick, setTick] = useState<TickInfo>(EMPTY_TICK)

  const stateRef = useRef(state)
  const onFlushRef = useRef(options.onFlush)
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rafRef = useRef<number | null>(null)
  const flushInFlightRef = useRef(false)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    onFlushRef.current = options.onFlush
  }, [options.onFlush])

  const clearTimers = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // Optimistically clear the staged buffer when flushing so any stage() calls
  // that arrive while the send is in flight start a fresh window instead of
  // double-counting the in-flight payload. If the send fails (returns false or
  // throws) we restore the payload — preserving it if nothing else was staged
  // in the meantime, or prepending it to whatever the user staged during the
  // flush so neither segment is lost.
  const doFlush = useCallback(() => {
    if (flushInFlightRef.current) return
    const current = stateRef.current
    if (!current.staged) {
      clearTimers()
      return
    }
    const payload = current.staged
    clearTimers()
    flushInFlightRef.current = true
    setState(clearChatInputBuffer())
    setTick(EMPTY_TICK)
    void (async () => {
      let committed = false
      try {
        const result = await onFlushRef.current(payload)
        committed = result !== false
      } catch {
        committed = false
      } finally {
        flushInFlightRef.current = false
      }
      if (committed) return
      setState((prev) => {
        if (!prev.staged) {
          return {
            staged: payload,
            flushAt: Date.now() + CHAT_INPUT_BUFFER_EXTEND_WAIT_MS,
            waitMs: CHAT_INPUT_BUFFER_EXTEND_WAIT_MS
          }
        }
        return {
          staged: {
            // Keep the original source thread; staging is scoped to one
            // thread and the restored payload was composed for the same one.
            sourceThreadId: prev.staged.sourceThreadId,
            content: mergePayloadContent(payload.content, prev.staged.content),
            images: [...payload.images, ...prev.staged.images],
            attachments: [...payload.attachments, ...prev.staged.attachments],
            // Newer stage's skill selection wins; the failed payload is from
            // an earlier moment and should not override the user's latest
            // choice.
            enabledSkillNames: prev.staged.enabledSkillNames
          },
          flushAt: Date.now() + CHAT_INPUT_BUFFER_EXTEND_WAIT_MS,
          waitMs: CHAT_INPUT_BUFFER_EXTEND_WAIT_MS
        }
      })
    })()
  }, [clearTimers])

  useEffect(() => {
    if (!state.staged || state.flushAt === null) {
      clearTimers()
      return
    }

    const snapshot = state
    const flushAt = state.flushAt
    const delay = Math.max(0, flushAt - Date.now())
    flushTimerRef.current = setTimeout(() => {
      doFlush()
    }, delay)

    const runTick = (): void => {
      const now = Date.now()
      const progress = getChatInputBufferProgress(snapshot, now)
      const remainingMs = Math.max(0, flushAt - now)
      setTick({ progress, remainingMs })
      rafRef.current = requestAnimationFrame(runTick)
    }
    runTick()

    return () => {
      clearTimers()
    }
  }, [state, clearTimers, doFlush])

  useEffect(() => {
    return () => {
      clearTimers()
    }
  }, [clearTimers])

  const stage = useCallback((payload: ChatInputBufferPayload) => {
    setState((prev) => stageChatInputBuffer(prev, payload, Date.now()))
  }, [])

  const cancel = useCallback(() => {
    clearTimers()
    setState(clearChatInputBuffer())
    setTick(EMPTY_TICK)
  }, [clearTimers])

  return {
    staged: state.staged,
    progress: tick.progress,
    remainingMs: tick.remainingMs,
    waitMs: state.waitMs,
    stage,
    flushNow: doFlush,
    cancel
  }
}
