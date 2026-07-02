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

import { readFile } from 'node:fs/promises'

import type {
  ChannelGroupRecord,
  GroupChannelConfig,
  GroupMessageEntry,
  MessageImageRecord,
  ThreadModelOverride
} from '@yachiyo/shared/protocol'
import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import { qqPolicy, type ChannelPolicy } from '../../shared/channelPolicy.ts'
import { createChannelDirectMessageRuntime } from '../../direct/channelDirectMessageRuntime.ts'
import {
  detectMediaTypeFromBytes,
  ensureVisionSafe,
  fetchImageAsDataUrl
} from '../../shared/channelImageDownload.ts'
import type { DirectMessageInboundAttachment } from '../../direct/directMessageService.ts'
import {
  createChannelGroupDiscussionService,
  type ChannelGroupDiscussionService
} from '../../group/channelGroupDiscussionService.ts'
import { routeChannelGroupMessage } from '../../group/channelGroupRouting.ts'
import { buildLegacyQQImageUrl } from './qqImageFallback.ts'
import type { ChannelReplyPayload } from '../../shared/channelReply.ts'
import { parseCQImages, type CQImageRef } from './qqImageParsing.ts'
import { resolveCQCodes, extractReplyId } from './qqCQCodes.ts'
import { createOneBotClient, type OneBotClient } from './onebotClient.ts'
import { routeQQMessage, type QQChannelStorage } from './qq.ts'

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
  start: () => void
  connect: () => void
  stop: () => Promise<void>
  healthCheck: () => Promise<boolean>
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

  async function sendPrivateReply(userId: number, payload: ChannelReplyPayload): Promise<void> {
    const text = payload.message?.trim()
    if (text) {
      await sendPrivateMessage(userId, text)
    }
    for (const attachment of payload.attachments ?? []) {
      if (attachment.deliveryKind === 'image') {
        await client.sendPrivateImage(userId, attachment.path)
        continue
      }
      await client.uploadPrivateFile(
        userId,
        attachment.path,
        attachment.filename ?? attachment.path
      )
    }
  }

  const directMessages = createChannelDirectMessageRuntime<number>({
    platform: 'qq',
    logLabel: 'qq',
    server,
    policy,
    modelOverride,
    sendMessage: sendPrivateMessage,
    sendReply: sendPrivateReply,
    startBatchIndicator: (qqUserId) => {
      sendTyping(qqUserId)
    },
    startHandlingIndicator: (qqUserId) => {
      sendTyping(qqUserId)
      return () => stopTyping(qqUserId)
    },
    nonRunReply: '抱歉，出了点问题。',
    errorReply: '出了点问题，请稍后再试。',
    formatGuestThreadTitle: (channelUser) => `QQ:${channelUser.username}`
  })

  function safeUrlHost(url: string): string {
    try {
      return new URL(url).hostname
    } catch {
      return 'unparsable'
    }
  }

  /**
   * Resolve a CQ image reference via OneBot `get_image` API.
   *
   * NapCat returns a local file path where the image is cached. We try to
   * read the file directly; if that fails we fall back to fetching the URL.
   */
  async function resolveQQImage(
    ref: CQImageRef,
    attachmentIndex?: number
  ): Promise<MessageImageRecord | null> {
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
            filename,
            ...(attachmentIndex !== undefined ? { attachmentIndex } : {})
          }
        } catch {
          // Local file not readable — fall through to URL download.
        }
      }

      // Fall back to URL from get_image response.
      if (info.url) {
        const fetched = await fetchImageAsDataUrl(info.url, {
          maxBytes: policy.maxImageBytes,
          attachmentIndex
        })
        if (fetched) {
          return fetched
        }
        console.warn(
          `[qq] napcat image url rejected (host=${safeUrlHost(info.url)}), trying legacy md5 url`
        )
      }

      // Napcat's rkey-signed URL was rejected (or absent) — rebuild the legacy
      // md5-addressed URL from the cache file name and try once more.
      const legacyUrl = buildLegacyQQImageUrl(info.file ?? ref.file)
      if (legacyUrl && legacyUrl !== info.url) {
        return fetchImageAsDataUrl(legacyUrl, { maxBytes: policy.maxImageBytes, attachmentIndex })
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

    console.log(`[qq] inbound DM from ${nickname} (${userId}): ${JSON.stringify(text)}`)

    const result = routeQQMessage({ userId, nickname, text }, storage)
    console.log(
      `[qq] route result: ${result.kind}${result.kind === 'allowed' ? ` (role=${result.channelUser.role})` : ''}`
    )

    switch (result.kind) {
      case 'blocked':
        return

      case 'pending':
        void client
          .sendPrivateMessage(msg.userId, result.reply)
          .catch((e) => console.error('[qq] failed to send pending reply', e))
        return

      case 'limit-exceeded':
        void client
          .sendPrivateMessage(msg.userId, result.reply)
          .catch((e) => console.error('[qq] failed to send limit reply', e))
        return

      case 'allowed': {
        const attachmentDownloads: Promise<DirectMessageInboundAttachment | null>[] = imageRefs
          .slice(0, policy.maxImagesPerBatch)
          .map((ref, index) =>
            resolveQQImage(ref, index + 1).then((image) =>
              image ? { kind: 'image' as const, image } : null
            )
          )
        directMessages.enqueueMessage(msg.userId, result.channelUser, text, attachmentDownloads)
      }
    }
  })

  // ------------------------------------------------------------------
  // Group discussion mode (probe+tool pattern)
  // ------------------------------------------------------------------

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

  const groupDiscussion: ChannelGroupDiscussionService | null =
    groupConfig?.enabled !== false
      ? createChannelGroupDiscussionService({
          platform: 'qq',
          logLabel: 'qq-group',
          server,
          policy,
          groupConfig,
          groupVerbosity,
          groupCheckIntervalMs,
          rejectMultilineMessages: true,
          sendMessage: async (group, message) => {
            await client.sendGroupMessage(Number(group.externalGroupId), message)
          }
        })
      : null

  // Always listen for group messages — register pending groups even when
  // group monitoring is disabled, so they show up in settings for approval.
  client.onGroupMessage((msg) => {
    const groupId = String(msg.groupId)
    const routedGroup = routeChannelGroupMessage(
      {
        platform: 'qq',
        externalGroupId: groupId,
        name: `QQ群${groupId}`
      },
      server
    )
    if (routedGroup.kind !== 'approved' || !groupDiscussion) return

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
          await groupDiscussion.describeImages({ text, images })
        }

        groupDiscussion.routeMessage(routedGroup.group.id, {
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
        ...(imagePromises.length > 0 ? { imageDescriptionPending: true } : {}),
        timestamp: msg.time
      }
      groupDiscussion.routeMessage(routedGroup.group.id, entry)

      if (replyMsgId) {
        void replyQuotePromise.then((quote) => {
          if (quote) entry.text = `${quote}\n${entry.text}`
        })
      }

      if (imagePromises.length > 0) {
        void Promise.all(imagePromises).then(async (results) => {
          const images = results.filter((img): img is MessageImageRecord => img !== null)
          if (images.length > 0) {
            await groupDiscussion.describeImages({
              text: entry.text,
              images
            })
          }
          entry.images = images.length > 0 ? images : undefined
          entry.imageDescriptionPending = false
        })
      }
    }
  })

  return {
    start() {
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
    connect() {
      this.start()
    },
    async stop() {
      groupDiscussion?.stop()
      directMessages.stop()
      await client.close()
    },

    async healthCheck() {
      return client.healthCheck()
    },

    onGroupStatusChange(group) {
      groupDiscussion?.onGroupStatusChange(group)
    },

    sendPrivateMessage,

    async sendGroupMessage(groupId: number, text: string) {
      await client.sendGroupMessage(groupId, text)
    },

    clearGroupMessages(groupId: string) {
      groupDiscussion?.clearGroupMessages(groupId)
    }
  }
}
