/**
 * QQ Official Bot service — DM (C2C) only.
 *
 * Uses the QQ Official Bot API (appId + clientSecret OAuth2) instead of
 * the reverse-engineered OneBot v11 protocol. This channel only supports
 * private/direct messages; group discussion is not available on QQBot.
 *
 * Architecture mirrors qqService.ts for DM handling:
 *   1. Route message through access control.
 *   2. Debounce-buffer rapid messages per user (3-8 s random window).
 *   3. Flush buffered texts as a single AI request.
 *   4. Extract reply content and send back via QQBot REST API.
 */

import type { ThreadModelOverride } from '@yachiyo/shared/protocol'
import type { YachiyoServer } from '../../../app/host/YachiyoServer.ts'
import { qqbotPolicy, type ChannelPolicy } from '../../shared/channelPolicy.ts'
import type { ChannelReplyPayload } from '../../shared/channelReply.ts'
import { createChannelDirectMessageRuntime } from '../../direct/channelDirectMessageRuntime.ts'
import type { DirectMessageInboundAttachment } from '../../direct/directMessageService.ts'
import { fetchImageAsDataUrl } from '../../shared/channelImageDownload.ts'
import {
  createChannelUpdateReceiptSender,
  findChannelUserId
} from '../../shared/channelUpdateReceiptSender.ts'
import {
  createChannelDispatchGate,
  type ChannelSendOptions,
  type UpdateReceiptLease
} from '../../shared/sendWithUpdateReceipt.ts'
import { createQQBotClient, type QQBotC2CAttachment, type QQBotClient } from './qqbotClient.ts'
import { routeQQBotMessage, type QQBotChannelStorage } from './qqbot.ts'

export interface QQBotServiceOptions {
  /** QQ Official Bot appId. */
  appId: string
  /** QQ Official Bot clientSecret. */
  clientSecret: string
  /** Optional model override for QQBot threads. */
  model?: ThreadModelOverride
  /** The Yachiyo server instance. */
  server: YachiyoServer
  /** Effective policy with config overrides applied. Defaults to qqbotPolicy. */
  policy?: ChannelPolicy
  /** Main-process lease for a receipt that may be waiting for the next outbound. */
  updateReceiptLease: UpdateReceiptLease
  /** External QQ client boundary. */
  client?: QQBotClient
  /** Override the inbound batching delay. */
  replyDelayMs?: () => number
}

export interface QQBotService {
  start: () => void
  connect: () => void
  stop: () => Promise<void>
  healthCheck: () => Promise<boolean>
  /**
   * Send a DM to a QQBot user by openId, as a passive reply to their most
   * recent message. Throws if no inbound msg_id is cached.
   */
  sendMessage: (openId: string, text: string, options?: ChannelSendOptions) => Promise<void>
  /**
   * Send a DM with no reply target, for when there is no fresh inbound id —
   * after a restart, for instance. Subject to QQ's active-message limits and
   * the user's opt-out, so failure here is meaningful and must not be
   * mistaken for delivery.
   */
  sendActiveMessage: (openId: string, text: string, options?: ChannelSendOptions) => Promise<void>
}

/**
 * Per-turn target that captures both the user identity and the inbound
 * msg_id at enqueue time, so replies always attach to the correct message
 * even when the user sends another DM before the previous run finishes.
 */
interface QQBotTarget {
  openId: string
  replyMsgId: string
}

type QQBotImageFetcher = typeof fetchImageAsDataUrl

export function startQQBotImageDownloads(
  attachments: readonly QQBotC2CAttachment[],
  policy: Pick<ChannelPolicy, 'maxImagesPerBatch' | 'maxImageBytes'>,
  fetchImage: QQBotImageFetcher = fetchImageAsDataUrl
): Promise<DirectMessageInboundAttachment | null>[] {
  return attachments
    .filter((attachment) => attachment.contentType.startsWith('image/'))
    .slice(0, policy.maxImagesPerBatch)
    .map((attachment, index) => {
      const attachmentIndex = index + 1
      const url = attachment.url.startsWith('//') ? `https:${attachment.url}` : attachment.url
      return fetchImage(url, {
        maxBytes: policy.maxImageBytes,
        attachmentIndex,
        filename: attachment.filename ?? `qqbot-image-${attachmentIndex}`
      }).then((image) => (image ? { kind: 'image' as const, image } : null))
    })
}

export function createQQBotService({
  appId,
  clientSecret,
  model: modelOverride,
  server,
  policy: policyOverride,
  updateReceiptLease,
  client: clientOverride,
  replyDelayMs
}: QQBotServiceOptions): QQBotService {
  const policy = policyOverride ?? qqbotPolicy

  const storage: QQBotChannelStorage = {
    findChannelUser(platform, externalUserId) {
      return server
        .listChannelUsers()
        .find((u) => u.platform === platform && u.externalUserId === externalUserId)
    },
    createChannelUser(user) {
      return server.createChannelUser(user)
    }
  }

  const client = clientOverride ?? createQQBotClient({ appId, clientSecret })

  /**
   * Track the most recent inbound messageId per user for the
   * send-channel (manual send) path, which doesn't go through
   * DirectMessageService and therefore has no per-turn target.
   */
  const lastMessageId = new Map<string, string>()

  /**
   * Send, carrying an owed update receipt if one is waiting for this user.
   *
   * Claimed at the moment of a *real* outbound rather than when their message
   * arrived: a turn may produce text, an error reply or only attachments, and
   * the receipt should ride the first thing that actually leaves. Acked the
   * instant the text lands, so a later attachment failure cannot cause the
   * receipt to be sent twice.
   */
  const sendMessageWithTarget = createChannelUpdateReceiptSender<QQBotTarget>({
    resolveChannelId: (target) => findChannelUserId(server, 'qqbot', target.openId),
    send: (target, body, gate) => {
      gate.assertCanDispatch()
      return client.sendC2CMessage(target.openId, body, target.replyMsgId)
    },
    lease: updateReceiptLease,
    onError: (stage, error) => console.error(`[qqbot] update receipt ${stage} failed:`, error)
  })

  async function sendReplyWithTarget(
    target: QQBotTarget,
    payload: ChannelReplyPayload
  ): Promise<void> {
    await sendMessageWithTarget(target, payload.message?.trim() ?? '')
    for (const attachment of payload.attachments ?? []) {
      if (attachment.deliveryKind === 'image') {
        await client.sendC2CImage(
          target.openId,
          attachment.path,
          target.replyMsgId,
          attachment.filename
        )
        continue
      }
      await client.sendC2CFile(
        target.openId,
        attachment.path,
        target.replyMsgId,
        attachment.filename
      )
    }
  }

  /**
   * Public sendMessage for the send-channel path (manual sends from
   * settings UI). Throws when no inbound msg_id is cached — QQBot
   * can only send passive replies.
   */
  async function sendMessage(
    openId: string,
    text: string,
    options?: ChannelSendOptions
  ): Promise<void> {
    const replyMsgId = lastMessageId.get(openId)
    if (!replyMsgId) {
      throw new Error(`[qqbot] cannot send to ${openId.slice(0, 8)}: no inbound msg_id cached`)
    }
    await sendMessageWithTarget({ openId, replyMsgId }, text, options)
  }

  /**
   * Send without a reply target.
   *
   * After a restart there is no cached inbound id, so a passive reply is
   * impossible — but QQ does allow active messages, subject to per-user rate
   * limits and the user's own opt-out. Failure here is a real failure and is
   * left to the caller, which keeps its pending state rather than assuming
   * delivery.
   */
  async function sendActiveMessage(
    openId: string,
    text: string,
    options?: ChannelSendOptions
  ): Promise<void> {
    createChannelDispatchGate(options).assertCanDispatch()
    await client.sendC2CActiveMessage(openId, text)
  }

  const directMessages = createChannelDirectMessageRuntime<QQBotTarget>({
    platform: 'qqbot',
    logLabel: 'qqbot',
    server,
    policy,
    modelOverride,
    sendMessage: sendMessageWithTarget,
    sendReply: sendReplyWithTarget,
    startBatchIndicator: (target) => {
      console.log(`[qqbot] sending typing indicator (batch) for ${target.openId.slice(0, 8)}...`)
      void client
        .sendTypingIndicator(target.openId, target.replyMsgId)
        .then(() => console.log('[qqbot] typing indicator sent OK'))
        .catch((e) => console.warn('[qqbot] typing indicator failed:', e))
    },
    startHandlingIndicator: (target) => {
      console.log(`[qqbot] sending typing indicator (handling) for ${target.openId.slice(0, 8)}...`)
      void client
        .sendTypingIndicator(target.openId, target.replyMsgId)
        .then(() => console.log('[qqbot] typing indicator sent OK'))
        .catch((e) => console.warn('[qqbot] typing indicator failed:', e))
      const timer = setInterval(() => {
        void client
          .sendTypingIndicator(target.openId, target.replyMsgId)
          .then(() => console.log('[qqbot] typing keepalive sent OK'))
          .catch((e) => console.warn('[qqbot] typing keepalive failed:', e))
      }, 10_000)
      return () => clearInterval(timer)
    },
    replyDelayMs,
    nonRunReply: '抱歉，出了点问题。',
    errorReply: '出了点问题，请稍后再试。',
    formatGuestThreadTitle: (channelUser) => `QQBot:${channelUser.username}`
  })

  client.onC2CMessage((msg) => {
    const attachments = msg.attachments ?? []
    const hasImages = attachments.some((attachment) => attachment.contentType.startsWith('image/'))
    if (!msg.content && !hasImages) return

    const openId = msg.openId
    const text = msg.content

    // Cache for the send-channel (manual send) path.
    lastMessageId.set(openId, msg.messageId)

    console.log(
      `[qqbot] inbound DM from ${openId.slice(0, 8)}...: ${JSON.stringify(text.slice(0, 100))}`
    )

    const result = routeQQBotMessage({ openId, text }, storage)
    console.log(
      `[qqbot] route result: ${result.kind}${result.kind === 'allowed' ? ` (role=${result.channelUser.role})` : ''}`
    )

    switch (result.kind) {
      case 'blocked':
        return

      case 'pending':
        void sendMessageWithTarget({ openId, replyMsgId: msg.messageId }, result.reply).catch((e) =>
          console.error('[qqbot] failed to send pending reply', e)
        )
        return

      case 'limit-exceeded':
        void sendMessageWithTarget({ openId, replyMsgId: msg.messageId }, result.reply).catch((e) =>
          console.error('[qqbot] failed to send limit reply', e)
        )
        return

      case 'allowed': {
        // Capture the msg_id at enqueue time so this turn's replies
        // always attach to the correct inbound message.
        const target: QQBotTarget = { openId, replyMsgId: msg.messageId }
        const attachmentDownloads = startQQBotImageDownloads(attachments, policy)
        directMessages.enqueueMessage(target, result.channelUser, text, attachmentDownloads)
      }
    }
  })

  return {
    sendActiveMessage,
    start() {
      console.log(`[qqbot] connecting (appId=${appId})`)
      client.connect()
    },

    connect() {
      this.start()
    },

    async stop() {
      directMessages.stop()
      await client.close()
    },

    async healthCheck() {
      return client.healthCheck()
    },

    sendMessage
  }
}
