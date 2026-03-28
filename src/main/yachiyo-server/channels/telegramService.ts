/**
 * Telegram bot service using the Chat SDK with @chat-adapter/telegram.
 *
 * Flow for an allowed user:
 *   1. Route the message through `routeTelegramMessage` for access control.
 *   2. Buffer rapid messages with a random debounce delay (3-8 s).
 *   3. When the debounce window expires, join buffered texts and run AI generation.
 *   4. Inject channel reply instruction so the model wraps its reply in
 *      <reply></reply> tags.
 *   5. Collect the full AI output from server events.
 *   6. Parse the <reply> content and send it back to Telegram.
 */

import { Chat } from 'chat'
import { createTelegramAdapter } from '@chat-adapter/telegram'
import { createMemoryState } from '@chat-adapter/state-memory'

import type {
  ChannelUserRecord,
  ThreadModelOverride,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol'
import type { YachiyoServer } from '../app/YachiyoServer'
import { telegramPolicy } from './channelPolicy'
import { routeTelegramMessage, type TelegramChannelStorage } from './telegram'

import { resolveYachiyoTempWorkspaceRoot } from '../config/paths'
import { join } from 'node:path'

/** Telegram typing indicator expires after ~5 s; resend every 4 s. */
const TYPING_INTERVAL_MS = 4_000

/** Minimum debounce delay before flushing a message batch. */
const REPLY_DELAY_MIN_MS = 3_000
/** Maximum debounce delay before flushing a message batch. */
const REPLY_DELAY_MAX_MS = 8_000

function randomReplyDelay(): number {
  return REPLY_DELAY_MIN_MS + Math.random() * (REPLY_DELAY_MAX_MS - REPLY_DELAY_MIN_MS)
}

interface PendingBatch {
  messages: string[]
  timer: ReturnType<typeof setTimeout>
  thread: { post: (text: string) => Promise<void> }
  chatId: string
  channelUser: ChannelUserRecord
  stopTyping: () => void
}

export interface TelegramServiceOptions {
  /** Telegram Bot API token. */
  botToken: string
  /** Optional model override for Telegram threads. */
  model?: ThreadModelOverride
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
  model: modelOverride,
  server
}: TelegramServiceOptions): TelegramService {
  const apiBase = `https://api.telegram.org/bot${botToken}`
  const policy = telegramPolicy

  /** Per-user message buffer for debounced reply batching. */
  const pendingBatches = new Map<string, PendingBatch>()

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
          enqueueMessage(
            thread as { post: (text: string) => Promise<void> },
            chatId,
            result.channelUser,
            incomingText
          )
      }
    }
  )

  /**
   * Buffer an incoming message and schedule a debounced flush.
   * If the user sends more messages before the timer fires, the timer resets
   * with a fresh random delay — so the bot waits for a natural pause.
   */
  function enqueueMessage(
    thread: { post: (text: string) => Promise<void> },
    chatId: string,
    channelUser: ChannelUserRecord,
    text: string
  ): void {
    const userId = channelUser.id
    const existing = pendingBatches.get(userId)

    if (existing) {
      // Append to existing batch, reset the debounce timer.
      existing.messages.push(text)
      clearTimeout(existing.timer)
      const delay = randomReplyDelay()
      existing.timer = setTimeout(() => flushBatch(userId), delay)
      console.log(
        `[telegram] appended to batch for ${channelUser.username} (${existing.messages.length} msgs, next flush in ${Math.round(delay)}ms)`
      )
      return
    }

    // Start a new batch with a typing indicator.
    const stopTyping = startTypingLoop(chatId)
    const delay = randomReplyDelay()
    const timer = setTimeout(() => flushBatch(userId), delay)

    pendingBatches.set(userId, {
      messages: [text],
      timer,
      thread,
      chatId,
      channelUser,
      stopTyping
    })

    console.log(
      `[telegram] new batch for ${channelUser.username} (flush in ${Math.round(delay)}ms)`
    )
  }

  /** Flush a user's buffered messages and process them as a single request. */
  function flushBatch(userId: string): void {
    const batch = pendingBatches.get(userId)
    if (!batch) return
    pendingBatches.delete(userId)

    const joinedText = batch.messages.join('\n')
    console.log(
      `[telegram] flushing batch for ${batch.channelUser.username}: ${batch.messages.length} message(s)`
    )

    // handleAllowedMessage manages its own typing loop, so stop the batch one.
    batch.stopTyping()

    void handleAllowedMessage(batch.thread, batch.chatId, batch.channelUser, joinedText)
  }

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
    const existing = server.findActiveChannelThread(channelUser.id, policy.threadReuseWindowMs)

    if (existing) {
      // Reconcile model override so config changes take effect on reused threads.
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
          `[telegram] reconciled model override on thread ${existing.id}:`,
          wantedOverride ?? 'cleared'
        )
      }

      const totalTokens = server.getThreadTotalTokens(thread.id)
      console.log(`[telegram] existing thread ${thread.id} — ${totalTokens} tokens`)

      if (totalTokens < policy.contextTokenLimit) {
        return { thread, compacted: false }
      }

      // Context limit reached — generate rolling summary in-place.
      console.log(
        `[telegram] thread ${thread.id} exceeded ${policy.contextTokenLimit} tokens, generating rolling summary`
      )
      const { thread: compactedThread } = await server.compactExternalThread({
        threadId: existing.id
      })
      return { thread: compactedThread, compacted: true }
    }

    // No reusable thread — create a fresh one.
    let thread = await server.createThread({
      workspacePath: workspace,
      source: 'telegram',
      channelUserId: channelUser.id,
      title: `Telegram:@${channelUser.username}`
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
    thread: { post: (text: string) => Promise<void> },
    chatId: string,
    channelUser: ChannelUserRecord,
    text: string
  ): Promise<void> {
    const stopTyping = startTypingLoop(chatId)
    try {
      console.log(`[telegram] handling allowed message for user ${channelUser.username}`)
      const { thread: yachiyoThread, compacted } = await resolveThread(channelUser)
      console.log(
        `[telegram] using thread ${yachiyoThread.id}${compacted ? ' (rolling summary generated)' : ''}`
      )

      // Subscribe BEFORE sendChat so we don't miss early events.
      const outputPromise = collectRunOutput(server, yachiyoThread.id)

      const accepted = await server.sendChat({
        threadId: yachiyoThread.id,
        content: text,
        enabledTools: policy.allowedTools,
        channelHint: policy.replyInstruction
      })
      console.log(`[telegram] sendChat accepted:`, accepted)

      if (!('runId' in accepted)) {
        console.warn('[telegram] sendChat returned non-run accepted:', accepted)
        await thread.post('Sorry, something went wrong on my end.')
        return
      }

      const rawOutput = await outputPromise
      console.log(`[telegram] rawOutput:`, rawOutput.slice(0, 200))
      const parsedReply = policy.extractVisibleReply(rawOutput)
      console.log(`[telegram] parsedReply:`, parsedReply)

      if (parsedReply) {
        await thread.post(parsedReply)
      }

      // Store the visible reply on the assistant message for future summary generation.
      server.updateLatestAssistantVisibleReply({
        threadId: yachiyoThread.id,
        visibleReply: parsedReply
      })

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
      // Discard pending batches on shutdown — stop timers and typing indicators.
      for (const [userId, batch] of pendingBatches) {
        clearTimeout(batch.timer)
        batch.stopTyping()
        pendingBatches.delete(userId)
        console.log(
          `[telegram] discarded pending batch for ${batch.channelUser.username} on shutdown`
        )
      }
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
