import type {
  ChannelUserRecord,
  ChatAccepted,
  MessageImageRecord,
  SendChatInput,
  ThreadModelOverride,
  ThreadRecord,
  UpdateChannelUserInput,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import { createChannelReplyTool } from './channelReply.ts'
import { createToolProgressReporter } from './channelToolProgressReporter.ts'
import type { ChannelPolicy } from './channelPolicy.ts'

const REPLY_DELAY_MIN_MS = 3_000
const REPLY_DELAY_MAX_MS = 8_000

function randomReplyDelay(): number {
  return REPLY_DELAY_MIN_MS + Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS)
}

function toWantedModelOverride(
  modelOverride: ThreadModelOverride | undefined
): ThreadModelOverride | null {
  if (!modelOverride?.providerName || !modelOverride?.model) {
    return null
  }
  return modelOverride
}

function isRunAccepted(
  accepted: ChatAccepted
): accepted is Extract<ChatAccepted, { runId: string }> {
  return 'runId' in accepted
}

function toKTokens(totalTokens: number): number {
  if (totalTokens <= 0) {
    return 0
  }
  return Math.ceil(totalTokens / 1000)
}

export interface DirectMessageServer {
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  sendChat(input: SendChatInput): Promise<ChatAccepted>
  getThreadTotalTokens(threadId: string): number
  updateLatestAssistantVisibleReply(input: { threadId: string; visibleReply: string }): void
  updateChannelUser(input: UpdateChannelUserInput): ChannelUserRecord
  getTtlReaper(): { register(path: string, ttlMs: number): void }
  findActiveChannelThread(channelUserId: string, maxAgeMs: number): ThreadRecord | undefined
  setThreadModelOverride(input: {
    threadId: string
    modelOverride: ThreadModelOverride | null
  }): Promise<ThreadRecord>
  cancelRunForThread(threadId: string): boolean
  cancelRunForChannelUser(channelUserId: string): boolean
}

export interface DirectMessageThreadResolution {
  thread: ThreadRecord
  usageBaselineKTokens: number
}

export interface DirectMessageCreateThreadInput {
  handoffFromThreadId?: string
  workspacePath?: string
}

export interface ResolveDirectMessageThreadOptions {
  logLabel: string
  server: Pick<
    DirectMessageServer,
    'findActiveChannelThread' | 'setThreadModelOverride' | 'getThreadTotalTokens'
  >
  channelUser: ChannelUserRecord
  policy: Pick<ChannelPolicy, 'contextTokenLimit' | 'threadReuseWindowMs'>
  modelOverride?: ThreadModelOverride
  createThread: (input?: DirectMessageCreateThreadInput) => Promise<ThreadRecord>
}

export async function resolveDirectMessageThread(
  options: ResolveDirectMessageThreadOptions
): Promise<DirectMessageThreadResolution> {
  const { logLabel, server, channelUser, policy, modelOverride, createThread } = options
  const existing = server.findActiveChannelThread(channelUser.id, policy.threadReuseWindowMs)
  const wantedOverride = toWantedModelOverride(modelOverride)

  const createResolvedThread = async (
    input?: DirectMessageCreateThreadInput
  ): Promise<ThreadRecord> => {
    let thread = await createThread(input)
    if (wantedOverride) {
      thread = await server.setThreadModelOverride({
        threadId: thread.id,
        modelOverride: wantedOverride
      })
    }
    return thread
  }

  if (existing) {
    let thread = existing
    const currentOverride = existing.modelOverride
    const overrideChanged =
      (currentOverride?.providerName ?? '') !== (wantedOverride?.providerName ?? '') ||
      (currentOverride?.model ?? '') !== (wantedOverride?.model ?? '')

    if (overrideChanged) {
      thread = await server.setThreadModelOverride({
        threadId: existing.id,
        modelOverride: wantedOverride
      })
      console.log(
        `[${logLabel}] reconciled model override on thread ${existing.id}:`,
        wantedOverride ?? 'cleared'
      )
    }

    const totalTokens = server.getThreadTotalTokens(thread.id)
    const currentThreadKTokens = toKTokens(totalTokens)
    console.log(`[${logLabel}] existing thread ${thread.id} — ${totalTokens} tokens`)
    if (policy.contextTokenLimit > 0 && totalTokens >= policy.contextTokenLimit) {
      console.log(
        `[${logLabel}] thread ${thread.id} reached ${totalTokens}/${policy.contextTokenLimit} tokens; creating handoff thread`
      )
      return {
        thread: await createResolvedThread({
          handoffFromThreadId: thread.id,
          ...(thread.workspacePath ? { workspacePath: thread.workspacePath } : {})
        }),
        usageBaselineKTokens: Math.max(channelUser.usedKTokens, currentThreadKTokens)
      }
    }

    return {
      thread,
      usageBaselineKTokens: Math.max(0, channelUser.usedKTokens - currentThreadKTokens)
    }
  }

  return {
    thread: await createResolvedThread(),
    usageBaselineKTokens: channelUser.usedKTokens
  }
}

export interface DirectMessageServiceOptions<TTarget> {
  logLabel: string
  server: DirectMessageServer
  policy: Pick<ChannelPolicy, 'allowedTools' | 'replyInstruction' | 'imageTtlMs'>
  resolveThread(channelUser: ChannelUserRecord): Promise<DirectMessageThreadResolution>
  sendMessage(target: TTarget, text: string): Promise<void>
  startBatchIndicator?(target: TTarget): void | (() => void)
  startHandlingIndicator?(target: TTarget): void | (() => void)
  replyDelayMs?(): number
  nonRunReply: string
  errorReply: string
  /**
   * Optional handler for slash commands (messages starting with `/` that have no images).
   * Return `true` if the command was handled and the normal batch flow should be skipped.
   * Return `false` to fall through to the standard batch-and-send flow.
   */
  handleSlashCommand?(
    target: TTarget,
    channelUser: ChannelUserRecord,
    command: string,
    args: string,
    context: { batchDiscarded: boolean }
  ): Promise<boolean>
  /**
   * Optional predicate that decides whether a pending batch should be discarded
   * before executing the given slash command.
   */
  shouldDiscardPendingBatch?(command: string, channelUser: ChannelUserRecord, args: string): boolean
}

export interface DirectMessageService<TTarget> {
  enqueueMessage(
    target: TTarget,
    channelUser: ChannelUserRecord,
    text: string,
    imageDownloads?: Promise<MessageImageRecord | null>[]
  ): void
  stop(): void
  /** Abort any in-flight message handling for the given channel user. */
  requestStop(channelUserId: string): void
}

interface PendingBatch<TTarget> {
  messages: string[]
  imageDownloads: Promise<MessageImageRecord | null>[]
  timer: ReturnType<typeof setTimeout>
  target: TTarget
  channelUser: ChannelUserRecord
  stopBatchIndicator: () => void
}

function collectResolvedImages(
  imageDownloads: Promise<MessageImageRecord | null>[]
): Promise<MessageImageRecord[]> {
  return Promise.all(imageDownloads).then((results) =>
    results.filter((img): img is MessageImageRecord => img !== null)
  )
}

/**
 * Subscribes to server events for a thread and collects the assistant output.
 * Returns `null` when the run is cancelled or the provided signal is aborted,
 * so callers can skip side-effects (e.g. updating the visible reply).
 */
export interface DirectMessageRunOutputCollection {
  promise: Promise<string | null>
  bindRun(runId: string): void
  cancel(): void
}

interface DirectMessageRunOutputCollectionOptions {
  onTextSegment?(text: string): void | Promise<void>
}

type DirectMessageRunTerminal =
  | { type: 'completed' }
  | { type: 'cancelled' }
  | { type: 'failed'; error: string }

type DirectMessageRunBufferedEvent =
  | { type: 'text'; text: string }
  | { type: 'toolBoundary'; toolCallId: string }
  | { type: 'terminal'; terminal: DirectMessageRunTerminal }

export function collectDirectMessageRunOutput(
  server: Pick<DirectMessageServer, 'subscribe'>,
  threadId: string,
  signal?: AbortSignal,
  options: DirectMessageRunOutputCollectionOptions = {}
): DirectMessageRunOutputCollection {
  let bindRun: (runId: string) => void = () => {}
  let cancel: () => void = () => {}

  const promise = new Promise<string | null>((resolve, reject) => {
    let boundRunId: string | null = null
    let fullText = ''
    let pendingText = ''
    let settled = false
    let deliveryChain = Promise.resolve()
    const bufferedEventsByRun = new Map<string, DirectMessageRunBufferedEvent[]>()
    const flushedToolCallIds = new Set<string>()

    const cleanup = (): void => {
      unsubscribe()
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      cleanup()
      void deliveryChain.then(
        () => resolve(value),
        (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)))
      )
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const flushPendingText = (): void => {
      const text = pendingText.trim()
      pendingText = ''
      if (!text || !options.onTextSegment) {
        return
      }

      let delivery: void | Promise<void>
      try {
        delivery = options.onTextSegment(text)
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
        return
      }
      deliveryChain = deliveryChain.then(() => delivery)
      void deliveryChain.catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)))
      })
    }

    const applyTerminal = (terminal: DirectMessageRunTerminal): void => {
      if (terminal.type === 'completed') {
        flushPendingText()
        settle(fullText)
        return
      }
      if (terminal.type === 'cancelled') {
        settle(null)
        return
      }
      fail(new Error(terminal.error))
    }

    const applyRunEvent = (event: DirectMessageRunBufferedEvent): void => {
      if (event.type === 'text') {
        fullText += event.text
        pendingText += event.text
        return
      }
      if (event.type === 'toolBoundary') {
        if (flushedToolCallIds.has(event.toolCallId)) return
        flushedToolCallIds.add(event.toolCallId)
        flushPendingText()
        return
      }
      applyTerminal(event.terminal)
    }

    const handleRunEvent = (runId: string, event: DirectMessageRunBufferedEvent): void => {
      if (settled) return
      if (boundRunId) {
        if (runId === boundRunId) {
          applyRunEvent(event)
        }
        return
      }

      const bufferedEvents = bufferedEventsByRun.get(runId) ?? []
      bufferedEvents.push(event)
      bufferedEventsByRun.set(runId, bufferedEvents)
    }

    const onAbort = (): void => {
      settle(null)
    }

    const unsubscribe = server.subscribe((event: YachiyoServerEvent) => {
      if (!('threadId' in event) || event.threadId !== threadId) {
        return
      }

      if (event.type === 'message.delta') {
        const delta = (event as YachiyoServerEvent & { delta?: string }).delta ?? ''
        if (!delta) return
        handleRunEvent(event.runId, { type: 'text', text: delta })
        return
      }

      if (event.type === 'tool.updated') {
        const toolCall = event.toolCall
        const runId = event.runId ?? toolCall.runId
        if (!runId || !toolCall.id) return
        handleRunEvent(runId, { type: 'toolBoundary', toolCallId: toolCall.id })
        return
      }

      if (event.type === 'run.completed') {
        if (event.recap) return
        handleRunEvent(event.runId, { type: 'terminal', terminal: { type: 'completed' } })
        return
      }

      if (event.type === 'run.cancelled') {
        if (event.recap) return
        handleRunEvent(event.runId, { type: 'terminal', terminal: { type: 'cancelled' } })
        return
      }

      if (event.type === 'run.failed') {
        handleRunEvent(event.runId, {
          type: 'terminal',
          terminal: {
            type: 'failed',
            error: (event as YachiyoServerEvent & { error?: string }).error ?? 'Run failed'
          }
        })
      }
    })

    bindRun = (runId: string): void => {
      if (settled) return
      if (boundRunId && boundRunId !== runId) {
        throw new Error(`Direct message output is already bound to run ${boundRunId}.`)
      }
      boundRunId = runId
      const bufferedEvents = bufferedEventsByRun.get(runId) ?? []
      bufferedEventsByRun.clear()
      for (const event of bufferedEvents) {
        applyRunEvent(event)
      }
    }

    cancel = (): void => {
      settle(null)
    }

    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  return { promise, bindRun, cancel }
}

async function appendOutboundTextMessage(input: {
  text: string
  outboundTranscript: string[]
  dedupeAgainst?: readonly string[]
  logLabel: string
  sendMessage(text: string): Promise<void>
}): Promise<string | null> {
  const text = input.text.trim()
  if (!text || input.dedupeAgainst?.includes(text)) {
    return null
  }

  console.log(
    `[${input.logLabel}] sending ${
      input.outboundTranscript.length === 0 ? 'outbound text' : 'outbound text segment'
    }: ${text.slice(0, 100)}`
  )
  await input.sendMessage(text)
  input.outboundTranscript.push(text)
  return text
}

function formatOutboundTranscript(outboundTranscript: string[]): string {
  return outboundTranscript.join('\n')
}

export function createDirectMessageService<TTarget>(
  options: DirectMessageServiceOptions<TTarget>
): DirectMessageService<TTarget> {
  const pendingBatches = new Map<string, PendingBatch<TTarget>>()
  const userRunChain = new Map<string, Promise<void>>()
  const userStopControllers = new Map<string, AbortController>()
  const replyDelayMs = options.replyDelayMs ?? randomReplyDelay

  async function handleAllowedMessage(
    target: TTarget,
    channelUser: ChannelUserRecord,
    text: string,
    images: MessageImageRecord[]
  ): Promise<void> {
    const stopHandlingIndicator = options.startHandlingIndicator?.(target) ?? (() => {})
    const stopController = new AbortController()
    userStopControllers.set(channelUser.id, stopController)
    let outputCollection: DirectMessageRunOutputCollection | null = null

    try {
      console.log(
        `[${options.logLabel}] handling allowed message for user ${channelUser.username} (${images.length} image(s))`
      )

      const { thread, usageBaselineKTokens } = await options.resolveThread(channelUser)
      console.log(`[${options.logLabel}] using thread ${thread.id}`)

      if (stopController.signal.aborted) {
        console.log(`[${options.logLabel}] aborted before sendChat for ${channelUser.username}`)
        return
      }

      const liveReplies: string[] = []
      const outboundTranscript: string[] = []
      let outboundQueue = Promise.resolve()
      const queueOutboundTextMessage = (input: {
        message: string
        dedupeAgainst?: readonly string[]
        recordLiveReply?: boolean
      }): Promise<void> => {
        outboundQueue = outboundQueue.then(async () => {
          const sent = await appendOutboundTextMessage({
            text: input.message,
            outboundTranscript,
            dedupeAgainst: input.dedupeAgainst,
            logLabel: options.logLabel,
            sendMessage: (message) => options.sendMessage(target, message)
          })
          if (sent && input.recordLiveReply) {
            liveReplies.push(sent)
          }
        })
        return outboundQueue
      }
      const replyTool = createChannelReplyTool({
        onReply: async (message: string): Promise<void> => {
          console.log(`[${options.logLabel}] reply tool called: ${message.slice(0, 100)}`)
          await queueOutboundTextMessage({
            message,
            dedupeAgainst: outboundTranscript,
            recordLiveReply: true
          })
        }
      })

      outputCollection = collectDirectMessageRunOutput(
        options.server,
        thread.id,
        stopController.signal,
        {
          onTextSegment: (message) =>
            queueOutboundTextMessage({
              message,
              dedupeAgainst: liveReplies
            })
        }
      )

      const userLabelHint = channelUser.label
        ? `<channel_user_context>You are talking to: ${channelUser.label} (${channelUser.username})</channel_user_context>\n\n`
        : ''
      const accepted = await options.server.sendChat({
        threadId: thread.id,
        content: text,
        images: images.length > 0 ? images : undefined,
        enabledTools: options.policy.allowedTools,
        channelHint: userLabelHint + options.policy.replyInstruction,
        extraTools: { reply: replyTool }
      })
      console.log(`[${options.logLabel}] sendChat accepted:`, accepted)

      if (!isRunAccepted(accepted)) {
        outputCollection.cancel()
        console.warn(`[${options.logLabel}] sendChat returned non-run accepted:`, accepted)
        await options.sendMessage(target, options.nonRunReply)
        return
      }

      outputCollection.bindRun(accepted.runId)

      if (stopController.signal.aborted) {
        outputCollection.cancel()
        console.log(`[${options.logLabel}] aborting run after sendChat for ${channelUser.username}`)
        options.server.cancelRunForThread(thread.id)
        return
      }

      const progressReporter = createToolProgressReporter({
        subscribe: (listener) => options.server.subscribe(listener),
        threadId: thread.id,
        runId: accepted.runId,
        sendMessage: (text) => options.sendMessage(target, text),
        logLabel: options.logLabel
      })

      if ('userMessage' in accepted) {
        for (const img of accepted.userMessage.images ?? []) {
          if (img.workspacePath) {
            options.server.getTtlReaper().register(img.workspacePath, options.policy.imageTtlMs)
          }
        }
      }

      let rawOutput: string | null
      try {
        rawOutput = await outputCollection.promise
      } finally {
        progressReporter.stop()
      }

      if (rawOutput === null) {
        console.log(
          `[${options.logLabel}] run cancelled for ${channelUser.username}, skipping reply update`
        )
        options.server.cancelRunForThread(thread.id)
        return
      }

      const visibleReply = formatOutboundTranscript(outboundTranscript)
      console.log(
        `[${options.logLabel}] run complete, ${liveReplies.length} live reply(s), ${outboundTranscript.length} outbound message(s): ${visibleReply.slice(0, 200)}`
      )

      options.server.updateLatestAssistantVisibleReply({
        threadId: thread.id,
        visibleReply
      })

      const totalTokens = options.server.getThreadTotalTokens(thread.id)
      if (totalTokens > 0) {
        const kTokens = Math.max(
          channelUser.usedKTokens,
          usageBaselineKTokens + toKTokens(totalTokens)
        )
        options.server.updateChannelUser({ id: channelUser.id, usedKTokens: kTokens })
        console.log(
          `[${options.logLabel}] updated usedKTokens for ${channelUser.username}: ${kTokens}k`
        )
      }
    } catch (error) {
      outputCollection?.cancel()
      console.error(`[${options.logLabel}] failed to handle allowed message`, error)
      await options.sendMessage(target, options.errorReply).catch(() => {})
    } finally {
      userStopControllers.delete(channelUser.id)
      stopHandlingIndicator()
    }
  }

  async function flushBatch(userId: string): Promise<void> {
    const batch = pendingBatches.get(userId)
    if (!batch) {
      return
    }

    pendingBatches.delete(userId)

    const joinedText = batch.messages.join('\n')
    const images = await collectResolvedImages(batch.imageDownloads)

    console.log(
      `[${options.logLabel}] flushing batch for ${batch.channelUser.username}: ${batch.messages.length} message(s), ${images.length} image(s)`
    )

    batch.stopBatchIndicator()

    const prev = userRunChain.get(batch.channelUser.id) ?? Promise.resolve()
    const next = prev.then(() =>
      handleAllowedMessage(batch.target, batch.channelUser, joinedText, images)
    )
    userRunChain.set(
      batch.channelUser.id,
      next.catch(() => {})
    )
  }

  function enqueueToBatch(
    target: TTarget,
    channelUser: ChannelUserRecord,
    text: string,
    imageDownloads: Promise<MessageImageRecord | null>[]
  ): void {
    const existing = pendingBatches.get(channelUser.id)

    if (existing) {
      existing.messages.push(text)
      existing.imageDownloads.push(...imageDownloads)
      clearTimeout(existing.timer)
      const delay = replyDelayMs()
      existing.timer = setTimeout(() => {
        void flushBatch(channelUser.id)
      }, delay)
      console.log(
        `[${options.logLabel}] appended to batch for ${channelUser.username} (${existing.messages.length} msgs, ${existing.imageDownloads.length} img(s), next flush in ${Math.round(delay)}ms)`
      )
      return
    }

    const stopBatchIndicator = options.startBatchIndicator?.(target) ?? (() => {})
    const delay = replyDelayMs()
    const timer = setTimeout(() => {
      void flushBatch(channelUser.id)
    }, delay)

    pendingBatches.set(channelUser.id, {
      messages: [text],
      imageDownloads: [...imageDownloads],
      timer,
      target,
      channelUser,
      stopBatchIndicator
    })

    console.log(
      `[${options.logLabel}] new batch for ${channelUser.username} (flush in ${Math.round(delay)}ms)`
    )
  }

  return {
    enqueueMessage(
      target: TTarget,
      channelUser: ChannelUserRecord,
      text: string,
      imageDownloads: Promise<MessageImageRecord | null>[] = []
    ): void {
      const trimmed = text.trim()
      if (
        options.handleSlashCommand &&
        imageDownloads.length === 0 &&
        !trimmed.includes('\n') &&
        trimmed.startsWith('/')
      ) {
        const spaceIdx = trimmed.indexOf(' ')
        const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
        const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

        let batchDiscarded = false
        if (options.shouldDiscardPendingBatch?.(command, channelUser, args)) {
          const pending = pendingBatches.get(channelUser.id)
          if (pending) {
            clearTimeout(pending.timer)
            pending.stopBatchIndicator()
            pendingBatches.delete(channelUser.id)
            batchDiscarded = true
            console.log(
              `[${options.logLabel}] discarded pending batch for ${channelUser.username} on slash command`
            )
          }
        }

        void options
          .handleSlashCommand(target, channelUser, command, args, { batchDiscarded })
          .then((handled) => {
            if (!handled) {
              enqueueToBatch(target, channelUser, text, imageDownloads)
            }
          })
          .catch((err) => {
            console.error(`[${options.logLabel}] slash command handler failed`, err)
            void options.sendMessage(target, options.errorReply).catch(() => {})
          })
        return
      }

      enqueueToBatch(target, channelUser, text, imageDownloads)
    },

    stop(): void {
      for (const [userId, batch] of pendingBatches) {
        clearTimeout(batch.timer)
        batch.stopBatchIndicator()
        pendingBatches.delete(userId)
        console.log(
          `[${options.logLabel}] discarded pending batch for ${batch.channelUser.username} on shutdown`
        )
      }
    },

    requestStop(channelUserId: string): void {
      userStopControllers.get(channelUserId)?.abort()
    }
  }
}
