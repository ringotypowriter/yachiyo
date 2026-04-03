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
  ThreadRecord,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol'
import type { YachiyoServer } from '../app/YachiyoServer'
import { telegramPolicy, type ChannelPolicy } from './channelPolicy'
import { fetchImageAsDataUrl } from './channelImageDownload'
import { createDirectMessageService, resolveDirectMessageThread } from './directMessageService.ts'
import { handleDmSlashCommand } from './dmSlashCommands.ts'
import {
  buildGroupProbeMessages,
  deriveNextGroupProbeMessageCount,
  formatGroupMessages,
  isBareSymbolMessage,
  selectGroupProbeRecentMessages
} from './groupContextBuilder'
import { describeGroupImages } from './groupImageDescriptions'
import {
  createGroupMonitorRegistry,
  type GroupMonitorPersistence,
  type GroupMonitorRegistry
} from './groupMonitorRegistry'
import { connectWithRetry } from './connectionRetry.ts'
import { routeTelegramMessage, type TelegramChannelStorage } from './telegram'
import { EXTERNAL_GROUP_PROMPT } from '../runtime/prompt'
import { readChannelsConfig } from '../runtime/channelsConfig'
import { readUserDocument } from '../runtime/user'
import { createSpeechThrottle } from './groupSpeechThrottle'
import { createTool as createReadTool } from '../tools/agentTools/readTool'
import { createTool as createWebReadTool } from '../tools/agentTools/webReadTool'
import { createTool as createWebSearchTool } from '../tools/agentTools/webSearchTool'
import { createTool as createUpdateMemoryTool } from '../tools/agentTools/updateMemoryTool'
import { notifyAutoCompact } from './autoCompactNotice'

import { resolveYachiyoTempWorkspaceRoot, YACHIYO_USER_FILE_NAME } from '../config/paths'
import { join } from 'node:path'

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

  const groupProbeMessageCountLimit = new Map<string, number>()

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

  function resolveUserWorkspace(username: string): string {
    return join(resolveYachiyoTempWorkspaceRoot(), `tg-${username}`)
  }

  async function resolveThread(
    channelUser: ChannelUserRecord
  ): Promise<{ thread: ThreadRecord; compacted: boolean }> {
    return resolveDirectMessageThread({
      logLabel: 'telegram',
      server,
      channelUser,
      policy,
      modelOverride,
      createThread: async (): Promise<ThreadRecord> =>
        server.createThread({
          workspacePath: resolveUserWorkspace(channelUser.username),
          source: 'telegram',
          channelUserId: channelUser.id,
          title: `Telegram:@${channelUser.username}`
        })
    })
  }

  const directMessages = createDirectMessageService<string>({
    logLabel: 'telegram',
    server,
    policy,
    resolveThread,
    sendMessage,
    startBatchIndicator: startTypingLoop,
    startHandlingIndicator: startTypingLoop,
    onCompacted: (chatId) => notifyAutoCompact(sendMessage, chatId),
    nonRunReply: 'Sorry, something went wrong on my end.',
    errorReply: 'Something went wrong. Please try again in a moment.',
    handleSlashCommand: (chatId, channelUser, command, args) =>
      handleDmSlashCommand(
        {
          server,
          threadReuseWindowMs: policy.threadReuseWindowMs,
          contextTokenLimit: policy.contextTokenLimit,
          createFreshThread: (user) =>
            server.createThread({
              workspacePath: resolveUserWorkspace(user.username),
              source: 'telegram',
              channelUserId: user.id,
              title: `Telegram:@${user.username}`
            }),
          sendMessage
        },
        chatId,
        channelUser,
        command,
        args
      )
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
    void Promise.all(imagePromises).then(async (results) => {
      const images = results.filter((img): img is MessageImageRecord => img !== null)
      await describeGroupImages({
        server,
        text,
        images,
        logLabel: 'telegram-group'
      })
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

  const speechThrottle = createSpeechThrottle(groupVerbosity ?? 0)

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
    const bufferPersistence: GroupMonitorPersistence = {
      save(groupId, phase, buffer) {
        server.getStorage().saveGroupMonitorBuffer({
          groupId,
          phase,
          buffer,
          savedAt: new Date().toISOString()
        })
      },
      load(groupId) {
        const data = server.getStorage().loadGroupMonitorBuffer(groupId)
        if (!data) return undefined
        return { phase: data.phase as 'dormant' | 'active' | 'engaged', buffer: data.buffer }
      },
      delete(groupId) {
        server.getStorage().deleteGroupMonitorBuffer(groupId)
      }
    }

    groupRegistry = createGroupMonitorRegistry(
      policy.groupDefaults,
      groupConfig,
      {
        async onTurn(group, recentMessages) {
          return handleGroupTurn(group, recentMessages)
        },

        onStateChange(group, newPhase) {
          console.log(`[telegram-group] "${group.name}" phase → ${newPhase}`)
        }
      },
      groupCheckIntervalMs,
      bufferPersistence
    )

    // Start monitors for already-approved Telegram groups.
    for (const group of server.listChannelGroups()) {
      if (group.platform === 'telegram' && group.status === 'approved') {
        groupRegistry.startMonitor(group)
        // Seed dedup from restored __self__ messages so the bot doesn't repeat itself.
        for (const msg of groupRegistry.getRecentMessages(group.id)) {
          if (msg.senderExternalUserId === '__self__') {
            recordOutgoing(group.id, msg.text)
          }
        }
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
        message: z
          .string()
          .describe('The message to send to the group. Plain text only. Never start with a colon.')
      }),
      execute: async ({ message }) => {
        if (message.includes('\n')) {
          console.log(`[telegram-group] rejected multi-line message for "${group.name}"`)
          return 'Rejected: message must be a single line. Do not include line breaks.'
        }

        if (isBareSymbolMessage(message)) {
          console.log(
            `[telegram-group] rejected bare-symbol message for "${group.name}": ${message}`
          )
          return 'Rejected: message contains only punctuation. Write actual words or stay silent.'
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
        userDocumentPath: userDocPath,
        userDocumentMode: 'group',
        rejectFullRewrite: true
      })
    }

    // Resolve model settings: group-specific override -> default primary model.
    const settingsOverride = server.resolveProviderSettings(groupConfig?.model)

    const messageCountLimit = groupProbeMessageCountLimit.get(group.id)
    const probeRecentMessages = selectGroupProbeRecentMessages(recentMessages, messageCountLimit)
    const messages = buildGroupProbeMessages({
      botName: 'Yachiyo',
      groupName: group.name,
      recentMessages: probeRecentMessages,
      knownUsers: buildKnownUsersMap(),
      personaSummary: EXTERNAL_GROUP_PROMPT,
      ownerInstruction: readChannelsConfig().guestInstruction,
      groupUserDocument: groupUserDoc?.content
    })

    console.log(
      `[telegram-group] group="${group.name}" probing ${probeRecentMessages.length}/${recentMessages.length} message(s) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${formatGroupMessages(probeRecentMessages, 'Yachiyo', buildKnownUsersMap())}`
    )

    const result = await auxService.generateText({
      messages,
      max_token: server.resolveMaxChatToken(),
      tools: probeTools,
      settingsOverride
    })

    if (result.status === 'success') {
      const nextMessageCountLimit = deriveNextGroupProbeMessageCount({
        currentMessageCount: probeRecentMessages.length,
        availableMessageCount: recentMessages.length,
        totalPromptTokens: result.usage?.totalPromptTokens,
        contextTokenLimit: policy.groupContextTokenLimit
      })
      const previousMessageCountLimit = groupProbeMessageCountLimit.get(group.id)
      if (nextMessageCountLimit == null) {
        groupProbeMessageCountLimit.delete(group.id)
      } else {
        groupProbeMessageCountLimit.set(group.id, nextMessageCountLimit)
      }
      if (previousMessageCountLimit !== nextMessageCountLimit) {
        console.log(
          `[telegram-group] group="${group.name}" moved token window ${previousMessageCountLimit ?? 'full'} -> ${nextMessageCountLimit ?? 'full'} message(s) after promptTokens=${result.usage?.totalPromptTokens ?? 'unknown'}`
        )
      }
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
      void connectWithRetry(() => bot.launch({ dropPendingUpdates: true }), {
        label: 'telegram',
        baseDelayMs: 3_000,
        maxDelayMs: 30_000
      })
    },
    async stop() {
      groupRegistry?.stopAll()
      directMessages.stop()
      bot.stop()
    },
    onGroupStatusChange(group) {
      if (group.platform !== 'telegram' || !groupRegistry) return

      if (group.status === 'approved') {
        groupRegistry.startMonitor(group)
        console.log(`[telegram-group] monitor started for "${group.name}" after approval`)
      } else {
        groupRegistry.stopMonitor(group.id)
        console.log(`[telegram-group] monitor stopped for "${group.name}" (status=${group.status})`)
      }
    },
    sendMessage,
    clearGroupMessages(groupId: string) {
      groupRegistry?.clearGroupMessages(groupId)
    }
  }
}
