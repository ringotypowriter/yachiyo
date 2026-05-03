import type { ThreadRecord, ThreadUpdatedEvent } from '../../../../../../shared/yachiyo/protocol.ts'
import {
  buildThreadTitleGenerationMessages,
  parseGeneratedTitleAndIcon,
  THREAD_TITLE_MAX_TOKEN
} from '../../threadTitle.ts'
import type { RunDomainDeps } from '../runTypes.ts'
import { isBackgroundAutoDeliveryEligible } from '../background/backgroundTaskDelivery.ts'

type ThreadTitleGenerationDeps = Pick<
  RunDomainDeps,
  'auxiliaryGeneration' | 'emit' | 'requireThread' | 'storage' | 'timestamp'
>

export class ThreadTitleGenerationRunner {
  private readonly backgroundTitleTasks = new Set<Promise<void>>()
  private readonly backgroundTitleTaskControllers = new Set<AbortController>()
  private readonly deps: ThreadTitleGenerationDeps

  constructor(deps: ThreadTitleGenerationDeps) {
    this.deps = deps
  }

  abort(): void {
    for (const controller of this.backgroundTitleTaskControllers.values()) {
      controller.abort()
    }
  }

  async close(): Promise<void> {
    this.abort()
    if (this.backgroundTitleTasks.size > 0) {
      await Promise.allSettled(this.backgroundTitleTasks)
    }
    this.backgroundTitleTaskControllers.clear()
    this.backgroundTitleTasks.clear()
  }

  schedule(input: { fallbackTitle: string; query: string; runId: string; threadId: string }): void {
    this.logThreadTitleDebug({
      phase: 'queued',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Queued parallel title generation from the initial user message.'
    })

    const abortController = new AbortController()
    this.backgroundTitleTaskControllers.add(abortController)
    const task: Promise<void> | undefined = (async (): Promise<void> => {
      try {
        await this.refine({
          fallbackTitle: input.fallbackTitle,
          query: input.query,
          runId: input.runId,
          signal: abortController.signal,
          threadId: input.threadId
        })
      } catch {
        // Auxiliary title refinement must never break the primary thread flow.
      } finally {
        this.backgroundTitleTaskControllers.delete(abortController)
        if (task) {
          this.backgroundTitleTasks.delete(task)
        }
      }
    })()

    this.backgroundTitleTasks.add(task)
    void task
  }

  private async refine(input: {
    fallbackTitle: string
    query: string
    runId: string
    signal: AbortSignal
    threadId: string
  }): Promise<void> {
    const thread = this.deps.requireThread(input.threadId)
    if (
      thread.source &&
      thread.source !== 'local' &&
      !isBackgroundAutoDeliveryEligible(thread, (channelUserId) =>
        this.deps.storage.getChannelUser(channelUserId)
      )
    ) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation for channel thread.',
        detail: `source=${thread.source}`
      })
      return
    }
    if (thread.title !== input.fallbackTitle) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation because the thread title already changed.',
        detail: 'title-mismatch-before-start'
      })
      return
    }

    if (!input.query.trim()) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation because the initial user query was empty.',
        detail: 'empty-query'
      })
      return
    }

    this.logThreadTitleDebug({
      phase: 'started',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Started title generation in parallel with the main run.'
    })

    const result = await this.deps.auxiliaryGeneration.generateText({
      messages: buildThreadTitleGenerationMessages(input.query),
      max_token: THREAD_TITLE_MAX_TOKEN,
      signal: input.signal,
      purpose: 'thread-title'
    })

    if (result.status === 'unavailable') {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title generation because the tool model was unavailable.',
        detail: result.reason
      })
      return
    }

    if (result.status === 'failed') {
      this.logThreadTitleDebug({
        phase: 'failed',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Title generation failed.',
        detail: result.error
      })
      return
    }

    this.logThreadTitleDebug({
      phase: 'raw-output',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Received raw title-model output.',
      detail: formatThreadTitleDebugValue(result.text)
    })

    const { icon, title } = parseGeneratedTitleAndIcon(result.text)
    this.logThreadTitleDebug({
      phase: 'sanitized-output',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Computed sanitized title candidate.',
      detail: formatThreadTitleDebugValue(title ? `${icon ?? ''} ${title}`.trim() : '')
    })

    if (!title) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title update because the generated title was empty after sanitization.',
        detail: 'empty-generated-title'
      })
      return
    }

    if (title === input.fallbackTitle) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message: 'Skipped title update because the generated title matched the fallback title.',
        detail: 'same-as-fallback'
      })
      return
    }

    const latestThread = this.deps.requireThread(input.threadId)
    if (latestThread.title !== input.fallbackTitle) {
      this.logThreadTitleDebug({
        phase: 'skipped',
        runId: input.runId,
        threadId: input.threadId,
        message:
          'Skipped title update because the thread title changed while generation was running.',
        detail: 'title-mismatch-after-generation'
      })
      return
    }

    const updatedThread: ThreadRecord = {
      ...latestThread,
      ...(icon !== null ? { icon } : {}),
      title,
      updatedAt: this.deps.timestamp()
    }

    this.deps.storage.updateThread(updatedThread)
    this.deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: updatedThread.id,
      thread: updatedThread
    })
    this.logThreadTitleDebug({
      phase: 'succeeded',
      runId: input.runId,
      threadId: input.threadId,
      message: 'Updated the thread title and icon from the tool-model result.',
      detail: icon ? `${icon} ${title}` : title
    })
  }

  private logThreadTitleDebug(input: {
    phase:
      | 'queued'
      | 'started'
      | 'raw-output'
      | 'sanitized-output'
      | 'succeeded'
      | 'skipped'
      | 'failed'
    runId: string
    threadId: string
    message: string
    detail?: string
  }): void {
    console.log(
      '[yachiyo][thread-title]',
      `phase=${input.phase}`,
      `threadId=${input.threadId}`,
      `runId=${input.runId}`,
      input.message,
      ...(input.detail ? [`detail=${input.detail}`] : [])
    )
  }
}

function formatThreadTitleDebugValue(value: string): string {
  const serialized = JSON.stringify(value)
  return serialized.length <= 240 ? serialized : `${serialized.slice(0, 237)}...`
}
