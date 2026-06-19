import { constants } from 'node:fs'
import { mkdtemp, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'

import type {
  ChannelUserRecord,
  ChatAccepted,
  MessageImageRecord,
  SelectableRunModeId,
  SendChatAttachment,
  SendChatInput,
  ThreadModelOverride,
  ThreadRecord,
  ToolCallName,
  UpdateChannelUserInput,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { resolveRunModeEnabledTools } from '@yachiyo/shared/toolModes'
import {
  classifyChannelReplyAttachmentDelivery,
  createChannelReplyTool,
  type ChannelReplyAttachment,
  type ChannelReplyPayload
} from '../shared/channelReply.ts'
import { createToolProgressReporter } from '../shared/channelToolProgressReporter.ts'
import type { ChannelPolicy } from '../shared/channelPolicy.ts'

const REPLY_DELAY_MIN_MS = 3_000
const REPLY_DELAY_MAX_MS = 8_000

type DirectMessageSendChatInput = SendChatInput & { toolPreset?: ToolCallName[] }

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

/**
 * The mode an owner DM thread runs as before the owner picks one with `/mode`.
 * Owners are trusted (it's the user on their own phone), so the default matches
 * the desktop default — full tools — rather than the read-only guest sandbox.
 */
export const OWNER_DEFAULT_CHANNEL_MODE: SelectableRunModeId = 'auto'

/**
 * Owner DMs may switch their conversation mode via `/mode`, so an owner thread's
 * tools come from its `runMode` (defaulting to {@link OWNER_DEFAULT_CHANNEL_MODE}).
 * Guests stay on the channel policy's read-only sandbox regardless of thread mode.
 */
export function resolveChannelToolPreset(
  channelUser: ChannelUserRecord,
  thread: ThreadRecord,
  policyAllowedTools: ToolCallName[]
): ToolCallName[] {
  if (channelUser.role !== 'owner') {
    return policyAllowedTools
  }
  const mode = thread.runMode
  const resolved =
    mode === 'auto' || mode === 'explore' || mode === 'plan' || mode === 'chat'
      ? mode
      : OWNER_DEFAULT_CHANNEL_MODE
  return resolveRunModeEnabledTools(resolved)
}

export interface DirectMessageServer {
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  sendChat(input: DirectMessageSendChatInput): Promise<ChatAccepted>
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
  const usesChannelModel = channelUser.role === 'guest'
  const wantedOverride = usesChannelModel ? toWantedModelOverride(modelOverride) : null

  const createResolvedThread = async (
    input?: DirectMessageCreateThreadInput,
    inheritedModelOverride?: ThreadModelOverride
  ): Promise<ThreadRecord> => {
    let thread = await createThread(input)
    const overrideToApply = usesChannelModel ? wantedOverride : inheritedModelOverride
    if (overrideToApply) {
      thread = await server.setThreadModelOverride({
        threadId: thread.id,
        modelOverride: overrideToApply
      })
    }
    return thread
  }

  if (existing) {
    let thread = existing
    if (usesChannelModel) {
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
    }

    const totalTokens = server.getThreadTotalTokens(thread.id)
    const currentThreadKTokens = toKTokens(totalTokens)
    console.log(`[${logLabel}] existing thread ${thread.id} — ${totalTokens} tokens`)
    if (policy.contextTokenLimit > 0 && totalTokens >= policy.contextTokenLimit) {
      console.log(
        `[${logLabel}] thread ${thread.id} reached ${totalTokens}/${policy.contextTokenLimit} tokens; creating handoff thread`
      )
      return {
        thread: await createResolvedThread(
          {
            handoffFromThreadId: thread.id,
            ...(thread.workspacePath ? { workspacePath: thread.workspacePath } : {})
          },
          thread.modelOverride
        ),
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
  sendReply?(target: TTarget, payload: ChannelReplyPayload): Promise<void>
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
  /**
   * Resolves plain text into a command when a prior slash command is waiting for follow-up input.
   */
  resolvePlainTextCommand?(
    channelUser: ChannelUserRecord,
    text: string
  ): { command: string; args: string } | null
}

export interface DirectMessageService<TTarget> {
  enqueueMessage(
    target: TTarget,
    channelUser: ChannelUserRecord,
    text: string,
    attachmentDownloads?: Promise<DirectMessageInboundAttachment | null>[]
  ): void
  stop(): void
  /** Abort any in-flight message handling for the given channel user. */
  requestStop(channelUserId: string): void
}

interface PendingBatch<TTarget> {
  messages: string[]
  attachmentDownloads: Promise<DirectMessageInboundAttachment | null>[]
  timer: ReturnType<typeof setTimeout>
  target: TTarget
  channelUser: ChannelUserRecord
  stopBatchIndicator: () => void
}

export type DirectMessageInboundAttachment =
  | { kind: 'image'; image: MessageImageRecord }
  | { kind: 'file'; attachment: SendChatAttachment }

function offsetInboundAttachmentIndex(
  download: Promise<DirectMessageInboundAttachment | null>,
  offset: number
): Promise<DirectMessageInboundAttachment | null> {
  if (offset === 0) return download
  return download.then((attachment) => {
    if (!attachment) return null
    if (attachment.kind === 'image') {
      return {
        kind: 'image',
        image: {
          ...attachment.image,
          attachmentIndex:
            (attachment.image.attachmentIndex ?? 0) > 0
              ? attachment.image.attachmentIndex! + offset
              : undefined
        }
      }
    }
    return {
      kind: 'file',
      attachment: {
        ...attachment.attachment,
        attachmentIndex:
          (attachment.attachment.attachmentIndex ?? 0) > 0
            ? attachment.attachment.attachmentIndex! + offset
            : undefined
      }
    }
  })
}

function offsetInboundAttachmentDownloads(
  downloads: Promise<DirectMessageInboundAttachment | null>[],
  offset: number
): Promise<DirectMessageInboundAttachment | null>[] {
  return downloads.map((download) => offsetInboundAttachmentIndex(download, offset))
}

async function collectResolvedAttachments(
  attachmentDownloads: Promise<DirectMessageInboundAttachment | null>[]
): Promise<{ images: MessageImageRecord[]; attachments: SendChatAttachment[] }> {
  const results = await Promise.all(attachmentDownloads)
  return {
    images: results.flatMap((result) => (result?.kind === 'image' ? [result.image] : [])),
    attachments: results.flatMap((result) => (result?.kind === 'file' ? [result.attachment] : []))
  }
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

function formatAttachmentTranscriptLine(attachment: ChannelReplyAttachment): string {
  return `[Attachment: ${attachment.filename ?? basename(attachment.path)}]`
}

function formatOutboundReplyTranscript(payload: ChannelReplyPayload): string {
  return [
    payload.message?.trim() ?? '',
    ...(payload.attachments ?? []).map(formatAttachmentTranscriptLine)
  ]
    .filter(Boolean)
    .join('\n')
}

function expandHomePath(path: string): string {
  if (path === '~') {
    return homedir()
  }
  if (path.startsWith('~/')) {
    return `${homedir()}${path.slice(1)}`
  }
  return path
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const rel = relative(basePath, targetPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function sanitizeSnapshotFilename(filename: string): string {
  return basename(filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'attachment'
}

async function createAttachmentSnapshot(input: {
  sourcePath: string
  filename: string
}): Promise<{ path: string; dir: string; sizeBytes: number }> {
  const snapshotBaseDir = join(homedir(), '.yachiyo', 'channel-reply-attachments')
  await mkdir(snapshotBaseDir, { recursive: true, mode: 0o700 })
  const snapshotDir = await mkdtemp(join(snapshotBaseDir, 'reply-'))
  const snapshotPath = join(snapshotDir, sanitizeSnapshotFilename(input.filename))
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(input.sourcePath, flags).catch(() => null)
  if (!handle) {
    await rm(snapshotDir, { recursive: true, force: true })
    throw new Error(`Reply attachment is not a readable file: ${input.sourcePath}`)
  }

  try {
    const fileStat = await handle.stat()
    if (!fileStat.isFile()) {
      throw new Error(`Reply attachment is not a readable file: ${input.sourcePath}`)
    }
    await writeFile(snapshotPath, await handle.readFile(), { mode: 0o600 })
    return { path: snapshotPath, dir: snapshotDir, sizeBytes: fileStat.size }
  } catch (error) {
    await rm(snapshotDir, { recursive: true, force: true })
    throw error
  } finally {
    await handle.close().catch(() => {})
  }
}

async function cleanupAttachmentSnapshots(dirs: readonly string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
}

interface ResolvedOutboundReplyAttachments {
  attachments: ChannelReplyAttachment[]
  snapshotDirs: string[]
}

async function resolveOutboundReplyAttachments(
  attachments: ChannelReplyAttachment[] = []
): Promise<ResolvedOutboundReplyAttachments> {
  const resolved: ChannelReplyAttachment[] = []
  const snapshotDirs: string[] = []
  const homePath = attachments.length > 0 ? await realpath(homedir()) : ''
  try {
    for (const attachment of attachments) {
      const path = expandHomePath(attachment.path.trim())
      const realFilePath = await realpath(path).catch(() => null)
      if (!realFilePath || !isPathInside(homePath, realFilePath)) {
        throw new Error(`Reply attachment is outside the allowed home directory: ${path}`)
      }

      const filename = attachment.filename?.trim() || basename(realFilePath)
      const mediaType = attachment.mediaType?.trim()
      const snapshot = await createAttachmentSnapshot({ sourcePath: realFilePath, filename })
      snapshotDirs.push(snapshot.dir)
      resolved.push({
        path: snapshot.path,
        filename,
        deliveryKind: classifyChannelReplyAttachmentDelivery({
          filename,
          mediaType,
          sizeBytes: snapshot.sizeBytes
        }),
        sizeBytes: snapshot.sizeBytes,
        ...(mediaType ? { mediaType } : {})
      })
    }
  } catch (error) {
    await cleanupAttachmentSnapshots(snapshotDirs)
    throw error
  }
  return { attachments: resolved, snapshotDirs }
}

async function appendOutboundReplyMessage(input: {
  payload: ChannelReplyPayload
  outboundTranscript: string[]
  dedupeAgainst?: readonly string[]
  logLabel: string
  sendText(message: string): Promise<void>
  sendReply(payload: ChannelReplyPayload): Promise<void>
}): Promise<{ transcriptEntry: string; message: string } | null> {
  const message = input.payload.message?.trim() ?? ''
  const { attachments, snapshotDirs } = await resolveOutboundReplyAttachments(
    input.payload.attachments
  )
  if (!message && attachments.length === 0) {
    return null
  }
  if (attachments.length === 0 && input.dedupeAgainst?.includes(message)) {
    return null
  }

  const payload: ChannelReplyPayload = {
    ...(message ? { message } : {}),
    ...(attachments.length > 0 ? { attachments } : {})
  }

  console.log(
    `[${input.logLabel}] sending outbound reply${
      attachments.length > 0 ? ` with ${attachments.length} attachment(s)` : ''
    }: ${(message || attachments.map((a) => a.filename ?? basename(a.path)).join(', ')).slice(0, 100)}`
  )

  if (attachments.length > 0) {
    try {
      await input.sendReply(payload)
    } finally {
      await cleanupAttachmentSnapshots(snapshotDirs)
    }
  } else {
    await input.sendText(message)
  }

  const transcriptEntry = formatOutboundReplyTranscript(payload)
  input.outboundTranscript.push(transcriptEntry)
  return { transcriptEntry, message }
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
    images: MessageImageRecord[],
    attachments: SendChatAttachment[]
  ): Promise<void> {
    const stopHandlingIndicator = options.startHandlingIndicator?.(target) ?? (() => {})
    const stopController = new AbortController()
    userStopControllers.set(channelUser.id, stopController)
    let outputCollection: DirectMessageRunOutputCollection | null = null

    try {
      console.log(
        `[${options.logLabel}] handling allowed message for user ${channelUser.username} (${images.length} image(s), ${attachments.length} file attachment(s))`
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
      const canSendFileAttachments = channelUser.role === 'owner' && options.sendReply != null
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
      const queueOutboundReplyMessage = (input: {
        payload: ChannelReplyPayload
        dedupeAgainst?: readonly string[]
        recordLiveReply?: boolean
      }): Promise<void> => {
        outboundQueue = outboundQueue.then(async () => {
          const payload: ChannelReplyPayload = {
            ...(input.payload.message?.trim() ? { message: input.payload.message.trim() } : {}),
            ...(canSendFileAttachments && input.payload.attachments?.length
              ? { attachments: input.payload.attachments }
              : {})
          }
          const sent = await appendOutboundReplyMessage({
            payload,
            outboundTranscript,
            dedupeAgainst: input.dedupeAgainst,
            logLabel: options.logLabel,
            sendText: (message) => options.sendMessage(target, message),
            sendReply: (payload) => {
              if (!options.sendReply) {
                throw new Error('File attachments are not supported by this channel.')
              }
              return options.sendReply(target, payload)
            }
          })
          if (sent?.message && input.recordLiveReply) {
            liveReplies.push(sent.message)
          }
        })
        return outboundQueue
      }
      const replyTool = createChannelReplyTool({
        allowFileAttachments: canSendFileAttachments,
        onReply: async (payload: ChannelReplyPayload): Promise<void> => {
          const message = payload.message?.trim() ?? ''
          console.log(`[${options.logLabel}] reply tool called: ${message.slice(0, 100)}`)
          await queueOutboundReplyMessage({
            payload,
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
        attachments: attachments.length > 0 ? attachments : undefined,
        toolPreset: resolveChannelToolPreset(channelUser, thread, options.policy.allowedTools),
        runTrigger: 'channel',
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
    const { images, attachments } = await collectResolvedAttachments(batch.attachmentDownloads)

    console.log(
      `[${options.logLabel}] flushing batch for ${batch.channelUser.username}: ${batch.messages.length} message(s), ${images.length} image(s), ${attachments.length} file attachment(s)`
    )

    batch.stopBatchIndicator()

    const prev = userRunChain.get(batch.channelUser.id) ?? Promise.resolve()
    const next = prev.then(() =>
      handleAllowedMessage(batch.target, batch.channelUser, joinedText, images, attachments)
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
    attachmentDownloads: Promise<DirectMessageInboundAttachment | null>[]
  ): void {
    const existing = pendingBatches.get(channelUser.id)

    if (existing) {
      const attachmentIndexOffset = existing.attachmentDownloads.length
      existing.messages.push(text)
      existing.attachmentDownloads.push(
        ...offsetInboundAttachmentDownloads(attachmentDownloads, attachmentIndexOffset)
      )
      clearTimeout(existing.timer)
      const delay = replyDelayMs()
      existing.timer = setTimeout(() => {
        void flushBatch(channelUser.id)
      }, delay)
      console.log(
        `[${options.logLabel}] appended to batch for ${channelUser.username} (${existing.messages.length} msgs, ${existing.attachmentDownloads.length} attachment(s), next flush in ${Math.round(delay)}ms)`
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
      attachmentDownloads: offsetInboundAttachmentDownloads(attachmentDownloads, 0),
      timer,
      target,
      channelUser,
      stopBatchIndicator
    })

    console.log(
      `[${options.logLabel}] new batch for ${channelUser.username} (flush in ${Math.round(delay)}ms)`
    )
  }

  function discardPendingBatchForCommand(
    channelUser: ChannelUserRecord,
    command: string,
    args: string
  ): boolean {
    if (!options.shouldDiscardPendingBatch?.(command, channelUser, args)) {
      return false
    }

    const pending = pendingBatches.get(channelUser.id)
    if (!pending) {
      return false
    }

    clearTimeout(pending.timer)
    pending.stopBatchIndicator()
    pendingBatches.delete(channelUser.id)
    console.log(
      `[${options.logLabel}] discarded pending batch for ${channelUser.username} on command`
    )
    return true
  }

  function handleCommandMessage(
    target: TTarget,
    channelUser: ChannelUserRecord,
    command: string,
    args: string,
    text: string,
    attachmentDownloads: Promise<DirectMessageInboundAttachment | null>[]
  ): void {
    if (!options.handleSlashCommand) {
      enqueueToBatch(target, channelUser, text, attachmentDownloads)
      return
    }

    const batchDiscarded = discardPendingBatchForCommand(channelUser, command, args)

    void options
      .handleSlashCommand(target, channelUser, command, args, { batchDiscarded })
      .then((handled) => {
        if (!handled) {
          enqueueToBatch(target, channelUser, text, attachmentDownloads)
        }
      })
      .catch((err) => {
        console.error(`[${options.logLabel}] command handler failed`, err)
        void options.sendMessage(target, options.errorReply).catch(() => {})
      })
  }

  return {
    enqueueMessage(
      target: TTarget,
      channelUser: ChannelUserRecord,
      text: string,
      attachmentDownloads: Promise<DirectMessageInboundAttachment | null>[] = []
    ): void {
      const trimmed = text.trim()
      if (
        options.handleSlashCommand &&
        attachmentDownloads.length === 0 &&
        !trimmed.includes('\n') &&
        trimmed.startsWith('/')
      ) {
        const spaceIdx = trimmed.indexOf(' ')
        const command = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
        const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()

        handleCommandMessage(target, channelUser, command, args, text, attachmentDownloads)
        return
      }

      const resolvedPlainCommand =
        options.handleSlashCommand && attachmentDownloads.length === 0 && !trimmed.includes('\n')
          ? options.resolvePlainTextCommand?.(channelUser, trimmed)
          : null
      if (resolvedPlainCommand) {
        handleCommandMessage(
          target,
          channelUser,
          resolvedPlainCommand.command,
          resolvedPlainCommand.args,
          text,
          attachmentDownloads
        )
        return
      }

      enqueueToBatch(target, channelUser, text, attachmentDownloads)
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
