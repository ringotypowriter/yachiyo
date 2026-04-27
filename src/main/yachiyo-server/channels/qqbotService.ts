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

import type {
  ChannelUserRecord,
  ThreadModelOverride,
  ThreadRecord
} from '../../../shared/yachiyo/protocol.ts'
import type { YachiyoServer } from '../app/YachiyoServer.ts'
import { qqbotPolicy, type ChannelPolicy } from './channelPolicy.ts'
import {
  createDirectMessageService,
  resolveDirectMessageThread,
  type DirectMessageThreadResolution
} from './directMessageService.ts'
import { handleDmSlashCommand, shouldDiscardPendingBatchForDmCommand } from './dmSlashCommands.ts'
import { createQQBotClient, type QQBotClient } from './qqbotClient.ts'
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
}

export interface QQBotService {
  connect: () => void
  stop: () => Promise<void>
  /**
   * Send a DM to a QQBot user by openId.
   * Throws if no inbound msg_id is cached (QQBot only supports passive replies).
   */
  sendMessage: (openId: string, text: string) => Promise<void>
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

export function createQQBotService({
  appId,
  clientSecret,
  model: modelOverride,
  server,
  policy: policyOverride
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

  const client: QQBotClient = createQQBotClient({ appId, clientSecret })

  /**
   * Track the most recent inbound messageId per user for the
   * send-channel (manual send) path, which doesn't go through
   * DirectMessageService and therefore has no per-turn target.
   */
  const lastMessageId = new Map<string, string>()

  async function sendMessageWithTarget(target: QQBotTarget, text: string): Promise<void> {
    await client.sendC2CMessage(target.openId, text, target.replyMsgId)
  }

  /**
   * Public sendMessage for the send-channel path (manual sends from
   * settings UI). Throws when no inbound msg_id is cached — QQBot
   * can only send passive replies.
   */
  async function sendMessage(openId: string, text: string): Promise<void> {
    const replyMsgId = lastMessageId.get(openId)
    if (!replyMsgId) {
      throw new Error(
        `[qqbot] cannot send to ${openId.slice(0, 8)}: no inbound msg_id cached (QQBot only supports passive replies)`
      )
    }
    await client.sendC2CMessage(openId, text, replyMsgId)
  }

  async function resolveThread(
    channelUser: ChannelUserRecord
  ): Promise<DirectMessageThreadResolution> {
    return resolveDirectMessageThread({
      logLabel: 'qqbot',
      server,
      channelUser,
      policy,
      modelOverride,
      createThread: async (input): Promise<ThreadRecord> =>
        server.createThread({
          source: 'qqbot',
          channelUserId: channelUser.id,
          ...(channelUser.role === 'owner'
            ? input?.workspacePath
              ? { workspacePath: input.workspacePath }
              : {}
            : { workspacePath: channelUser.workspacePath, title: `QQBot:${channelUser.username}` }),
          ...(input?.handoffFromThreadId ? { handoffFromThreadId: input.handoffFromThreadId } : {})
        })
    })
  }

  const directMessages = createDirectMessageService<QQBotTarget>({
    logLabel: 'qqbot',
    server,
    policy,
    resolveThread,
    sendMessage: sendMessageWithTarget,
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
    nonRunReply: '抱歉，出了点问题。',
    errorReply: '出了点问题，请稍后再试。',
    shouldDiscardPendingBatch: shouldDiscardPendingBatchForDmCommand,
    handleSlashCommand: (target, channelUser, command, args, context) =>
      handleDmSlashCommand(
        {
          server,
          threadReuseWindowMs: policy.threadReuseWindowMs,
          contextTokenLimit: policy.contextTokenLimit,
          createFreshThread: (user) =>
            server.createThread({
              source: 'qqbot',
              channelUserId: user.id,
              ...(user.role === 'owner'
                ? {}
                : { workspacePath: user.workspacePath, title: `QQBot:${user.username}` })
            }),
          sendMessage: sendMessageWithTarget,
          requestStop: (userId) => directMessages.requestStop(userId)
        },
        target,
        channelUser,
        command,
        args,
        context
      )
  })

  client.onC2CMessage((msg) => {
    if (!msg.content) return

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

      case 'limit-exceeded':
        void client
          .sendC2CMessage(openId, result.reply, msg.messageId)
          .catch((e) => console.error('[qqbot] failed to send limit reply', e))
        return

      case 'allowed': {
        // Capture the msg_id at enqueue time so this turn's replies
        // always attach to the correct inbound message.
        const target: QQBotTarget = { openId, replyMsgId: msg.messageId }
        directMessages.enqueueMessage(target, result.channelUser, text, [])
      }
    }
  })

  return {
    connect() {
      console.log(`[qqbot] connecting (appId=${appId})`)
      client.connect()
    },

    async stop() {
      directMessages.stop()
      await client.close()
    },

    sendMessage
  }
}
