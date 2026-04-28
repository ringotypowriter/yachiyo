import {
  routeChannelDirectMessage,
  type ChannelDirectMessageRouteResult,
  type ChannelDirectMessageStorage
} from './channelDirectMessageRouter.ts'

export interface DiscordIncomingMessage {
  /** Discord user snowflake ID. */
  externalUserId: string
  /** Discord username (display name or tag). */
  username: string
  text: string
}

export type DiscordRouteResult = ChannelDirectMessageRouteResult

export type DiscordChannelStorage = ChannelDirectMessageStorage

export function routeDiscordMessage(
  msg: DiscordIncomingMessage,
  storage: DiscordChannelStorage
): DiscordRouteResult {
  return routeChannelDirectMessage(
    {
      platform: 'discord',
      externalUserId: msg.externalUserId,
      username: msg.username
    },
    storage
  )
}
