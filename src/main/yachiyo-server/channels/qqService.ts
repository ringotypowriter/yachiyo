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
  ThreadModelOverride,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'
import { qqPolicy } from './channelPolicy.ts'
import {
  detectMediaTypeFromBytes,
  ensureVisionSafe,
  fetchImageAsDataUrl
} from './channelImageDownload.ts'
import { buildGroupProbeMessages, formatGroupMessages } from './groupContextBuilder.ts'
import { createGroupMonitorRegistry, type GroupMonitorRegistry } from './groupMonitorRegistry.ts'
import { parseCQImages, type CQImageRef } from './qqImageParsing.ts'
import { createOneBotClient, type OneBotClient } from './onebotClient.ts'
import { routeQQMessage, type QQChannelStorage } from './qq.ts'
import { EXTERNAL_SYSTEM_PROMPT } from '../runtime/prompt.ts'
import { readChannelsConfig } from '../runtime/channelsConfig.ts'
import { readUserDocument } from '../runtime/user.ts'
import { YACHIYO_USER_FILE_NAME } from '../config/paths.ts'
import { createSpeechThrottle } from './groupSpeechThrottle.ts'
import { createTool as createReadTool } from '../tools/agentTools/readTool.ts'
import { createTool as createWebReadTool } from '../tools/agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from '../tools/agentTools/webSearchTool.ts'
import { createTool as createUpdateMemoryTool } from '../tools/agentTools/updateMemoryTool.ts'

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
  qqUserId: number
  channelUser: ChannelUserRecord
}

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
}

export interface QQService {
  connect: () => void
  stop: () => Promise<void>
  /** Notify the service that a group's status changed (approved/blocked). */
  onGroupStatusChange: (group: ChannelGroupRecord) => void
}

export function createQQService({
  wsUrl,
  token,
  model: modelOverride,
  server,
  groupConfig,
  botQQId
}: QQServiceOptions): QQService {
  const policy = qqPolicy
  const pendingBatches = new Map<string, PendingBatch>()
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
    const { text, images: imageRefs } = parseCQImages(msg.rawMessage)
    if (!text && imageRefs.length === 0) return

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
        enqueueMessage(msg.userId, result.channelUser, text, imageDownloads)
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

  const speechThrottle = createSpeechThrottle()

  /**
   * Per-group ring buffer of recent outgoing messages for dedup.
   * Drops messages that are identical (or near-identical) to something
   * the bot said recently, so chatty models don't repeat themselves.
   */
  const recentOutgoing = new Map<string, { texts: string[]; timestamps: number[] }>()
  const DEDUP_WINDOW_MS = 5 * 60 * 1_000
  const DEDUP_MAX_ENTRIES = 10

  function isDuplicateOutgoing(groupId: string, message: string): boolean {
    const normalized = message.trim().toLowerCase()
    const entry = recentOutgoing.get(groupId)
    if (!entry) return false

    const now = Date.now()
    // Prune old entries
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

  // Group monitoring is enabled by default; only skip if explicitly disabled.
  if (groupConfig?.enabled !== false) {
    groupRegistry = createGroupMonitorRegistry(policy.groupDefaults, groupConfig, {
      async onTurn(group, recentMessages) {
        return handleGroupTurn(group, recentMessages)
      },

      onStateChange(group, newPhase) {
        console.log(`[qq-group] "${group.name}" phase → ${newPhase}`)
      }
    })

    // Start monitors for all already-approved groups.
    for (const group of server.listChannelGroups()) {
      if (group.platform === 'qq' && group.status === 'approved') {
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

    // Build the send_group_message tool — closure captures the send logic.
    const sendGroupMessageTool = tool({
      description:
        'Send a message to the group chat. Only call this when you genuinely want to speak. Your raw text output is private and never shown to anyone.',
      inputSchema: z.object({
        message: z.string().describe('The message to send to the group. Plain text only.')
      }),
      execute: async ({ message }) => {
        if (message.includes('\n')) {
          console.log(`[qq-group] rejected multi-line message for "${group.name}"`)
          return 'Rejected: message must be a single line. Do not include line breaks.'
        }

        if (isDuplicateOutgoing(group.id, message)) {
          console.log(
            `[qq-group] dropped duplicate message for "${group.name}": ${message.slice(0, 80)}`
          )
          return 'Message sent.'
        }

        if (speechThrottle.shouldDrop(group.id)) {
          const rate = speechThrottle.getDropRate(group.id)
          console.log(
            `[qq-group] throttled message for "${group.name}" (drop rate ${Math.round(rate * 100)}%): ${message.slice(0, 80)}`
          )
          return 'Message sent.'
        }

        try {
          await client.sendGroupMessage(Number(group.externalGroupId), message)
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
      `[qq-group] group="${group.name}" probing ${recentMessages.length} message(s) with ${settingsOverride.providerName}/${settingsOverride.model}:\n${formatGroupMessages(recentMessages, 'Yachiyo', buildKnownUsersMap())}`
    )

    const result = await auxService.generateText({
      messages,
      tools: probeTools,
      settingsOverride
    })

    if (result.status === 'success') {
      console.log(
        `[qq-group] group="${group.name}" monologue: ${result.text.slice(0, 200)}${result.text.length > 200 ? '…' : ''}`
      )
      console.log(`[qq-group] group="${group.name}" didSpeak=${didSpeak}`)
    } else {
      console.warn(
        `[qq-group] auxiliary generation ${result.status}:`,
        'error' in result ? result.error : result.status
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
    const text = resolveCQAtMentions(rawText)

    // Resolve images eagerly then route with the completed entry.
    const imagePromises = imageRefs
      .slice(0, policy.maxImagesPerBatch)
      .map((ref) => resolveQQImage(ref))

    if (imagePromises.length === 0) {
      groupRegistry.routeMessage(existing.id, {
        senderName: msg.nickname,
        senderExternalUserId: String(msg.userId),
        isMention,
        text,
        timestamp: msg.time
      })
    } else {
      void Promise.all(imagePromises).then(async (results) => {
        const images = results.filter((img): img is MessageImageRecord => img !== null)

        // Generate alt text for images when image-to-text is enabled
        // (skip when vision is on — raw images go to the model directly).
        const channelsConfig = server.getChannelsConfig()
        if (groupConfig?.vision !== true && channelsConfig.imageToText?.enabled) {
          const i2t = server.getImageToTextService()
          await Promise.all(
            images.map(async (img) => {
              const result = await i2t.describe(img.dataUrl, text)
              if (result) img.altText = result.altText
            })
          )
        }

        groupRegistry!.routeMessage(existing.id, {
          senderName: msg.nickname,
          senderExternalUserId: String(msg.userId),
          isMention,
          text,
          images: images.length > 0 ? images : undefined,
          timestamp: msg.time
        })
      })
    }
  })

  function enqueueMessage(
    qqUserId: number,
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
        `[qq] appended to batch for ${channelUser.username} (${existing.messages.length} msgs, ${existing.imageDownloads.length} img(s), next flush in ${Math.round(delay)}ms)`
      )
      return
    }

    const delay = randomReplyDelay()
    const timer = setTimeout(() => flushBatch(userId), delay)

    pendingBatches.set(userId, {
      messages: [text],
      imageDownloads: [...imageDownloads],
      timer,
      qqUserId,
      channelUser
    })

    console.log(`[qq] new batch for ${channelUser.username} (flush in ${Math.round(delay)}ms)`)
  }

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
      `[qq] flushing batch for ${batch.channelUser.username}: ${batch.messages.length} message(s), ${images.length} image(s)`
    )

    void handleAllowedMessage(batch.qqUserId, batch.channelUser, joinedText, images)
  }

  async function resolveThread(channelUser: ChannelUserRecord): Promise<{
    thread: import('../../../shared/yachiyo/protocol.ts').ThreadRecord
    compacted: boolean
  }> {
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
          `[qq] reconciled model override on thread ${existing.id}:`,
          wantedOverride ?? 'cleared'
        )
      }

      const totalTokens = server.getThreadTotalTokens(thread.id)
      console.log(`[qq] existing thread ${thread.id} — ${totalTokens} tokens`)

      if (totalTokens < policy.contextTokenLimit) {
        return { thread, compacted: false }
      }

      console.log(
        `[qq] thread ${thread.id} exceeded ${policy.contextTokenLimit} tokens, generating rolling summary`
      )
      const { thread: compactedThread } = await server.compactExternalThread({
        threadId: thread.id
      })
      return { thread: compactedThread, compacted: true }
    }

    let thread = await server.createThread({
      workspacePath: channelUser.workspacePath,
      source: 'qq',
      channelUserId: channelUser.id,
      title: `QQ:${channelUser.username}`
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
    qqUserId: number,
    channelUser: ChannelUserRecord,
    text: string,
    images: MessageImageRecord[] = []
  ): Promise<void> {
    try {
      console.log(
        `[qq] handling allowed message for user ${channelUser.username} (${images.length} image(s))`
      )
      const { thread: yachiyoThread, compacted } = await resolveThread(channelUser)
      console.log(
        `[qq] using thread ${yachiyoThread.id}${compacted ? ' (rolling summary generated)' : ''}`
      )

      const outputPromise = collectRunOutput(server, yachiyoThread.id)

      const accepted = await server.sendChat({
        threadId: yachiyoThread.id,
        content: text,
        images: images.length > 0 ? images : undefined,
        enabledTools: policy.allowedTools,
        channelHint: policy.replyInstruction
      })
      console.log(`[qq] sendChat accepted:`, accepted)

      if (!('runId' in accepted)) {
        console.warn('[qq] sendChat returned non-run accepted:', accepted)
        await client.sendPrivateMessage(qqUserId, '抱歉，出了点问题。')
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
      console.log(`[qq] rawOutput:`, rawOutput.slice(0, 200))
      const parsedReply = policy.extractVisibleReply(rawOutput)
      console.log(`[qq] parsedReply:`, parsedReply)

      if (parsedReply) {
        await client.sendPrivateMessage(qqUserId, parsedReply)
      }

      server.updateLatestAssistantVisibleReply({
        threadId: yachiyoThread.id,
        visibleReply: parsedReply
      })

      const totalTokens = server.getThreadTotalTokens(yachiyoThread.id)
      if (totalTokens > 0) {
        const kTokens = Math.ceil(totalTokens / 1000)
        server.updateChannelUser({ id: channelUser.id, usedKTokens: kTokens })
        console.log(`[qq] updated usedKTokens for ${channelUser.username}: ${kTokens}k`)
      }
    } catch (error) {
      console.error('[qq] failed to handle allowed message', error)
      await client.sendPrivateMessage(qqUserId, '出了点问题，请稍后再试。').catch(() => {})
    }
  }

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
      for (const [userId, batch] of pendingBatches) {
        clearTimeout(batch.timer)
        pendingBatches.delete(userId)
        console.log(`[qq] discarded pending batch for ${batch.channelUser.username} on shutdown`)
      }
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
    }
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

      if (event.type === 'run.failed') {
        unsubscribe()
        reject(new Error((event as YachiyoServerEvent & { error?: string }).error ?? 'Run failed'))
      }
    })
  })
}
