/**
 * Telegram bot service using Telegraf.
 *
 * Flow for an allowed user (DM):
 *   1. Route the message through `routeTelegramMessage` for access control.
 *   2. Buffer rapid messages with a random debounce delay (3-8 s).
 *   3. When the debounce window expires, join buffered texts and run AI generation.
 *   4. Inject channel reply instruction so the model wraps its reply in
 *      <reply></reply> tags.
 *   5. Collect the full AI output from server events.
 *   6. Parse the <reply> content and send it back to Telegram.
 *
 * Group messages are routed directly from the Telegraf update handler into
 * the group monitor registry (probe+tool pattern).
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { Telegraf } from 'telegraf'
import type { Message } from 'telegraf/types'

import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  GroupChannelConfig,
  GroupMessageEntry,
  MessageImageRecord,
  ThreadModelOverride,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol'
import type { YachiyoServer } from '../app/YachiyoServer'
import { telegramPolicy } from './channelPolicy'
import { fetchImageAsDataUrl } from './channelImageDownload'
import { buildGroupProbeMessages, formatGroupMessages } from './groupContextBuilder'
import { createGroupMonitorRegistry, type GroupMonitorRegistry } from './groupMonitorRegistry'
import { routeTelegramMessage, type TelegramChannelStorage } from './telegram'
import { EXTERNAL_SYSTEM_PROMPT } from '../runtime/prompt'
import { readChannelsConfig } from '../runtime/channelsConfig'
import { readUserDocument } from '../runtime/user'
import { createSpeechThrottle } from './groupSpeechThrottle'
import { createTool as createReadTool } from '../tools/agentTools/readTool'
import { createTool as createWebReadTool } from '../tools/agentTools/webReadTool'
import { createTool as createWebSearchTool } from '../tools/agentTools/webSearchTool'
import { createTool as createUpdateMemoryTool } from '../tools/agentTools/updateMemoryTool'

import { resolveYachiyoTempWorkspaceRoot, YACHIYO_USER_FILE_NAME } from '../config/paths'
import { join } from 'node:path'

/** Telegram typing indicator expires after ~5 s; resend every 4 s. */
const TYPING_INTERVAL_MS = 4_000

/** Minimum debounce delay before flushing a message batch. */
const REPLY_DELAY_MIN_MS = 3_000
/** Maximum debounce delay before flushing a message batch. */
const REPLY_DELAY_MAX_MS = 8_000

function randomReplyDelay(): number {
  return REPLY_DELAY_MIN_MS + Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS)
}

interface PendingBatch {
  messages: string[]
  imageDownloads: Promise<MessageImageRecord | null>[]
  timer: ReturnType<typeof setTimeout>
  chatId: string
  channelUser: ChannelUserRecord
  stopTyping: () => void
}

export interface TelegramServiceOptions {
  /** Telegram Bot API token. */
  botToken: string
  /** Optional model override for Telegram threads. */
  model?: ThreadModelOverride
  /** The Yachiyo server instance for running AI generation and storage. */
  server: YachiyoServer
  /** Group discussion config from channels.toml. */
  groupConfig?: GroupChannelConfig
  /** Bot's username (without @) for mention detection. */
  botUsername?: string
}

export interface TelegramService {
  /** Start long-polling. */
  startPolling: () => void
  /** Gracefully shut down the bot. */
  stop: () => Promise<void>
  /** Send a text message to a Telegram chat by chat ID. */
  sendMessage: (chatId: string, text: string) => Promise<void>
}

export function createTelegramService({
  botToken,
  model: modelOverride,
  server,
  groupConfig,
  botUsername
}: TelegramServiceOptions): TelegramService {
  const policy = telegramPolicy

  /** Per-user message buffer for debounced reply batching. */
  const pendingBatches = new Map<string, PendingBatch>()

  const storage: TelegramChannelStorage = {
    findChannelUser(platform, externalUserId) {
      const found = server
        .listChannelUsers()
        .find((u) => u.platform === platform && u.externalUserId === externalUserId)
      console.log(
        `[telegram] findChannelUser platform=${platform} id=${externalUserId} →`,
        found ? `found (${found.status})` : 'not found'
      )
      return found
    },
    createChannelUser(user) {
      console.log(`[telegram] createChannelUser`, user)
      return server.createChannelUser(user)
    }
  }

  const bot = new Telegraf(botToken)

  /** Send "typing…" chat action to the given Telegram chat. */
  function sendTyping(chatId: string): void {
    void bot.telegram.sendChatAction(chatId, 'typing').catch(() => {})
  }

  /** Start a periodic typing indicator; returns a stop function. */
  function startTypingLoop(chatId: string): () => void {
    sendTyping(chatId)
    const timer = setInterval(() => sendTyping(chatId), TYPING_INTERVAL_MS)
    return () => clearInterval(timer)
  }

  /** Send a text message to a Telegram chat. */
  async function sendMessage(chatId: string, text: string): Promise<void> {
    await bot.telegram.sendMessage(chatId, text)
  }

  /** Download a single Telegram file by file_id via getFileLink. */
  function downloadByFileId(fileId: string): Promise<MessageImageRecord | null> {
    return bot.telegram
      .getFileLink(fileId)
      .then((link) => fetchImageAsDataUrl(link.href, { maxBytes: policy.maxImageBytes }))
      .catch((err) => {
        console.warn('[telegram] failed to get file link:', err)
        return null
      })
  }

  /**
   * Extract image file IDs from a Telegram message.
   *
   * Handles compressed photos, image documents, animations (GIF), and
   * webp stickers so that all common visual media reaches the vision pipeline.
   */
  function startImageDownloads(msg: Message): Promise<MessageImageRecord | null>[] {
    const fileIds: string[] = []

    // Compressed photos — pick the largest size.
    if ('photo' in msg && msg.photo && msg.photo.length > 0) {
      fileIds.push(msg.photo[msg.photo.length - 1].file_id)
    }

    // Image files sent as documents (uncompressed).
    if ('document' in msg && msg.document?.mime_type?.startsWith('image/')) {
      fileIds.push(msg.document.file_id)
    }

    // Animations (GIF / MP4 GIF) — converted to PNG first frame by ensureVisionSafe.
    if ('animation' in msg && msg.animation) {
      fileIds.push(msg.animation.file_id)
    }

    // Static webp stickers only — animated .tgs (Lottie) and video stickers
    // are not raster images and would produce invalid data for the vision model.
    if (
      'sticker' in msg &&
      msg.sticker &&
      msg.sticker.is_animated === false &&
      !msg.sticker.is_video
    ) {
      fileIds.push(msg.sticker.file_id)
    }

    return fileIds.slice(0, policy.maxImagesPerBatch).map((id) => downloadByFileId(id))
  }

  /** Check if a message is a private (DM) chat. */
  function isPrivateChat(msg: Message): boolean {
    return msg.chat.type === 'private'
  }

  /** Check if a message is a group or supergroup chat. */
  function isGroupChat(msg: Message): boolean {
    return msg.chat.type === 'group' || msg.chat.type === 'supergroup'
  }

  // Wire up the Telegraf message handler for both DMs and groups.
  bot.on('message', (ctx) => {
    const msg = ctx.message

    if (isPrivateChat(msg)) {
      handleDirectMessage(msg)
    } else if (isGroupChat(msg)) {
      handleGroupMessage(msg)
    }
  })

  /** Handle an incoming direct message. */
  function handleDirectMessage(msg: Message): void {
    const incomingText =
      'text' in msg ? (msg.text ?? '') : 'caption' in msg ? (msg.caption ?? '') : ''
    const externalUserId = String(msg.from?.id ?? '')
    const username = msg.from?.username ?? msg.from?.first_name ?? externalUserId

    // Start image downloads eagerly — they overlap with debounce.
    const imageDownloads = startImageDownloads(msg)

    console.log(
      `[telegram] inbound DM from ${username} (${externalUserId}): ${JSON.stringify(incomingText)} (${imageDownloads.length} image(s))`
    )

    const result = routeTelegramMessage({ externalUserId, username, text: incomingText }, storage)

    console.log(
      `[telegram] route result: ${result.kind}${result.kind === 'allowed' ? ` (role=${result.channelUser.role})` : ''}`
    )

    const chatId = String(msg.chat.id)

    switch (result.kind) {
      case 'blocked':
        return

      case 'pending':
        void sendMessage(chatId, result.reply)
        return

      case 'limit-exceeded':
        void sendMessage(chatId, result.reply)
        return

      case 'allowed':
        enqueueMessage(chatId, result.channelUser, incomingText, imageDownloads)
    }
  }

  /** Handle an incoming group/supergroup message — route into group monitor. */
  function handleGroupMessage(msg: Message): void {
    if (!groupRegistry) return

    const chatId = String(msg.chat.id)
    const chatTitle = 'title' in msg.chat ? (msg.chat.title ?? '') : ''
    const fromId = String(msg.from?.id ?? '')
    const fromUsername = msg.from?.username ?? msg.from?.first_name ?? fromId
    const text = 'text' in msg ? (msg.text ?? '') : 'caption' in msg ? (msg.caption ?? '') : ''

    // Merge entities and caption_entities — mentions on media captions live in
    // caption_entities, not entities.
    const entities = [
      ...('entities' in msg ? (msg.entities ?? []) : []),
      ...('caption_entities' in msg ? (msg.caption_entities ?? []) : [])
    ]

    // Skip service updates and unsupported media that carry no text —
    // joins, title changes, voice notes, etc. should not wake the group
    // monitor or spend a probe turn on blank content.
    const hasMedia =
      ('photo' in msg && msg.photo) ||
      ('document' in msg && msg.document?.mime_type?.startsWith('image/')) ||
      ('animation' in msg && msg.animation) ||
      ('sticker' in msg &&
        msg.sticker &&
        msg.sticker.is_animated === false &&
        !msg.sticker.is_video)
    if (!text && !hasMedia) return

    const existing = server.findChannelGroup('telegram', chatId)

    if (!existing) {
      server.createChannelGroup({
        id: `tg-group-${chatId}`,
        platform: 'telegram',
        externalGroupId: chatId,
        name: chatTitle || `Telegram Group ${chatId}`,
        status: 'pending',
        workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `tg-group-${chatId}`)
      })
      console.log(`[telegram-group] new group ${chatId} registered as pending`)
      return
    }

    if (existing.status !== 'approved') return

    // Skip the bot's own messages echoed back by Telegram —
    // already fed into the monitor as __self__ from the tool closure.
    if (botUsername && fromUsername.toLowerCase() === botUsername.toLowerCase()) return

    const isMention = botUsername
      ? entities.some(
          (e) =>
            e.type === 'mention' &&
            text.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${botUsername.toLowerCase()}`
        )
      : false

    // When there are no images to download, route immediately.
    if (!hasMedia) {
      groupRegistry.routeMessage(existing.id, {
        senderName: fromUsername,
        senderExternalUserId: fromId,
        isMention,
        text,
        timestamp: msg.date
      })
      return
    }

    // Resolve images eagerly, then route with the completed entry.
    const imagePromises = startImageDownloads(msg)
    void Promise.all(imagePromises).then((results) => {
      const images = results.filter((img): img is MessageImageRecord => img !== null)
      groupRegistry!.routeMessage(existing.id, {
        senderName: fromUsername,
        senderExternalUserId: fromId,
        isMention,
        text,
        images: images.length > 0 ? images : undefined,
        timestamp: msg.date
      })
    })
  }

  /**
   * Buffer an incoming message and schedule a debounced flush.
   * If the user sends more messages before the timer fires, the timer resets
   * with a fresh random delay — so the bot waits for a natural pause.
   */
  function enqueueMessage(
    chatId: string,
    channelUser: ChannelUserRecord,
    text: string,
    imageDownloads: Promise<MessageImageRecord | null>[] = []
  ): void {
    const userId = channelUser.id
    const existing = pendingBatches.get(userId)

    if (existing) {
      // Append to existing batch, reset the debounce timer.
      existing.messages.push(text)
      existing.imageDownloads.push(...imageDownloads)
      clearTimeout(existing.timer)
      const delay = randomReplyDelay()
      existing.timer = setTimeout(() => flushBatch(userId), delay)
      console.log(
        `[telegram] appended to batch for ${channelUser.username} (${existing.messages.length} msgs, ${existing.imageDownloads.length} img(s), next flush in ${Math.round(delay)}ms)`
      )
      return
    }

    // Start a new batch with a typing indicator.
    const stopTyping = startTypingLoop(chatId)
    const delay = randomReplyDelay()
    const timer = setTimeout(() => flushBatch(userId), delay)

    pendingBatches.set(userId, {
      messages: [text],
      imageDownloads: [...imageDownloads],
      timer,
      chatId,
      channelUser,
      stopTyping
    })

    console.log(
      `[telegram] new batch for ${channelUser.username} (flush in ${Math.round(delay)}ms)`
    )
  }

  /** Flush a user's buffered messages and process them as a single request. */
  async function flushBatch(userId: string): Promise<void> {
    const batch = pendingBatches.get(userId)
    if (!batch) return
    pendingBatches.delete(userId)

    const joinedText = batch.messages.join('\n')

    // Resolve all eagerly-started image downloads.
    const images = (await Promise.all(batch.imageDownloads)).filter(
      (img): img is MessageImageRecord => img !== null
    )

    console.log(
      `[telegram] flushing batch for ${batch.channelUser.username}: ${batch.messages.length} message(s), ${images.length} image(s)`
    )

    // handleAllowedMessage manages its own typing loop, so stop the batch one.
    batch.stopTyping()

    void handleAllowedMessage(batch.chatId, batch.channelUser, joinedText, images)
  }

  /** Resolve a user-specific workspace path shared across all their threads. */
  function resolveUserWorkspace(username: string): string {
    return join(resolveYachiyoTempWorkspaceRoot(), `tg-${username}`)
  }

  /** Find or create the right thread for this channel user. */
  async function resolveThread(channelUser: ChannelUserRecord): Promise<{
    thread: import('../../../shared/yachiyo/protocol').ThreadRecord
    compacted: boolean
  }> {
    const workspace = resolveUserWorkspace(channelUser.username)
    const existing = server.findActiveChannelThread(channelUser.id, policy.threadReuseWindowMs)

    if (existing) {
      // Reconcile model override so config changes take effect on reused threads.
      let thread = existing
      const currentOverride = existing.modelOverride
      const wantedOverride =
        modelOverride?.providerName && modelOverride?.model ? modelOverride : null
      const overrideChanged =
        (currentOverride?.providerName ?? '') !== (wantedOverride?.providerName ?? '') ||
        (currentOverride?.model ?? '') !== (wantedOverride?.model ?? '')
      if (overrideChanged) {
        thread = await server.setThreadModelOverride({
          threadId: existing.id,
          modelOverride: wantedOverride
        })
        console.log(
          `[telegram] reconciled model override on thread ${existing.id}:`,
          wantedOverride ?? 'cleared'
        )
      }

      const totalTokens = server.getThreadTotalTokens(thread.id)
      console.log(`[telegram] existing thread ${thread.id} — ${totalTokens} tokens`)

      if (totalTokens < policy.contextTokenLimit) {
        return { thread, compacted: false }
      }

      // Context limit reached — generate rolling summary in-place.
      console.log(
        `[telegram] thread ${thread.id} exceeded ${policy.contextTokenLimit} tokens, generating rolling summary`
      )
      const { thread: compactedThread } = await server.compactExternalThread({
        threadId: existing.id
      })
      return { thread: compactedThread, compacted: true }
    }

    // No reusable thread — create a fresh one.
    let thread = await server.createThread({
      workspacePath: workspace,
      source: 'telegram',
      channelUserId: channelUser.id,
      title: `Telegram:@${channelUser.username}`
    })
    if (modelOverride?.providerName && modelOverride?.model) {
      thread = await server.setThreadModelOverride({
        threadId: thread.id,
        modelOverride
      })
    }
    return { thread, compacted: false }
  }

  async function handleAllowedMessage(
    chatId: string,
    channelUser: ChannelUserRecord,
    text: string,
    images: MessageImageRecord[] = []
  ): Promise<void> {
    const stopTyping = startTypingLoop(chatId)
    try {
      console.log(
        `[telegram] handling allowed message for user ${channelUser.username} (${images.length} image(s))`
      )
      const { thread: yachiyoThread, compacted } = await resolveThread(channelUser)
      console.log(
        `[telegram] using thread ${yachiyoThread.id}${compacted ? ' (rolling summary generated)' : ''}`
      )

      // Subscribe BEFORE sendChat so we don't miss early events.
      const outputPromise = collectRunOutput(server, yachiyoThread.id)

      const accepted = await server.sendChat({
        threadId: yachiyoThread.id,
        content: text,
        images: images.length > 0 ? images : undefined,
        enabledTools: policy.allowedTools,
        channelHint: policy.replyInstruction
      })
      console.log(`[telegram] sendChat accepted:`, accepted)

      if (!('runId' in accepted)) {
        console.warn('[telegram] sendChat returned non-run accepted:', accepted)
        await sendMessage(chatId, 'Sorry, something went wrong on my end.')
        return
      }

      // Register TTL for saved image files so they get cleaned up.
      if ('userMessage' in accepted) {
        for (const img of accepted.userMessage.images ?? []) {
          if (img.workspacePath) {
            server.getTtlReaper().register(img.workspacePath, policy.imageTtlMs)
          }
        }
      }

      const rawOutput = await outputPromise
      console.log(`[telegram] rawOutput:`, rawOutput.slice(0, 200))
      const parsedReply = policy.extractVisibleReply(rawOutput)
      console.log(`[telegram] parsedReply:`, parsedReply)

      if (parsedReply) {
        await sendMessage(chatId, parsedReply)
      }

      // Store the visible reply on the assistant message for future summary generation.
      server.updateLatestAssistantVisibleReply({
        threadId: yachiyoThread.id,
        visibleReply: parsedReply
      })

      // Record token usage against the channel user.
      const totalTokens = server.getThreadTotalTokens(yachiyoThread.id)
      if (totalTokens > 0) {
        const kTokens = Math.ceil(totalTokens / 1000)
        server.updateChannelUser({ id: channelUser.id, usedKTokens: kTokens })
        console.log(`[telegram] updated usedKTokens for ${channelUser.username}: ${kTokens}k`)
      }
    } catch (error) {
      console.error('[telegram] failed to handle allowed message', error)
      await sendMessage(chatId, 'Something went wrong. Please try again in a moment.')
    } finally {
      stopTyping()
    }
  }

  // ------------------------------------------------------------------
  // Group discussion mode (probe+tool pattern)
  // ------------------------------------------------------------------

  let groupRegistry: GroupMonitorRegistry | null = null

  /** Build a map from Telegram externalUserId → role for identity marking. */
  function buildKnownUsersMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const u of server.listChannelUsers()) {
      if (u.platform === 'telegram') {
        map.set(u.externalUserId, u.role)
      }
    }
    return map
  }

  const speechThrottle = createSpeechThrottle()

  /** Per-group dedup ring buffer for outgoing messages. */
  const recentOutgoing = new Map<string, { texts: string[]; timestamps: number[] }>()
  const DEDUP_WINDOW_MS = 5 * 60 * 1_000
  const DEDUP_MAX_ENTRIES = 10

  function isDuplicateOutgoing(groupId: string, message: string): boolean {
    const normalized = message.trim().toLowerCase()
    const entry = recentOutgoing.get(groupId)
    if (!entry) return false

    const now = Date.now()
    while (entry.timestamps.length > 0 && now - entry.timestamps[0] > DEDUP_WINDOW_MS) {
      entry.timestamps.shift()
      entry.texts.shift()
    }

    return entry.texts.some((t) => t === normalized)
  }

  function recordOutgoing(groupId: string, message: string): void {
    const normalized = message.trim().toLowerCase()
    let entry = recentOutgoing.get(groupId)
    if (!entry) {
      entry = { texts: [], timestamps: [] }
      recentOutgoing.set(groupId, entry)
    }
    entry.texts.push(normalized)
    entry.timestamps.push(Date.now())
    while (entry.texts.length > DEDUP_MAX_ENTRIES) {
      entry.texts.shift()
      entry.timestamps.shift()
    }
  }

  if (groupConfig?.enabled) {
    groupRegistry = createGroupMonitorRegistry(policy.groupDefaults, groupConfig, {
      async onTurn(group, recentMessages) {
        return handleGroupTurn(group, recentMessages)
      },

      onStateChange(group, newPhase) {
        console.log(`[telegram-group] "${group.name}" phase → ${newPhase}`)
      }
    })

    // Start monitors for already-approved Telegram groups.
    for (const group of server.listChannelGroups()) {
      if (group.platform === 'telegram' && group.status === 'approved') {
        groupRegistry.startMonitor(group)
      }
    }
  }

  /**
   * Single-pass probe+tool handler for group discussion.
   *
   * Returns true if the model called `send_group_message` (i.e. spoke),
   * false if it stayed silent.
   */
  async function handleGroupTurn(
    group: ChannelGroupRecord,
    recentMessages: GroupMessageEntry[]
  ): Promise<boolean> {
    const auxService = server.getAuxiliaryGenerationService()
    let didSpeak = false

    const sendGroupMessageTool = tool({
      description:
        'Send a message to the group chat. Only call this when you genuinely want to speak. Your raw text output is private and never shown to anyone.',
      inputSchema: z.object({
        message: z.string().describe('The message to send to the group. Plain text only.')
      }),
      execute: async ({ message }) => {
        if (message.includes('\n')) {
          console.log(`[telegram-group] rejected multi-line message for "${group.name}"`)
          return 'Rejected: message must be a single line. Do not include line breaks.'
        }

        if (isDuplicateOutgoing(group.id, message)) {
          console.log(
            `[telegram-group] dropped duplicate message for "${group.name}": ${message.slice(0, 80)}`
          )
          return 'Message sent.'
        }

        if (speechThrottle.shouldDrop(group.id)) {
          const rate = speechThrottle.getDropRate(group.id)
          console.log(
            `[telegram-group] throttled message for "${group.name}" (drop rate ${Math.round(rate * 100)}%): ${message.slice(0, 80)}`
          )
          return 'Message sent.'
        }

        try {
          await sendMessage(group.externalGroupId, message)
          recordOutgoing(group.id, message)
          speechThrottle.recordSend(group.id)
          console.log(`[telegram-group] sent reply to "${group.name}": ${message.slice(0, 100)}`)

          // Feed the bot's own reply back into the monitor so it sees it.
          groupRegistry!.routeMessage(group.id, {
            senderName: 'Yachiyo',
            senderExternalUserId: '__self__',
            isMention: false,
            text: message,
            timestamp: Date.now() / 1_000
          })

          didSpeak = true
          return 'Message sent.'
        } catch (err) {
          console.error(`[telegram-group] failed to send message to "${group.name}"`, err)
          return 'Failed to send message.'
        }
      }
    })

    // Read per-group USER.md (people directory, context notes).
    const userDocPath = join(group.workspacePath, YACHIYO_USER_FILE_NAME)
    const groupUserDoc = await readUserDocument({
      filePath: userDocPath,
      mode: 'group'
    })

    // Build agentic tools: read, web_read, web_search, update_memory.
    const toolContext = { workspacePath: group.workspacePath, sandboxed: true }
    const probeTools: ToolSet = {
      send_group_message: sendGroupMessageTool,
      read: createReadTool(toolContext),
      web_read: createWebReadTool(toolContext),
      web_search: createWebSearchTool(toolContext, {
        webSearchService: server.getWebSearchService()
      }),
      update_memory: createUpdateMemoryTool({
        memoryService: server.getMemoryService(),
        userDocumentPath: userDocPath
      })
    }

    const messages = buildGroupProbeMessages({
      botName: 'Yachiyo',
      groupName: group.name,
      recentMessages,
      knownUsers: buildKnownUsersMap(),
      personaSummary: EXTERNAL_SYSTEM_PROMPT,
      ownerInstruction: readChannelsConfig().guestInstruction,
      groupUserDocument: groupUserDoc?.content,
      vision: groupConfig?.vision
    })

    // Resolve model settings: group-specific override → default primary model.
    const settingsOverride = server.resolveProviderSettings(groupConfig?.model)

    console.log(
      `[telegram-group] group="${group.name}" probing ${recentMessages.length} message(s) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${formatGroupMessages(recentMessages, 'Yachiyo', buildKnownUsersMap())}`
    )

    const result = await auxService.generateText({
      messages,
      tools: probeTools,
      settingsOverride
    })

    if (result.status === 'success') {
      console.log(
        `[telegram-group] group="${group.name}" monologue: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`
      )
      console.log(`[telegram-group] group="${group.name}" didSpeak=${didSpeak}`)
    } else {
      console.warn(
        `[telegram-group] auxiliary generation ${result.status}:`,
        'error' in result ? result.error : result.status
      )
    }

    return didSpeak
  }

  return {
    startPolling() {
      console.log('[telegram] startPolling called — launching Telegraf')
      void bot.launch({ dropPendingUpdates: true })
    },
    async stop() {
      groupRegistry?.stopAll()
      // Discard pending batches on shutdown — stop timers and typing indicators.
      for (const [userId, batch] of pendingBatches) {
        clearTimeout(batch.timer)
        batch.stopTyping()
        pendingBatches.delete(userId)
        console.log(
          `[telegram] discarded pending batch for ${batch.channelUser.username} on shutdown`
        )
      }
      bot.stop()
    },
    sendMessage
  }
}

/**
 * Subscribe to server events for `threadId` and resolve with the complete
 * assistant text once the run finishes (completed or failed).
 */
function collectRunOutput(server: YachiyoServer, threadId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''

    const unsubscribe = server.subscribe((event: YachiyoServerEvent) => {
      if (!('threadId' in event) || event.threadId !== threadId) return

      if (event.type === 'message.delta') {
        buffer += (event as YachiyoServerEvent & { delta?: string }).delta ?? ''
        return
      }

      if (event.type === 'run.completed') {
        unsubscribe()
        resolve(buffer)
        return
      }

      if (event.type === 'run.failed') {
        unsubscribe()
        reject(new Error((event as YachiyoServerEvent & { error?: string }).error ?? 'Run failed'))
      }
    })
  })
}
