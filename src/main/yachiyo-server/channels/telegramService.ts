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

import { Telegraf } from 'telegraf'
import type { Message } from 'telegraf/types'

import type {
  ChannelGroupRecord,
  GroupChannelConfig,
  MessageImageRecord,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol'
import type { YachiyoServer } from '../app/YachiyoServer'
import { telegramPolicy, type ChannelPolicy } from './channelPolicy'
import { fetchImageAsDataUrl } from './channelImageDownload'
import { createChannelDirectMessageRuntime } from './channelDirectMessageRuntime.ts'
import {
  createChannelGroupDiscussionService,
  type ChannelGroupDiscussionService
} from './channelGroupDiscussionService.ts'
import { routeChannelGroupMessage } from './channelGroupRouting.ts'
import { connectWithRetry } from './connectionRetry.ts'
import { routeTelegramMessage, type TelegramChannelStorage } from './telegram'
import { splitTelegramMessage } from './telegramMessageSplit.ts'

/** Telegram typing indicator expires after ~5 s; resend every 4 s. */
const TYPING_INTERVAL_MS = 4_000

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
  /** Global speech throttle verbosity (0–1). */
  groupVerbosity?: number
  /** Global override for active-phase check interval (ms). */
  groupCheckIntervalMs?: number
  /** Effective policy with config overrides applied. Defaults to telegramPolicy. */
  policy?: ChannelPolicy
}

export interface TelegramService {
  /** Start long-polling. */
  startPolling: () => void
  /** Gracefully shut down the bot. */
  stop: () => Promise<void>
  /** Notify the service that a group's status changed (approved/blocked). */
  onGroupStatusChange: (group: ChannelGroupRecord) => void
  /** Send a text message to a Telegram chat by chat ID. */
  sendMessage: (chatId: string, text: string) => Promise<void>
  /** Wipe the in-memory message buffer for a group without stopping the monitor. */
  clearGroupMessages: (groupId: string) => void
}

export function createTelegramService({
  botToken,
  model: modelOverride,
  server,
  groupConfig,
  botUsername,
  groupVerbosity,
  groupCheckIntervalMs,
  policy: policyOverride
}: TelegramServiceOptions): TelegramService {
  const policy = policyOverride ?? telegramPolicy

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
    for (const chunk of splitTelegramMessage(text)) {
      await bot.telegram.sendMessage(chatId, chunk)
    }
  }

  const directMessages = createChannelDirectMessageRuntime<string>({
    platform: 'telegram',
    logLabel: 'telegram',
    server,
    policy,
    modelOverride,
    sendMessage,
    startBatchIndicator: startTypingLoop,
    startHandlingIndicator: startTypingLoop,
    nonRunReply: 'Sorry, something went wrong on my end.',
    errorReply: 'Something went wrong. Please try again in a moment.',
    formatGuestThreadTitle: (channelUser) => `Telegram:@${channelUser.username}`
  })

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
        directMessages.enqueueMessage(chatId, result.channelUser, incomingText, imageDownloads)
    }
  }

  /** Handle an incoming group/supergroup message — route into group monitor. */
  function handleGroupMessage(msg: Message): void {
    if (!groupDiscussion) return

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

    const routedGroup = routeChannelGroupMessage(
      {
        platform: 'telegram',
        externalGroupId: chatId,
        name: chatTitle || `Telegram Group ${chatId}`
      },
      server
    )
    if (routedGroup.kind !== 'approved') return

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
      groupDiscussion.routeMessage(routedGroup.group.id, {
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
    void Promise.all(imagePromises).then(async (results) => {
      const images = results.filter((img): img is MessageImageRecord => img !== null)
      await groupDiscussion.describeImages({
        text,
        images
      })
      groupDiscussion.routeMessage(routedGroup.group.id, {
        senderName: fromUsername,
        senderExternalUserId: fromId,
        isMention,
        text,
        images: images.length > 0 ? images : undefined,
        timestamp: msg.date
      })
    })
  }

  const groupDiscussion: ChannelGroupDiscussionService | null = groupConfig?.enabled
    ? createChannelGroupDiscussionService({
        platform: 'telegram',
        logLabel: 'telegram-group',
        server,
        policy,
        groupConfig,
        groupVerbosity,
        groupCheckIntervalMs,
        rejectMultilineMessages: true,
        sendMessage: (group, message) => sendMessage(group.externalGroupId, message)
      })
    : null

  return {
    startPolling() {
      console.log('[telegram] startPolling called — launching Telegraf')
      void connectWithRetry(() => bot.launch({ dropPendingUpdates: true }), {
        label: 'telegram',
        baseDelayMs: 3_000,
        maxDelayMs: 30_000
      })
    },
    async stop() {
      groupDiscussion?.stop()
      directMessages.stop()
      bot.stop()
    },
    onGroupStatusChange(group) {
      groupDiscussion?.onGroupStatusChange(group)
    },
    sendMessage,
    clearGroupMessages(groupId: string) {
      groupDiscussion?.clearGroupMessages(groupId)
    }
  }
}
