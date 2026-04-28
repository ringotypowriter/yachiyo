import {
  routeChannelDirectMessage,
  type ChannelDirectMessageRouteResult,
  type ChannelDirectMessageStorage
} from './channelDirectMessageRouter.ts'

export interface QQBotIncomingMessage {
  /** Opaque user identifier from QQ Official Bot API. */
  openId: string
  /** Message text content. */
  text: string
}

export type QQBotRouteResult = ChannelDirectMessageRouteResult

export type QQBotChannelStorage = ChannelDirectMessageStorage

export function routeQQBotMessage(
  msg: QQBotIncomingMessage,
  storage: QQBotChannelStorage
): QQBotRouteResult {
  return routeChannelDirectMessage(
    {
      platform: 'qqbot',
      externalUserId: msg.openId,
      username: msg.openId
    },
    storage
  )
}
