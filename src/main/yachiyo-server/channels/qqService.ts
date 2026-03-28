/**
 * QQ bot service via NapCatQQ (OneBot v11 WebSocket).
 *
 * Same architecture as telegramService.ts:
 *   1. Route message through access control.
 *   2. Debounce-buffer rapid messages per user (3-8 s random window).
 *   3. Flush buffered texts as a single AI request.
 *   4. Extract <reply> content and send back via OneBot API.
 */

import type {
  ChannelUserRecord,
  MessageImageRecord,
  ThreadModelOverride,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { qqPolicy } from './channelPolicy.ts'
import {
  detectMediaTypeFromBytes,
  ensureVisionSafe,
  fetchImageAsDataUrl
} from './channelImageDownload.ts'
import { parseCQImages, type CQImageRef } from './qqImageParsing.ts'
import { createOneBotClient, type OneBotClient } from './onebotClient.ts'
import { readFile } from 'node:fs/promises'
import { routeQQMessage, type QQChannelStorage } from './qq.ts'

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
}

export interface QQService {
  connect: () => void
  stop: () => Promise<void>
}

export function createQQService({
  wsUrl,
  token,
  model: modelOverride,
  server
}: QQServiceOptions): QQService {
  const policy = qqPolicy
  const pendingBatches = new Map<string, PendingBatch>()

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
      client.connect()
    },
    async stop() {
      for (const [userId, batch] of pendingBatches) {
        clearTimeout(batch.timer)
        pendingBatches.delete(userId)
        console.log(`[qq] discarded pending batch for ${batch.channelUser.username} on shutdown`)
      }
      await client.close()
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
