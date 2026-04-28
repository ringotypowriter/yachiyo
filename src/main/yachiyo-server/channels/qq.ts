import {
  routeChannelDirectMessage,
  type ChannelDirectMessageRouteResult,
  type ChannelDirectMessageStorage
} from './channelDirectMessageRouter.ts'

export interface QQIncomingMessage {
  /** QQ number as string. */
  userId: string
  /** QQ nickname. */
  nickname: string
  text: string
}

export type QQRouteResult = ChannelDirectMessageRouteResult

export type QQChannelStorage = ChannelDirectMessageStorage

export function routeQQMessage(msg: QQIncomingMessage, storage: QQChannelStorage): QQRouteResult {
  return routeChannelDirectMessage(
    {
      platform: 'qq',
      externalUserId: msg.userId,
      username: msg.nickname
    },
    storage
  )
}
