/**
 * Discord bot service using discord.js.
 *
 * Flow for an allowed user (DM):
 *   1. Route the message through `routeDiscordMessage` for access control.
 *   2. Buffer rapid messages with a random debounce delay (3-8 s).
 *   3. When the debounce window expires, join buffered texts and run AI generation.
 *   4. Inject channel reply instruction so the model wraps its reply in
 *      <reply></reply> tags.
 *   5. Collect the full AI output from server events.
 *   6. Parse the <reply> content and send it back to Discord.
 *
 * Guild text channel messages are routed into the group monitor registry
 * (probe+tool pattern) — same architecture as Telegram and QQ groups.
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js'
import { join } from 'node:path'

import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  GroupChannelConfig,
  GroupMessageEntry,
  MessageImageRecord,
  ThreadModelOverride,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { discordPolicy } from './channelPolicy.ts'
import { createChannelReplyTool } from './channelReply.ts'
import { fetchImageAsDataUrl } from './channelImageDownload.ts'
import { buildGroupProbeMessages, formatGroupMessages } from './groupContextBuilder.ts'
import {
  createGroupMonitorRegistry,
  type GroupMonitorPersistence,
  type GroupMonitorRegistry
} from './groupMonitorRegistry.ts'
import { routeDiscordMessage, type DiscordChannelStorage } from './discord.ts'
import { EXTERNAL_SYSTEM_PROMPT } from '../runtime/prompt.ts'
import { readChannelsConfig } from '../runtime/channelsConfig.ts'
import { readUserDocument } from '../runtime/user.ts'
import { createSpeechThrottle } from './groupSpeechThrottle.ts'
import { createTool as createReadTool } from '../tools/agentTools/readTool.ts'
import { createTool as createWebReadTool } from '../tools/agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from '../tools/agentTools/webSearchTool.ts'
import { createTool as createUpdateMemoryTool } from '../tools/agentTools/updateMemoryTool.ts'
import { notifyAutoCompact } from './autoCompactNotice.ts'

import { resolveYachiyoTempWorkspaceRoot, YACHIYO_USER_FILE_NAME } from '../config/paths.ts'

/** Discord typing indicator lasts ~10 s; resend every 8 s. */
const TYPING_INTERVAL_MS = 8_000

/** Minimum debounce delay before flushing a message batch. */
const REPLY_DELAY_MIN_MS = 3_000
/** Maximum debounce delay before flushing a message batch. */
const REPLY_DELAY_MAX_MS = 8_000

/** Discord message length limit. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000

function randomReplyDelay(): number {
  return REPLY_DELAY_MIN_MS + Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS)
}

/**
 * Split a long message into chunks that fit within Discord's 2000-char limit.
 * Tries to break at newlines when possible.
 */
function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_MESSAGE_LENGTH) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining)
      break
    }

    let splitAt = remaining.lastIndexOf('\n', DISCORD_MAX_MESSAGE_LENGTH)
    if (splitAt <= 0) splitAt = DISCORD_MAX_MESSAGE_LENGTH

    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }

  return chunks
}

interface PendingBatch {
  messages: string[]
  imageDownloads: Promise<MessageImageRecord | null>[]
  timer: ReturnType<typeof setTimeout>
  channelId: string
  channelUser: ChannelUserRecord
  stopTyping: () => void
}

export interface DiscordServiceOptions {
  /** Discord bot token. */
  botToken: string
  /** Optional model override for Discord threads. */
  model?: ThreadModelOverride
  /** The Yachiyo server instance for running AI generation and storage. */
  server: YachiyoServer
  /** Group discussion config from channels.toml. */
  groupConfig?: GroupChannelConfig
  /** Global speech throttle verbosity (0–1). */
  groupVerbosity?: number
  /** Global override for active-phase check interval (ms). */
  groupCheckIntervalMs?: number
}

export interface DiscordService {
  /** Log in and connect to the Discord gateway. */
  connect: () => void
  /** Gracefully shut down the bot. */
  stop: () => Promise<void>
  /** Notify the service that a group's status changed (approved/blocked). */
  onGroupStatusChange: (group: ChannelGroupRecord) => void
  /** Send a text message to a Discord channel by channel ID. */
  sendMessage: (channelId: string, text: string) => Promise<void>
}

export function createDiscordService({
  botToken,
  model: modelOverride,
  server,
  groupConfig,
  groupVerbosity,
  groupCheckIntervalMs
}: DiscordServiceOptions): DiscordService {
  const policy = discordPolicy

  /** Per-user message buffer for debounced reply batching. */
  const pendingBatches = new Map<string, PendingBatch>()
  /** Per-user promise chain so messages are processed sequentially. */
  const userRunChain = new Map<string, Promise<void>>()

  /** Resolved bot user ID (set after login). */
  let botUserId: string | null = null

  const storage: DiscordChannelStorage = {
    findChannelUser(platform, externalUserId) {
      return server
        .listChannelUsers()
        .find((u) => u.platform === platform && u.externalUserId === externalUserId)
    },
    createChannelUser(user) {
      return server.createChannelUser(user)
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    // Partials.Channel is required for DM delivery on cold start —
    // discord.js v14 does not cache DM channels by default.
    partials: [Partials.Channel]
  })

  /** Start a periodic typing indicator; returns a stop function. */
  function startTypingLoop(channelId: string): () => void {
    const channel = client.channels.cache.get(channelId)
    const sendTyping = (): void => {
      if (channel && 'sendTyping' in channel) {
        void (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {})
      }
    }
    sendTyping()
    const timer = setInterval(sendTyping, TYPING_INTERVAL_MS)
    return () => clearInterval(timer)
  }

  /** Send a text message to a Discord channel, splitting if necessary. */
  async function sendMessage(channelId: string, text: string): Promise<void> {
    const channel = client.channels.cache.get(channelId)
    if (!channel || !('send' in channel)) return

    const chunks = splitMessage(text)
    for (const chunk of chunks) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(chunk)
    }
  }

  /** Image extensions to accept when Discord omits contentType. */
  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif'])

  /** Check if a Discord attachment is likely an image (contentType or extension). */
  function isImageAttachment(a: { contentType: string | null; name: string | null }): boolean {
    if (a.contentType?.startsWith('image/')) return true
    const ext = a.name?.split('.').pop()?.toLowerCase()
    return ext ? IMAGE_EXTENSIONS.has(ext) : false
  }

  /**
   * Download image attachments from a Discord message.
   * Returns an array of eager download promises.
   */
  function startImageDownloads(msg: Message): Promise<MessageImageRecord | null>[] {
    const imageAttachments = [...msg.attachments.values()].filter(isImageAttachment)
    const capped = imageAttachments.slice(0, policy.maxImagesPerBatch)
    return capped.map((a) => fetchImageAsDataUrl(a.url, { maxBytes: policy.maxImageBytes }))
  }

  // Wire up the Discord message handler.
  client.on(Events.MessageCreate, (msg) => {
    // Ignore messages from bots (including self).
    if (msg.author.bot) return

    if (msg.channel.isDMBased()) {
      handleDirectMessage(msg)
    } else if (msg.guild) {
      handleGuildMessage(msg)
    }
  })

  /** Handle an incoming direct message. */
  function handleDirectMessage(msg: Message): void {
    const incomingText = msg.content ?? ''
    const externalUserId = msg.author.id
    const username = msg.author.username

    const imageDownloads = startImageDownloads(msg)

    console.log(
      `[discord] inbound DM from ${username} (${externalUserId}): ${JSON.stringify(incomingText)} (${imageDownloads.length} image(s))`
    )

    const result = routeDiscordMessage({ externalUserId, username, text: incomingText }, storage)

    console.log(
      `[discord] route result: ${result.kind}${result.kind === 'allowed' ? ` (role=${result.channelUser.role})` : ''}`
    )

    const channelId = msg.channel.id

    switch (result.kind) {
      case 'blocked':
        return

      case 'pending':
        void sendMessage(channelId, result.reply)
        return

      case 'limit-exceeded':
        void sendMessage(channelId, result.reply)
        return

      case 'allowed':
        enqueueMessage(channelId, result.channelUser, incomingText, imageDownloads)
    }
  }

  /** Handle an incoming guild (server) text channel message — route into group monitor. */
  function handleGuildMessage(msg: Message): void {
    if (!groupRegistry) return

    const channelId = msg.channel.id
    const channelName =
      'name' in msg.channel ? (msg.channel.name ?? `Channel ${channelId}`) : `Channel ${channelId}`
    const guildName = msg.guild?.name ?? ''
    const groupDisplayName = guildName ? `${guildName}#${channelName}` : channelName
    const fromId = msg.author.id
    const fromUsername = msg.author.username
    const text = msg.content ?? ''

    const existing = server.findChannelGroup('discord', channelId)

    if (!existing) {
      server.createChannelGroup({
        id: `dc-group-${channelId}`,
        platform: 'discord',
        externalGroupId: channelId,
        name: groupDisplayName,
        status: 'pending',
        workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `dc-group-${channelId}`)
      })
      console.log(
        `[discord-group] new channel ${channelId} (${groupDisplayName}) registered as pending`
      )
      return
    }

    if (existing.status !== 'approved') return

    // Skip the bot's own messages — already fed into the monitor as __self__.
    if (botUserId && fromId === botUserId) return

    const hasImages = msg.attachments.some(isImageAttachment)

    // Skip messages with no text and no images — service events, embeds-only, etc.
    if (!text && !hasImages) return

    const isMention = botUserId ? msg.mentions.users.has(botUserId) : false

    // When there are no images, route immediately.
    if (!hasImages) {
      groupRegistry.routeMessage(existing.id, {
        senderName: fromUsername,
        senderExternalUserId: fromId,
        isMention,
        text,
        timestamp: Math.floor(msg.createdTimestamp / 1_000)
      })
      return
    }

    // Resolve image attachments eagerly, then route with the completed entry.
    const imagePromises = startImageDownloads(msg)
    void Promise.all(imagePromises).then((results) => {
      const images = results.filter((img): img is MessageImageRecord => img !== null)
      groupRegistry!.routeMessage(existing.id, {
        senderName: fromUsername,
        senderExternalUserId: fromId,
        isMention,
        text,
        images: images.length > 0 ? images : undefined,
        timestamp: Math.floor(msg.createdTimestamp / 1_000)
      })
    })
  }

  /**
   * Buffer an incoming message and schedule a debounced flush.
   */
  function enqueueMessage(
    channelId: string,
    channelUser: ChannelUserRecord,
    text: string,
    imageDownloads: Promise<MessageImageRecord | null>[] = []
  ): void {
    const userId = channelUser.id
    const existing = pendingBatches.get(userId)

    if (existing) {
      existing.messages.push(text)
      existing.imageDownloads.push(...imageDownloads)
      clearTimeout(existing.timer)
      const delay = randomReplyDelay()
      existing.timer = setTimeout(() => flushBatch(userId), delay)
      console.log(
        `[discord] appended to batch for ${channelUser.username} (${existing.messages.length} msgs, ${existing.imageDownloads.length} img(s), next flush in ${Math.round(delay)}ms)`
      )
      return
    }

    const stopTyping = startTypingLoop(channelId)
    const delay = randomReplyDelay()
    const timer = setTimeout(() => flushBatch(userId), delay)

    pendingBatches.set(userId, {
      messages: [text],
      imageDownloads: [...imageDownloads],
      timer,
      channelId,
      channelUser,
      stopTyping
    })

    console.log(`[discord] new batch for ${channelUser.username} (flush in ${Math.round(delay)}ms)`)
  }

  /** Flush a user's buffered messages and process them as a single request. */
  async function flushBatch(userId: string): Promise<void> {
    const batch = pendingBatches.get(userId)
    if (!batch) return
    pendingBatches.delete(userId)

    const joinedText = batch.messages.join('\n')

    const images = (await Promise.all(batch.imageDownloads)).filter(
      (img): img is MessageImageRecord => img !== null
    )

    console.log(
      `[discord] flushing batch for ${batch.channelUser.username}: ${batch.messages.length} message(s), ${images.length} image(s)`
    )

    batch.stopTyping()

    const channelUserId = batch.channelUser.id
    const prev = userRunChain.get(channelUserId) ?? Promise.resolve()
    const next = prev.then(() =>
      handleAllowedMessage(batch.channelId, batch.channelUser, joinedText, images)
    )
    userRunChain.set(
      channelUserId,
      next.catch(() => {})
    )
  }

  /** Resolve a user-specific workspace path shared across all their threads. */
  function resolveUserWorkspace(username: string): string {
    return join(resolveYachiyoTempWorkspaceRoot(), `dc-${username}`)
  }

  /** Find or create the right thread for this channel user. */
  async function resolveThread(channelUser: ChannelUserRecord): Promise<{
    thread: import('../../../shared/yachiyo/protocol.ts').ThreadRecord
    compacted: boolean
  }> {
    const workspace = resolveUserWorkspace(channelUser.username)
    const existing = server.findActiveChannelThread(channelUser.id, policy.threadReuseWindowMs)

    if (existing) {
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
          `[discord] reconciled model override on thread ${existing.id}:`,
          wantedOverride ?? 'cleared'
        )
      }

      const totalTokens = server.getThreadTotalTokens(thread.id)
      console.log(`[discord] existing thread ${thread.id} — ${totalTokens} tokens`)

      if (totalTokens < policy.contextTokenLimit) {
        return { thread, compacted: false }
      }

      console.log(
        `[discord] thread ${thread.id} exceeded ${policy.contextTokenLimit} tokens, generating rolling summary`
      )
      const { thread: compactedThread } = await server.compactExternalThread({
        threadId: existing.id
      })
      return { thread: compactedThread, compacted: true }
    }

    let thread = await server.createThread({
      workspacePath: workspace,
      source: 'discord',
      channelUserId: channelUser.id,
      title: `Discord:@${channelUser.username}`
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
    channelId: string,
    channelUser: ChannelUserRecord,
    text: string,
    images: MessageImageRecord[] = []
  ): Promise<void> {
    const stopTyping = startTypingLoop(channelId)
    try {
      console.log(
        `[discord] handling allowed message for user ${channelUser.username} (${images.length} image(s))`
      )
      const { thread: yachiyoThread, compacted } = await resolveThread(channelUser)
      console.log(
        `[discord] using thread ${yachiyoThread.id}${compacted ? ' (rolling summary generated)' : ''}`
      )
      if (compacted) {
        await notifyAutoCompact(sendMessage, channelId)
      }

      const replies: string[] = []
      const replyTool = createChannelReplyTool({
        onReply: async (message) => {
          console.log(`[discord] reply tool called: ${message.slice(0, 100)}`)
          replies.push(message)
          await sendMessage(channelId, message)
        }
      })

      const runDonePromise = collectRunOutput(server, yachiyoThread.id)

      const accepted = await server.sendChat({
        threadId: yachiyoThread.id,
        content: text,
        images: images.length > 0 ? images : undefined,
        enabledTools: policy.allowedTools,
        channelHint: policy.replyInstruction,
        extraTools: { reply: replyTool }
      })
      console.log(`[discord] sendChat accepted:`, accepted)

      if (!('runId' in accepted)) {
        console.warn('[discord] sendChat returned non-run accepted:', accepted)
        await sendMessage(channelId, 'Sorry, something went wrong on my end.')
        return
      }

      if ('userMessage' in accepted) {
        for (const img of accepted.userMessage.images ?? []) {
          if (img.workspacePath) {
            server.getTtlReaper().register(img.workspacePath, policy.imageTtlMs)
          }
        }
      }

      const rawOutput = await runDonePromise

      // Always try to send the raw output as final response, deduped against reply tool messages.
      if (rawOutput.trim()) {
        const fallback = rawOutput.trim()
        if (fallback && !replies.includes(fallback)) {
          console.log(
            `[discord] sending ${replies.length === 0 ? 'fallback' : 'deduped final'}: ${fallback.slice(0, 100)}`
          )
          await sendMessage(channelId, fallback)
          replies.push(fallback)
        }
      }

      const visibleReply = replies.join('\n')
      console.log(
        `[discord] run complete, ${replies.length} reply(s): ${visibleReply.slice(0, 200)}`
      )

      server.updateLatestAssistantVisibleReply({
        threadId: yachiyoThread.id,
        visibleReply
      })

      const totalTokens = server.getThreadTotalTokens(yachiyoThread.id)
      if (totalTokens > 0) {
        const kTokens = Math.ceil(totalTokens / 1000)
        server.updateChannelUser({ id: channelUser.id, usedKTokens: kTokens })
        console.log(`[discord] updated usedKTokens for ${channelUser.username}: ${kTokens}k`)
      }
    } catch (error) {
      console.error('[discord] failed to handle allowed message', error)
      await sendMessage(channelId, 'Something went wrong. Please try again in a moment.')
    } finally {
      stopTyping()
    }
  }

  // ------------------------------------------------------------------
  // Group discussion mode (probe+tool pattern)
  // ------------------------------------------------------------------

  let groupRegistry: GroupMonitorRegistry | null = null

  /** Build a map from Discord externalUserId → role for identity marking. */
  function buildKnownUsersMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const u of server.listChannelUsers()) {
      if (u.platform === 'discord') {
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
          console.log(`[discord-group] "${group.name}" phase → ${newPhase}`)
        }
      },
      groupCheckIntervalMs,
      bufferPersistence
    )

    // Start monitors for already-approved Discord groups.
    for (const group of server.listChannelGroups()) {
      if (group.platform === 'discord' && group.status === 'approved') {
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
        message: z.string().describe('The message to send to the group. Plain text only.')
      }),
      execute: async ({ message }) => {
        if (isDuplicateOutgoing(group.id, message)) {
          console.log(
            `[discord-group] dropped duplicate message for "${group.name}": ${message.slice(0, 80)}`
          )
          return 'Message sent.'
        }

        if (speechThrottle.shouldDrop(group.id)) {
          const rate = speechThrottle.getDropRate(group.id)
          console.log(
            `[discord-group] throttled message for "${group.name}" (drop rate ${Math.round(rate * 100)}%): ${message.slice(0, 80)}`
          )
          return 'Message sent.'
        }

        try {
          await sendMessage(group.externalGroupId, message)
          recordOutgoing(group.id, message)
          speechThrottle.recordSend(group.id)
          console.log(`[discord-group] sent reply to "${group.name}": ${message.slice(0, 100)}`)

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
          console.error(`[discord-group] failed to send message to "${group.name}"`, err)
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

    const settingsOverride = server.resolveProviderSettings(groupConfig?.model)

    console.log(
      `[discord-group] group="${group.name}" probing ${recentMessages.length} message(s) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${formatGroupMessages(recentMessages, 'Yachiyo', buildKnownUsersMap())}`
    )

    const result = await auxService.generateText({
      messages,
      tools: probeTools,
      settingsOverride
    })

    if (result.status === 'success') {
      console.log(
        `[discord-group] group="${group.name}" monologue: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`
      )
      console.log(`[discord-group] group="${group.name}" didSpeak=${didSpeak}`)
    } else {
      console.warn(
        `[discord-group] auxiliary generation ${result.status}:`,
        'error' in result ? result.error : result.status
      )
    }

    return didSpeak
  }

  return {
    connect() {
      console.log('[discord] logging in to Discord gateway')
      client.once(Events.ClientReady, (readyClient) => {
        botUserId = readyClient.user.id
        console.log(`[discord] logged in as ${readyClient.user.tag} (${botUserId})`)
      })
      void client.login(botToken)
    },
    async stop() {
      groupRegistry?.stopAll()
      for (const [userId, batch] of pendingBatches) {
        clearTimeout(batch.timer)
        batch.stopTyping()
        pendingBatches.delete(userId)
        console.log(
          `[discord] discarded pending batch for ${batch.channelUser.username} on shutdown`
        )
      }
      await client.destroy()
    },

    onGroupStatusChange(group) {
      if (group.platform !== 'discord' || !groupRegistry) return

      if (group.status === 'approved') {
        groupRegistry.startMonitor(group)
        console.log(`[discord-group] monitor started for "${group.name}" after approval`)
      } else {
        groupRegistry.stopMonitor(group.id)
        console.log(`[discord-group] monitor stopped for "${group.name}" (status=${group.status})`)
      }
    },

    sendMessage
  }
}

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

      if (event.type === 'run.cancelled') {
        unsubscribe()
        resolve('')
        return
      }

      if (event.type === 'run.failed') {
        unsubscribe()
        reject(new Error((event as YachiyoServerEvent & { error?: string }).error ?? 'Run failed'))
      }
    })
  })
}
