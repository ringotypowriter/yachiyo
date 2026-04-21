import type {
  MessageRecord,
  SettingsConfig,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import { collectMessagePath } from '../../../../shared/yachiyo/threadTree.ts'
import type { MemoryService } from './memoryService.ts'

const LOG_PREFIX = '[yachiyo][memory-distill]'
const IDLE_DEBOUNCE_MS = 10 * 60 * 1000 // 10 minutes
const RUN_THRESHOLD = 8
const MIN_PROMPT_TOKENS_FOR_DISTILLATION = 16_000

export interface MemoryDistillationSchedulerDeps {
  memoryService: MemoryService
  readConfig: () => SettingsConfig
  loadThreadMessages: (threadId: string) => MessageRecord[]
  /** Read the current persisted thread. Returns undefined if deleted. */
  getThread: (threadId: string) => ThreadRecord | undefined
  /** Read the latest completed run's prompt-token count for a thread. */
  getThreadTotalTokens: (threadId: string) => number
}

interface ThreadEntry {
  timer: ReturnType<typeof setTimeout>
  abortController: AbortController
  runCount: number
  rememberToolRunCount: number
}

export interface MemoryDistillationScheduler {
  /** Called after a run completes on a thread. Debounces/batches distillation. */
  onRunCompleted(thread: ThreadRecord, usedRememberTool?: boolean): void
  /** Cancel pending distillation for a thread (e.g. on delete/archive). */
  cancelThread(threadId: string): void
  /** Await all pending distillation tasks and clean up. */
  close(): Promise<void>
}

/** Resolve the canonical message path for a thread, excluding abandoned branches. */
function resolveEffectiveMessages(
  thread: ThreadRecord,
  messages: MessageRecord[]
): MessageRecord[] {
  if (messages.length === 0) return []

  const headMessageId =
    thread.headMessageId && messages.some((m) => m.id === thread.headMessageId)
      ? thread.headMessageId
      : [...messages].sort((l, r) => l.createdAt.localeCompare(r.createdAt)).at(-1)?.id

  if (!headMessageId) {
    return [...messages].sort((l, r) => l.createdAt.localeCompare(r.createdAt))
  }

  return collectMessagePath(messages, headMessageId)
}

async function runDistillation(
  deps: MemoryDistillationSchedulerDeps,
  input: { threadId: string; signal: AbortSignal }
): Promise<void> {
  try {
    // Read the current persisted thread at distillation time, not the
    // snapshot from when the run completed. The user may have changed
    // branches or deleted messages during the debounce window.
    const thread = deps.getThread(input.threadId)
    if (!thread) {
      console.log(LOG_PREFIX, 'skipped (thread gone)', { threadId: input.threadId })
      return
    }

    const allMessages = deps.loadThreadMessages(input.threadId)
    const messages = resolveEffectiveMessages(thread, allMessages)
    if (messages.length === 0) {
      console.log(LOG_PREFIX, 'skipped (no messages)', { threadId: input.threadId })
      return
    }
    const promptTokens = deps.getThreadTotalTokens(input.threadId)
    if (promptTokens < MIN_PROMPT_TOKENS_FOR_DISTILLATION) {
      console.log(LOG_PREFIX, 'skipped (too few prompt tokens)', {
        threadId: input.threadId,
        promptTokens
      })
      return
    }

    console.log(LOG_PREFIX, 'starting batch distillation', {
      threadId: input.threadId,
      messageCount: messages.length,
      promptTokens
    })

    const result = await deps.memoryService.saveThread({
      messages,
      signal: input.signal,
      thread
    })

    console.log(LOG_PREFIX, 'batch distillation complete', {
      threadId: input.threadId,
      savedCount: result.savedCount
    })
  } catch (error) {
    console.warn(LOG_PREFIX, 'batch distillation failed', {
      threadId: input.threadId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function createMemoryDistillationScheduler(
  deps: MemoryDistillationSchedulerDeps
): MemoryDistillationScheduler {
  const entries = new Map<string, ThreadEntry>()
  const activeTasks = new Set<Promise<void>>()
  /** All abort controllers for in-flight distillation tasks, keyed by threadId. */
  const activeAbortControllers = new Map<string, Set<AbortController>>()
  let closed = false

  function clearEntry(threadId: string): void {
    const entry = entries.get(threadId)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.abortController.abort()
    entries.delete(threadId)
  }

  function abortActiveTasksForThread(threadId: string): void {
    const controllers = activeAbortControllers.get(threadId)
    if (!controllers) return
    for (const controller of controllers) {
      controller.abort()
    }
    activeAbortControllers.delete(threadId)
  }

  function flushThread(threadId: string): void {
    const entry = entries.get(threadId)
    if (!entry) return

    clearTimeout(entry.timer)
    const { abortController, runCount, rememberToolRunCount } = entry
    entries.delete(threadId)

    // When every run in the batch already saved memories via the remember
    // tool, skip automatic distillation to avoid duplicate or conflicting
    // writes — same intent as the original per-run guard.
    if (rememberToolRunCount > 0 && rememberToolRunCount >= runCount) {
      console.log(LOG_PREFIX, 'skipped (all runs used remember tool)', {
        threadId,
        runCount,
        rememberToolRunCount
      })
      return
    }

    console.log(LOG_PREFIX, 'flushing thread', { threadId, runCount })

    // Register the abort controller so cancelThread can reach it.
    let controllers = activeAbortControllers.get(threadId)
    if (!controllers) {
      controllers = new Set()
      activeAbortControllers.set(threadId, controllers)
    }
    controllers.add(abortController)

    const task = runDistillation(deps, {
      threadId,
      signal: abortController.signal
    }).finally(() => {
      activeTasks.delete(task)
      controllers.delete(abortController)
      if (controllers.size === 0) {
        activeAbortControllers.delete(threadId)
      }
    })
    activeTasks.add(task)
    void task
  }

  function scheduleTimer(threadId: string): void {
    const entry = entries.get(threadId)
    if (!entry) return

    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => flushThread(threadId), IDLE_DEBOUNCE_MS)
  }

  return {
    onRunCompleted(thread: ThreadRecord, usedRememberTool?: boolean): void {
      if (closed) return

      if (!deps.memoryService.isConfigured()) return
      if (deps.readConfig().chat?.autoMemoryDistillation === false) return
      if (thread.privacyMode) return
      if (thread.source && thread.source !== 'local') return

      const existing = entries.get(thread.id)

      if (existing) {
        existing.runCount += 1
        if (usedRememberTool) existing.rememberToolRunCount += 1

        if (existing.runCount >= RUN_THRESHOLD) {
          console.log(LOG_PREFIX, 'run threshold reached', {
            threadId: thread.id,
            runCount: existing.runCount
          })
          flushThread(thread.id)
          return
        }

        console.log(LOG_PREFIX, 'debounce reset', {
          threadId: thread.id,
          runCount: existing.runCount
        })
        scheduleTimer(thread.id)
        return
      }

      console.log(LOG_PREFIX, 'queued', { threadId: thread.id })
      const abortController = new AbortController()
      entries.set(thread.id, {
        timer: setTimeout(() => flushThread(thread.id), IDLE_DEBOUNCE_MS),
        abortController,
        runCount: 1,
        rememberToolRunCount: usedRememberTool ? 1 : 0
      })
    },

    cancelThread(threadId: string): void {
      const hadEntry = entries.has(threadId)
      const hadActive = activeAbortControllers.has(threadId)
      if (hadEntry || hadActive) {
        console.log(LOG_PREFIX, 'cancelled', {
          threadId,
          pending: hadEntry,
          active: hadActive
        })
      }
      clearEntry(threadId)
      abortActiveTasksForThread(threadId)
    },

    async close(): Promise<void> {
      closed = true

      // Cancel pending debounce timers. Threads that haven't reached the
      // idle-timeout or run-threshold are intentionally dropped — the
      // debounce/threshold gates are the real quality filter, and flushing
      // everything on shutdown would send full transcripts for every thread
      // that had even a single run.
      const pendingCount = entries.size
      for (const threadId of [...entries.keys()]) {
        clearEntry(threadId)
      }
      if (pendingCount > 0) {
        console.log(LOG_PREFIX, 'close: dropped pending entries', { count: pendingCount })
      }

      // Wait for any already-started distillation tasks to finish.
      if (activeTasks.size > 0) {
        await Promise.allSettled(activeTasks)
      }

      activeTasks.clear()
    }
  }
}
