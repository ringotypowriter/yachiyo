/**
 * QQ bot service via NapCatQQ (OneBot v11 WebSocket).
 *
 * Same architecture as telegramService.ts:
 *   1. Route message through access control.
 *   2. Debounce-buffer rapid messages per user (3-8 s random window).
 *   3. Flush buffered texts as a single AI request.
 *   4. Extract <reply> content and send back via OneBot API.
 *
 * Group discussion uses the probe+tool pattern: a single auxiliary model call
 * with a `send_group_message` tool. Raw text = private monologue, tool call = speech.
 */

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  GroupChannelConfig,
  GroupMessageEntry,
  MessageImageRecord,
  ThreadRecord,
  ThreadModelOverride
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'
import { qqPolicy, type ChannelPolicy } from './channelPolicy.ts'
import { createDirectMessageService, resolveDirectMessageThread } from './directMessageService.ts'
import { handleDmSlashCommand } from './dmSlashCommands.ts'
import {
  detectMediaTypeFromBytes,
  ensureVisionSafe,
  fetchImageAsDataUrl
} from './channelImageDownload.ts'
import {
  buildGroupProbeMessages,
  deriveNextGroupProbeMessageCount,
  formatGroupMessages,
  isBareSymbolMessage,
  selectGroupProbeRecentMessages
} from './groupContextBuilder.ts'
import {
  appendGroupReplyHistory,
  type GroupReplyHistory,
  hasForbiddenGroupReplyPrefix,
  hasVisibleGroupReplyContent,
  shouldSuppressGroupReply
} from './groupReplyGuard.ts'
import { describeGroupImages } from './groupImageDescriptions.ts'
import {
  createGroupMonitorRegistry,
  type GroupMonitorPersistence,
  type GroupMonitorRegistry
} from './groupMonitorRegistry.ts'
import { createGroupTurnSendGuard } from './groupTurnSendGuard.ts'
import { parseCQImages, type CQImageRef } from './qqImageParsing.ts'
import { resolveCQCodes, extractReplyId } from './qqCQCodes.ts'
import { createOneBotClient, type OneBotClient } from './onebotClient.ts'
import { routeQQMessage, type QQChannelStorage } from './qq.ts'
import { EXTERNAL_GROUP_PROMPT } from '../runtime/prompt.ts'
import { readChannelsConfig } from '../runtime/channelsConfig.ts'
import { readUserDocument } from '../runtime/user.ts'
import { YACHIYO_USER_FILE_NAME } from '../config/paths.ts'
import { createSpeechThrottle } from './groupSpeechThrottle.ts'
import { createTool as createReadTool } from '../tools/agentTools/readTool.ts'
import { createTool as createWebReadTool } from '../tools/agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from '../tools/agentTools/webSearchTool.ts'
import { createTool as createUpdateProfileTool } from '../tools/agentTools/updateProfileTool.ts'
import { notifyAutoCompact } from './autoCompactNotice.ts'

export interface QQServiceOptions {
  /** NapCatQQ forward WebSocket URL. */
  wsUrl: string
  /** Optional auth token. */
  token?: string
  /** Optional model override for QQ threads. */
  model?: ThreadModelOverride
  /** The Yachiyo server instance. */
  server: YachiyoServer
  /** Group discussion config from channels.toml. */
  groupConfig?: GroupChannelConfig
  /** Bot's own QQ user ID (to detect @mentions). */
  botQQId?: string
  /** Global speech throttle verbosity (0–1). */
  groupVerbosity?: number
  /** Global override for active-phase check interval (ms). */
  groupCheckIntervalMs?: number
  /** Effective policy with config overrides applied. Defaults to qqPolicy. */
  policy?: ChannelPolicy
}

export interface QQService {
  connect: () => void
  stop: () => Promise<void>
  /** Notify the service that a group's status changed (approved/blocked). */
  onGroupStatusChange: (group: ChannelGroupRecord) => void
  /** Send a private message to a QQ user by numeric user ID. */
  sendPrivateMessage: (userId: number, text: string) => Promise<void>
  /** Send a message to a QQ group by numeric group ID. */
  sendGroupMessage: (groupId: number, text: string) => Promise<void>
  /** Wipe the in-memory message buffer for a group without stopping the monitor. */
  clearGroupMessages: (groupId: string) => void
}

export function createQQService({
  wsUrl,
  token,
  model: modelOverride,
  server,
  groupConfig,
  botQQId,
  groupVerbosity,
  groupCheckIntervalMs,
  policy: policyOverride
}: QQServiceOptions): QQService {
  const policy = policyOverride ?? qqPolicy
  const groupProbeMessageCountLimit = new Map<string, number>()
  let resolvedBotQQId = botQQId

  const storage: QQChannelStorage = {
    findChannelUser(platform, externalUserId) {
      return server
        .listChannelUsers()
        .find((u) => u.platform === platform && u.externalUserId === externalUserId)
    },
    createChannelUser(user) {
      return server.createChannelUser(user)
    }
  }

  const client: OneBotClient = createOneBotClient({ url: wsUrl, token })

  /**
   * Send "typing…" indicator to a private chat user.
   * QQ only needs a single fire — resending resets the animation.
   */
  function sendTyping(qqUserId: number): void {
    void client.setInputStatus(qqUserId, 1).catch((err) => {
      console.warn('[qq] set_input_status failed:', err)
    })
  }

  /** Clear the typing indicator for a private chat user. */
  function stopTyping(qqUserId: number): void {
    void client.setInputStatus(qqUserId, 0).catch(() => {})
  }

  async function sendPrivateMessage(userId: number, text: string): Promise<void> {
    await client.sendPrivateMessage(userId, text)
  }

  async function resolveThread(
    channelUser: ChannelUserRecord
  ): Promise<{ thread: ThreadRecord; compacted: boolean }> {
    return resolveDirectMessageThread({
      logLabel: 'qq',
      server,
      channelUser,
      policy,
      modelOverride,
      createThread: async (): Promise<ThreadRecord> =>
        server.createThread({
          workspacePath: channelUser.workspacePath,
          source: 'qq',
          channelUserId: channelUser.id,
          title: `QQ:${channelUser.username}`
        })
    })
  }

  const directMessages = createDirectMessageService<number>({
    logLabel: 'qq',
    server,
    policy,
    resolveThread,
    sendMessage: sendPrivateMessage,
    startBatchIndicator: (qqUserId) => {
      sendTyping(qqUserId)
    },
    startHandlingIndicator: (qqUserId) => {
      sendTyping(qqUserId)
      return () => stopTyping(qqUserId)
    },
    onCompacted: (qqUserId) => notifyAutoCompact(sendPrivateMessage, qqUserId),
    nonRunReply: '抱歉，出了点问题。',
    errorReply: '出了点问题，请稍后再试。',
    handleSlashCommand: (qqUserId, channelUser, command, args) =>
      handleDmSlashCommand(
        {
          server,
          threadReuseWindowMs: policy.threadReuseWindowMs,
          contextTokenLimit: policy.contextTokenLimit,
          createFreshThread: (user) =>
            server.createThread({
              workspacePath: user.workspacePath,
              source: 'qq',
              channelUserId: user.id,
              title: `QQ:${user.username}`
            }),
          sendMessage: sendPrivateMessage
        },
        qqUserId,
        channelUser,
        command,
        args
      )
  })

  /**
   * Resolve a CQ image reference via OneBot `get_image` API.
   *
   * NapCat returns a local file path where the image is cached. We try to
   * read the file directly; if that fails we fall back to fetching the URL.
   */
  async function resolveQQImage(ref: CQImageRef): Promise<MessageImageRecord | null> {
    try {
      const info = await client.getImage(ref.file)
      console.log(`[qq] get_image resolved: file=${info.file}, size=${info.size}`)

      if (info.size && info.size > policy.maxImageBytes) {
        console.warn(`[qq] skipping oversized image: ${info.size} bytes`)
        return null
      }

      // Try reading the local cached file first.
      if (info.file) {
        try {
          const buffer = await readFile(info.file)

          if (buffer.length > policy.maxImageBytes) {
            console.warn(`[qq] skipping oversized local image: ${buffer.length} bytes`)
            return null
          }

          // Detect actual format from magic bytes — QQ often saves GIFs as .jpg
          const detectedType = detectMediaTypeFromBytes(buffer) ?? 'image/jpeg'
          const filename = info.filename || ref.file

          // Convert unsupported formats (GIF → PNG first frame, etc.)
          const safe = await ensureVisionSafe(buffer, detectedType)

          console.log(
            `[qq] local file read OK: ${buffer.length} bytes, detected ${detectedType}${safe.mediaType !== detectedType ? ` → converted to ${safe.mediaType}` : ''}, filename=${filename}`
          )

          return {
            dataUrl: `data:${safe.mediaType};base64,${safe.buffer.toString('base64')}`,
            mediaType: safe.mediaType,
            filename
          }
        } catch {
          // Local file not readable — fall through to URL download.
        }
      }

      // Fall back to URL from get_image response.
      if (info.url) {
        return fetchImageAsDataUrl(info.url, { maxBytes: policy.maxImageBytes })
      }

      return null
    } catch (err) {
      console.warn(`[qq] get_image failed for ${ref.file}:`, err)
      return null
    }
  }

  client.onPrivateMessage((msg) => {
    const { text: rawText, images: imageRefs } = parseCQImages(msg.rawMessage)
    if (!rawText && imageRefs.length === 0) return
    // Resolve CQ codes synchronously. Reply CQ codes are stripped —
    // in 1:1 DMs the user already sees the QQ reply UI, so the bot
    // doesn't need the quoted context to maintain coherence.
    const text = resolveCQCodes(rawText)

    const userId = String(msg.userId)
    const nickname = msg.nickname

    // Start image resolution eagerly — overlaps with debounce window.
    const imageDownloads = imageRefs
      .slice(0, policy.maxImagesPerBatch)
      .map((ref) => resolveQQImage(ref))

    console.log(
      `[qq] inbound DM from ${nickname} (${userId}): ${JSON.stringify(text)} (${imageDownloads.length} image(s))`
    )

    const result = routeQQMessage({ userId, nickname, text }, storage)
    console.log(
      `[qq] route result: ${result.kind}${result.kind === 'allowed' ? ` (role=${result.channelUser.role})` : ''}`
    )

    switch (result.kind) {
      case 'blocked':
        return

      case 'limit-exceeded':
        void client
          .sendPrivateMessage(msg.userId, result.reply)
          .catch((e) => console.error('[qq] failed to send limit reply', e))
        return

      case 'allowed':
        directMessages.enqueueMessage(msg.userId, result.channelUser, text, imageDownloads)
    }
  })

  // ------------------------------------------------------------------
  // Group discussion mode (probe+tool pattern)
  // ------------------------------------------------------------------

  let groupRegistry: GroupMonitorRegistry | null = null

  /** Resolve [CQ:at,qq=ID] codes into @Name using known users + bot identity. */
  function resolveCQAtMentions(text: string): string {
    return text.replace(/\[CQ:at,qq=(\d+)\]/g, (_match, qqId: string) => {
      // Bot's own ID
      if (resolvedBotQQId && qqId === resolvedBotQQId) {
        return '@Yachiyo'
      }
      // Known channel user
      const user = server
        .listChannelUsers()
        .find((u) => u.platform === 'qq' && u.externalUserId === qqId)
      if (user) {
        return `@${user.username}`
      }
      return `@QQ:${qqId}`
    })
  }

  /** Build a map from QQ externalUserId → role for identity marking. */
  function buildKnownUsersMap(): Map<string, string> {
    const map = new Map<string, string>()
    for (const u of server.listChannelUsers()) {
      if (u.platform === 'qq') {
        map.set(u.externalUserId, u.role)
      }
    }
    return map
  }

  const speechThrottle = createSpeechThrottle(groupVerbosity ?? 0)

  /**
   * Per-group ring buffer of recent outgoing messages for dedup.
   * Drops messages that are identical (or near-identical) to something
   * the bot said recently, so chatty models don't repeat themselves.
   */
  const recentOutgoing = new Map<string, GroupReplyHistory>()
  const DEDUP_MAX_ENTRIES = 10

  function isDuplicateOutgoing(groupId: string, message: string): boolean {
    const entry = recentOutgoing.get(groupId)
    const shouldSuppress = shouldSuppressGroupReply(entry, message)
    if (entry && entry.texts.length === 0) {
      recentOutgoing.delete(groupId)
    }
    return shouldSuppress
  }

  function recordOutgoing(groupId: string, message: string, sentAtMs = Date.now()): void {
    const entry = appendGroupReplyHistory(
      recentOutgoing.get(groupId),
      message,
      sentAtMs,
      DEDUP_MAX_ENTRIES
    )
    if (entry.texts.length === 0) {
      recentOutgoing.delete(groupId)
      return
    }
    recentOutgoing.set(groupId, entry)
  }

  // Group monitoring is enabled by default; only skip if explicitly disabled.
  if (groupConfig?.enabled !== false) {
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
        async onTurn(group, recentMessages, freshCount) {
          return handleGroupTurn(group, recentMessages, freshCount)
        },

        onStateChange(group, newPhase) {
          console.log(`[qq-group] "${group.name}" phase → ${newPhase}`)
        }
      },
      groupCheckIntervalMs,
      bufferPersistence
    )

    // Start monitors for all already-approved groups.
    for (const group of server.listChannelGroups()) {
      if (group.platform === 'qq' && group.status === 'approved') {
        groupRegistry.startMonitor(group)
        // Seed dedup from restored __self__ messages so the bot doesn't repeat itself.
        for (const msg of groupRegistry.getRecentMessages(group.id)) {
          if (msg.senderExternalUserId === '__self__') {
            recordOutgoing(group.id, msg.text, msg.timestamp * 1_000)
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
    recentMessages: GroupMessageEntry[],
    freshCount: number
  ): Promise<boolean> {
    const auxService = server.getAuxiliaryGenerationService()
    let didSpeak = false
    const turnSendGuard = createGroupTurnSendGuard()

    // Build the send_group_message tool — closure captures the send logic.
    const sendGroupMessageTool = tool({
      description:
        'Send a message to the group chat. Only call this when you genuinely want to speak. Your raw text output is private and never shown to anyone.',
      inputSchema: z.object({
        message: z
          .string()
          .describe(
            'The message to send to the group. Plain text only. Never start with a colon or }.'
          )
      }),
      execute: async ({ message }) => {
        turnSendGuard.beforeAttempt()

        if (message.includes('\n')) {
          console.log(`[qq-group] rejected multi-line message for "${group.name}"`)
          return 'Rejected: message must be a single line. Do not include line breaks.'
        }

        if (!hasVisibleGroupReplyContent(message)) {
          console.log(`[qq-group] rejected empty message for "${group.name}"`)
          return 'Rejected: message must contain visible text.'
        }

        if (hasForbiddenGroupReplyPrefix(message)) {
          console.log(
            `[qq-group] rejected forbidden-prefix message for "${group.name}": ${message}`
          )
          throw new Error('Rejected: message must not start with a colon or }.')
        }

        if (isBareSymbolMessage(message)) {
          console.log(`[qq-group] rejected bare-symbol message for "${group.name}": ${message}`)
          return 'Rejected: message contains only punctuation. Write actual words or stay silent.'
        }

        if (isDuplicateOutgoing(group.id, message)) {
          console.log(
            `[qq-group] dropped duplicate message for "${group.name}": ${message.slice(0, 80)}`
          )
          return turnSendGuard.recordBlockedAttempt('duplicate')
        }

        if (speechThrottle.shouldDrop(group.id)) {
          const rate = speechThrottle.getDropRate(group.id)
          console.log(
            `[qq-group] throttled message for "${group.name}" (drop rate ${Math.round(rate * 100)}%): ${message.slice(0, 80)}`
          )
          return turnSendGuard.recordBlockedAttempt('throttled')
        }

        try {
          await client.sendGroupMessage(Number(group.externalGroupId), message)
          turnSendGuard.recordSent()
          recordOutgoing(group.id, message)
          speechThrottle.recordSend(group.id)
          console.log(`[qq-group] sent reply to group "${group.name}": ${message.slice(0, 100)}`)

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
          console.error(`[qq-group] failed to send message to "${group.name}"`, err)
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

    // Build agentic tools: read, web_read, web_search, update_profile.
    const toolContext = { workspacePath: group.workspacePath, sandboxed: true }
    const probeTools: ToolSet = {
      send_group_message: sendGroupMessageTool,
      read: createReadTool(toolContext),
      web_read: createWebReadTool(toolContext),
      web_search: createWebSearchTool(toolContext, {
        webSearchService: server.getWebSearchService()
      }),
      update_profile: createUpdateProfileTool({
        userDocumentPath: userDocPath,
        userDocumentMode: 'group'
      })
    }

    // Resolve model settings: group-specific override -> default primary model.
    const settingsOverride = server.resolveProviderSettings(groupConfig?.model)

    const messageCountLimit = groupProbeMessageCountLimit.get(group.id)
    const probeRecentMessages = selectGroupProbeRecentMessages(recentMessages, messageCountLimit)
    const effectiveFreshCount = Math.min(freshCount, probeRecentMessages.length)
    const messages = buildGroupProbeMessages({
      botName: 'Yachiyo',
      groupName: group.name,
      recentMessages: probeRecentMessages,
      knownUsers: buildKnownUsersMap(),
      personaSummary: EXTERNAL_GROUP_PROMPT,
      ownerInstruction: readChannelsConfig().guestInstruction,
      groupUserDocument: groupUserDoc?.content,
      freshCount: effectiveFreshCount
    })

    console.log(
      `[qq-group] group="${group.name}" probing ${probeRecentMessages.length}/${recentMessages.length} message(s) (${effectiveFreshCount} new) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${formatGroupMessages(probeRecentMessages, 'Yachiyo', buildKnownUsersMap(), undefined, effectiveFreshCount)}`
    )

    const result = await auxService.generateText({
      messages,
      max_token: server.resolveMaxChatToken(),
      tools: probeTools,
      onToolCallError: (event) =>
        event.toolCall.toolName === 'send_group_message' ? 'abort' : 'continue',
      settingsOverride
    })

    if (result.status === 'success') {
      const totalPromptTokens = result.usage?.totalPromptTokens
      const nextMessageCountLimit = deriveNextGroupProbeMessageCount({
        currentMessageCount: probeRecentMessages.length,
        availableMessageCount: recentMessages.length,
        totalPromptTokens,
        contextTokenLimit: policy.groupContextTokenLimit
      })
      const previousMessageCountLimit = groupProbeMessageCountLimit.get(group.id)
      if (nextMessageCountLimit == null) {
        groupProbeMessageCountLimit.delete(group.id)
      } else {
        groupProbeMessageCountLimit.set(group.id, nextMessageCountLimit)
      }
      const promptUsageK =
        totalPromptTokens != null && totalPromptTokens > 0
          ? `${(totalPromptTokens / 1000).toFixed(1)}k`
          : 'unknown'
      const currentMessageWindow = nextMessageCountLimit ?? recentMessages.length
      console.log(
        `[qq-group] group="${group.name}" probe usage=${promptUsageK}, probed=${probeRecentMessages.length}/${recentMessages.length} message(s), window now=${currentMessageWindow}/${recentMessages.length}`
      )
      if (previousMessageCountLimit !== nextMessageCountLimit) {
        console.log(
          `[qq-group] group="${group.name}" moved token window ${previousMessageCountLimit ?? 'full'} -> ${nextMessageCountLimit ?? 'full'} message(s) after promptTokens=${promptUsageK}`
        )
      }
      console.log(
        `[qq-group] group="${group.name}" monologue: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`
      )
      console.log(`[qq-group] group="${group.name}" didSpeak=${didSpeak}`)
    } else {
      console.warn(
        `[qq-group] auxiliary generation ${result.status}:`,
        result.status === 'failed' ? result.error : result.reason
      )
    }

    return didSpeak
  }

  // Always listen for group messages — register pending groups even when
  // group monitoring is disabled, so they show up in settings for approval.
  client.onGroupMessage((msg) => {
    const groupId = String(msg.groupId)
    const existing = server.findChannelGroup('qq', groupId)

    if (!existing) {
      server.createChannelGroup({
        id: `qq-group-${groupId}`,
        platform: 'qq',
        externalGroupId: groupId,
        name: `QQ群${groupId}`,
        status: 'pending',
        workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `qq-group-${groupId}`)
      })
      console.log(`[qq-group] new group ${groupId} registered as pending`)
      return
    }

    if (existing.status !== 'approved' || !groupRegistry) return

    // Skip the bot's own messages echoed back by the server — already
    // fed into the monitor as __self__ from the tool closure.
    if (resolvedBotQQId && String(msg.userId) === resolvedBotQQId) return

    const { text: rawText, images: imageRefs } = parseCQImages(msg.rawMessage)
    if (!rawText && imageRefs.length === 0) return

    const isMention = resolvedBotQQId
      ? msg.rawMessage.includes(`[CQ:at,qq=${resolvedBotQQId}]`)
      : false

    // Resolve [CQ:at,qq=ID] codes into readable @Name so the model
    // can track who is addressing whom in multi-party conversation.
    // Then resolve remaining CQ codes (face, share, json cards, etc.)
    // into human-readable labels.
    const resolvedText = resolveCQCodes(resolveCQAtMentions(rawText))

    // Async enrichment: reply quote + image descriptions.
    const replyMsgId = extractReplyId(rawText)
    const replyQuotePromise: Promise<string | null> = replyMsgId
      ? client
          .getMsg(Number(replyMsgId))
          .then((quoted) => {
            const snippet = resolveCQCodes(
              resolveCQAtMentions(parseCQImages(quoted.rawMessage).text)
            )
            const truncated = snippet.length > 80 ? snippet.slice(0, 77) + '...' : snippet
            return `「${quoted.sender.nickname}: ${truncated}」`
          })
          .catch(() => null)
      : Promise.resolve(null)

    const imagePromises = imageRefs
      .slice(0, policy.maxImagesPerBatch)
      .map((ref) => resolveQQImage(ref))

    const needsAsyncEnrichment = replyMsgId != null || imagePromises.length > 0

    if (isMention && needsAsyncEnrichment) {
      // Mentions trigger an immediate probe via runCheck(), so we must
      // wait for enrichment to complete before routing — otherwise the
      // model sees stale text and no images on the first turn.
      void (async () => {
        const [quote, ...imgResults] = await Promise.all([replyQuotePromise, ...imagePromises])
        const images = (imgResults as (MessageImageRecord | null)[]).filter(
          (img): img is MessageImageRecord => img !== null
        )
        const text = quote ? `${quote}\n${resolvedText}` : resolvedText

        if (images.length > 0) {
          await describeGroupImages({ server, text, images, logLabel: 'qq-group' })
        }

        groupRegistry!.routeMessage(existing.id, {
          senderName: msg.nickname,
          senderExternalUserId: String(msg.userId),
          isMention,
          text,
          images: images.length > 0 ? images : undefined,
          timestamp: msg.time
        })
      })()
    } else {
      // Non-mention: route synchronously to preserve buffer ordering.
      // Enrichment patches the entry in-place before the next debounced
      // probe fires.
      const entry: GroupMessageEntry = {
        senderName: msg.nickname,
        senderExternalUserId: String(msg.userId),
        isMention,
        text: resolvedText,
        timestamp: msg.time
      }
      groupRegistry.routeMessage(existing.id, entry)

      if (replyMsgId) {
        void replyQuotePromise.then((quote) => {
          if (quote) entry.text = `${quote}\n${entry.text}`
        })
      }

      if (imagePromises.length > 0) {
        void Promise.all(imagePromises).then(async (results) => {
          const images = results.filter((img): img is MessageImageRecord => img !== null)
          if (images.length > 0) {
            await describeGroupImages({
              server,
              text: entry.text,
              images,
              logLabel: 'qq-group'
            })
            entry.images = images
          }
        })
      }
    }
  })

  return {
    connect() {
      console.log(`[qq] connecting to NapCat at ${wsUrl}`)

      // Auto-detect the bot's own QQ ID once connected.
      client.onConnect(() => {
        if (resolvedBotQQId) return
        void (async () => {
          try {
            const info = await client.getLoginInfo()
            resolvedBotQQId = String(info.userId)
            console.log(`[qq] resolved bot QQ ID: ${resolvedBotQQId} (${info.nickname})`)
          } catch (e) {
            console.warn('[qq] failed to resolve bot QQ ID:', e)
          }
        })()
      })

      client.connect()
    },
    async stop() {
      groupRegistry?.stopAll()
      directMessages.stop()
      await client.close()
    },

    onGroupStatusChange(group) {
      if (group.platform !== 'qq' || !groupRegistry) return

      if (group.status === 'approved') {
        groupRegistry.startMonitor(group)
        console.log(`[qq-group] monitor started for "${group.name}" after approval`)
      } else {
        groupRegistry.stopMonitor(group.id)
        console.log(`[qq-group] monitor stopped for "${group.name}" (status=${group.status})`)
      }
    },

    sendPrivateMessage,

    async sendGroupMessage(groupId: number, text: string) {
      await client.sendGroupMessage(groupId, text)
    },

    clearGroupMessages(groupId: string) {
      groupRegistry?.clearGroupMessages(groupId)
    }
  }
}
