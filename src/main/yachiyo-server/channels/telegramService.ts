/**
 * Telegram bot service using the Chat SDK with @chat-adapter/telegram.
 *
 * Flow for an allowed user:
 *   1. Route the message through `routeTelegramMessage` for access control.
 *   2. Inject CHANNEL_REPLY_HINT so the model knows to wrap its reply in
 *      <reply></reply> tags.
 *   3. Collect the full AI output from server events.
 *   4. Parse the <reply> content and send it back to Telegram.
 */

import { Chat } from 'chat'
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { createMemoryState } from '@chat-adapter/state-memory'

import type {
  ChannelUserRecord,
  ToolCallName,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol'
import type { YachiyoServer } from '../app/YachiyoServer'
import { CHANNEL_REPLY_HINT, extractChannelReply } from './channelReply'
import { routeTelegramMessage, type TelegramChannelStorage } from './telegram'

import { resolveYachiyoTempWorkspaceRoot } from '../config/paths'
import { join } from 'node:path'

/** Read-only tools that are safe to expose to external channel users. */
const CHANNEL_ALLOWED_TOOLS: ToolCallName[] = ['read', 'grep', 'glob', 'webRead', 'webSearch']

/** Telegram typing indicator expires after ~5 s; resend every 4 s. */
const TYPING_INTERVAL_MS = 4_000

/** Reuse a thread if the last activity was within 24 hours. */
const THREAD_REUSE_WINDOW_MS = 24 * 60 * 60 * 1_000

/** Compact to a new thread when context reaches 64k tokens. */
const THREAD_CONTEXT_LIMIT = 64_000

export interface TelegramServiceOptions {
  /** Telegram Bot API token. */
  botToken: string
  /** The Yachiyo server instance for running AI generation and storage. */
  server: YachiyoServer
}

export interface TelegramService {
  /** Start long-polling. */
  startPolling: () => void
  /** Gracefully shut down the bot. */
  stop: () => Promise<void>
}

export function createTelegramService({
  botToken,
  server
}: TelegramServiceOptions): TelegramService {
  const apiBase = `https://api.telegram.org/bot${botToken}`

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

  /** Send "typing…" chat action to the given Telegram chat. */
  function sendTyping(chatId: string): void {
    void fetch(`${apiBase}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    }).catch(() => {})
  }

  /** Start a periodic typing indicator; returns a stop function. */
  function startTypingLoop(chatId: string): () => void {
    sendTyping(chatId)
    const timer = setInterval(() => sendTyping(chatId), TYPING_INTERVAL_MS)
    return () => clearInterval(timer)
  }

  const adapter = createTelegramAdapter({
    botToken,
    mode: 'polling'
  })

  const bot = new Chat({
    userName: 'yachiyo',
    adapters: { telegram: adapter },
    state: createMemoryState()
  })

  // Handle every DM. Since we never call thread.subscribe(), this fires for
  // every incoming message (the thread stays unsubscribed).
  bot.onDirectMessage(
    async (
      thread: unknown,
      message: { text: string; author: { userId: string; userName: string }; threadId: string }
    ) => {
      const incomingText = message.text ?? ''
      const externalUserId = String(message.author.userId)
      const username = message.author.userName ?? externalUserId

      console.log(
        `[telegram] inbound DM from ${username} (${externalUserId}): ${JSON.stringify(incomingText)}`
      )

      const result = routeTelegramMessage({ externalUserId, username, text: incomingText }, storage)

      console.log(`[telegram] route result: ${result.kind}`)

      // Extract Telegram chat ID from the SDK thread ID (format: telegram:{chatId})
      const chatId = message.threadId?.replace(/^telegram:/, '') ?? externalUserId

      switch (result.kind) {
        case 'blocked':
          return

        case 'pending':
          await (thread as { post: (text: string) => Promise<void> }).post(result.reply)
          return

        case 'limit-exceeded':
          await (thread as { post: (text: string) => Promise<void> }).post(result.reply)
          return

        case 'allowed':
          await handleAllowedMessage(
            thread as { post: (text: string) => Promise<void> },
            chatId,
            result.channelUser,
            incomingText
          )
      }
    }
  )

  /** Resolve a user-specific workspace path shared across all their threads. */
  function resolveUserWorkspace(username: string): string {
    return join(resolveYachiyoTempWorkspaceRoot(), `tg-${username}`)
  }

  /** Find or create the right thread for this channel user. */
  async function resolveThread(channelUser: ChannelUserRecord): Promise<{
    thread: import('../../../shared/yachiyo/protocol').ThreadRecord
    compacted: boolean
  }> {
    const workspace = resolveUserWorkspace(channelUser.username)
    const existing = server.findActiveChannelThread(channelUser.id, THREAD_REUSE_WINDOW_MS)

    if (existing) {
      const totalTokens = server.getThreadTotalTokens(existing.id)
      console.log(`[telegram] existing thread ${existing.id} — ${totalTokens} tokens`)

      if (totalTokens < THREAD_CONTEXT_LIMIT) {
        return { thread: existing, compacted: false }
      }

      // Context limit reached — compact to a new thread.
      console.log(
        `[telegram] thread ${existing.id} exceeded ${THREAD_CONTEXT_LIMIT} tokens, compacting`
      )
      const accepted = await server.compactThreadToAnotherThread({ threadId: existing.id })
      return { thread: accepted.thread, compacted: true }
    }

    // No reusable thread — create a fresh one.
    const thread = await server.createThread({
      workspacePath: workspace,
      source: 'telegram',
      channelUserId: channelUser.id,
      title: `Telegram:@${channelUser.username}`
    })
    return { thread, compacted: false }
  }

  async function handleAllowedMessage(
    thread: { post: (text: string) => Promise<void> },
    chatId: string,
    channelUser: ChannelUserRecord,
    text: string
  ): Promise<void> {
    const stopTyping = startTypingLoop(chatId)
    try {
      console.log(`[telegram] handling allowed message for user ${channelUser.username}`)
      const { thread: yachiyoThread, compacted } = await resolveThread(channelUser)
      console.log(`[telegram] using thread ${yachiyoThread.id}${compacted ? ' (compacted)' : ''}`)

      // If we just compacted, wait for the compact run to finish before sending.
      if (compacted) {
        await collectRunOutput(server, yachiyoThread.id)
        console.log(`[telegram] compact run finished for thread ${yachiyoThread.id}`)
      }

      // Subscribe BEFORE sendChat so we don't miss early events.
      const outputPromise = collectRunOutput(server, yachiyoThread.id)

      const accepted = await server.sendChat({
        threadId: yachiyoThread.id,
        content: text,
        enabledTools: CHANNEL_ALLOWED_TOOLS,
        channelHint: CHANNEL_REPLY_HINT
      })
      console.log(`[telegram] sendChat accepted:`, accepted)

      if (!('runId' in accepted)) {
        console.warn('[telegram] sendChat returned non-run accepted:', accepted)
        await thread.post('Sorry, something went wrong on my end.')
        return
      }

      const rawOutput = await outputPromise
      console.log(`[telegram] rawOutput:`, rawOutput.slice(0, 200))
      const parsedReply = extractChannelReply(rawOutput)
      console.log(`[telegram] parsedReply:`, parsedReply)

      if (parsedReply) {
        await thread.post(parsedReply)
      }

      // Record token usage against the channel user.
      const totalTokens = server.getThreadTotalTokens(yachiyoThread.id)
      if (totalTokens > 0) {
        const kTokens = Math.ceil(totalTokens / 1000)
        server.updateChannelUser({ id: channelUser.id, usedKTokens: kTokens })
        console.log(`[telegram] updated usedKTokens for ${channelUser.username}: ${kTokens}k`)
      }
    } catch (error) {
      console.error('[telegram] failed to handle allowed message', error)
      await thread.post('Something went wrong. Please try again in a moment.')
    } finally {
      stopTyping()
    }
  }

  return {
    startPolling() {
      console.log('[telegram] startPolling called — initializing Chat SDK')
      void bot.initialize()
    },
    async stop() {
      await bot.shutdown()
    }
  }
}

/**
 * Subscribe to server events for `threadId` and resolve with the complete
 * assistant text once the run finishes (completed or failed).
 */
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
