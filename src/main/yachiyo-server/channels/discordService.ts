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

import { Client, Events, GatewayIntentBits, Partials, type Message } from 'discord.js'

import type {
  ChannelGroupRecord,
  GroupChannelConfig,
  MessageImageRecord,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { discordPolicy, type ChannelPolicy } from './channelPolicy.ts'
import { fetchImageAsDataUrl } from './channelImageDownload.ts'
import { createChannelDirectMessageRuntime } from './channelDirectMessageRuntime.ts'
import {
  createChannelGroupDiscussionService,
  type ChannelGroupDiscussionService
} from './channelGroupDiscussionService.ts'
import { routeChannelGroupMessage } from './channelGroupRouting.ts'
import { connectWithRetry } from './connectionRetry.ts'
import { routeDiscordMessage, type DiscordChannelStorage } from './discord.ts'

/** Discord typing indicator lasts ~10 s; resend every 8 s. */
const TYPING_INTERVAL_MS = 8_000

/** Discord message length limit. */
const DISCORD_MAX_MESSAGE_LENGTH = 2000

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
  /** Effective policy with config overrides applied. Defaults to discordPolicy. */
  policy?: ChannelPolicy
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
  /** Wipe the in-memory message buffer for a group without stopping the monitor. */
  clearGroupMessages: (groupId: string) => void
}

export function createDiscordService({
  botToken,
  model: modelOverride,
  server,
  groupConfig,
  groupVerbosity,
  groupCheckIntervalMs,
  policy: policyOverride
}: DiscordServiceOptions): DiscordService {
  const policy = policyOverride ?? discordPolicy

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

  const directMessages = createChannelDirectMessageRuntime<string>({
    platform: 'discord',
    logLabel: 'discord',
    server,
    policy,
    modelOverride,
    sendMessage,
    startBatchIndicator: startTypingLoop,
    startHandlingIndicator: startTypingLoop,
    nonRunReply: 'Sorry, something went wrong on my end.',
    errorReply: 'Something went wrong. Please try again in a moment.',
    formatGuestThreadTitle: (channelUser) => `Discord:@${channelUser.username}`
  })

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
        directMessages.enqueueMessage(channelId, result.channelUser, incomingText, imageDownloads)
    }
  }

  /** Handle an incoming guild (server) text channel message — route into group monitor. */
  function handleGuildMessage(msg: Message): void {
    if (!groupDiscussion) return

    const channelId = msg.channel.id
    const channelName =
      'name' in msg.channel ? (msg.channel.name ?? `Channel ${channelId}`) : `Channel ${channelId}`
    const guildName = msg.guild?.name ?? ''
    const groupDisplayName = guildName ? `${guildName}#${channelName}` : channelName
    const fromId = msg.author.id
    const fromUsername = msg.author.username
    const text = msg.content ?? ''

    const routedGroup = routeChannelGroupMessage(
      {
        platform: 'discord',
        externalGroupId: channelId,
        name: groupDisplayName
      },
      server
    )
    if (routedGroup.kind !== 'approved') return

    // Skip the bot's own messages — already fed into the monitor as __self__.
    if (botUserId && fromId === botUserId) return

    const hasImages = msg.attachments.some(isImageAttachment)

    // Skip messages with no text and no images — service events, embeds-only, etc.
    if (!text && !hasImages) return

    const isMention = botUserId ? msg.mentions.users.has(botUserId) : false

    // When there are no images, route immediately.
    if (!hasImages) {
      groupDiscussion.routeMessage(routedGroup.group.id, {
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
        timestamp: Math.floor(msg.createdTimestamp / 1_000)
      })
    })
  }

  const groupDiscussion: ChannelGroupDiscussionService | null = groupConfig?.enabled
    ? createChannelGroupDiscussionService({
        platform: 'discord',
        logLabel: 'discord-group',
        server,
        policy,
        groupConfig,
        groupVerbosity,
        groupCheckIntervalMs,
        sendMessage: (group, message) => sendMessage(group.externalGroupId, message)
      })
    : null

  return {
    connect() {
      console.log('[discord] logging in to Discord gateway')
      client.once(Events.ClientReady, (readyClient) => {
        botUserId = readyClient.user.id
        console.log(`[discord] logged in as ${readyClient.user.tag} (${botUserId})`)
      })
      void connectWithRetry(() => client.login(botToken).then(() => {}), {
        label: 'discord',
        baseDelayMs: 3_000,
        maxDelayMs: 30_000
      })
    },
    async stop() {
      groupDiscussion?.stop()
      directMessages.stop()
      await client.destroy()
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
