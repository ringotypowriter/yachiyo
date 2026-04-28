import {
  routeChannelDirectMessage,
  type ChannelDirectMessageRouteResult,
  type ChannelDirectMessageStorage
} from './channelDirectMessageRouter.ts'

/** Minimal shape of an incoming Telegram message the stub expects. */
export interface TelegramIncomingMessage {
  /** Telegram numeric chat/user id (string form). */
  externalUserId: string
  /** Telegram @username or display name. */
  username: string
  text: string
}

/**
 * Result returned by `routeTelegramMessage`.
 * The caller is responsible for actually sending `reply` back to Telegram.
 */
export type TelegramRouteResult = ChannelDirectMessageRouteResult

/** Storage subset the Telegram router needs. */
export type TelegramChannelStorage = ChannelDirectMessageStorage

/**
 * Core routing logic for a single incoming Telegram message.
 *
 * Does NOT perform I/O beyond what `storage` provides; all Telegram API calls
 * (sending the reply, polling, etc.) are the responsibility of the caller.
 */
export function routeTelegramMessage(
  msg: TelegramIncomingMessage,
  storage: TelegramChannelStorage
): TelegramRouteResult {
  return routeChannelDirectMessage(
    {
      platform: 'telegram',
      externalUserId: msg.externalUserId,
      username: msg.username
    },
    storage
  )
}
