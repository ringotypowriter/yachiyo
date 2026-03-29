/**
 * Discord channel routing — access control for incoming Discord DMs.
 *
 * Same pattern as telegram.ts / qq.ts: resolve user status from
 * channelUsersTable, allow/block/pend accordingly. All Discord API calls
 * are the caller's responsibility.
 */

import { join } from 'node:path'
import type { ChannelUserRecord, ChannelUserStatus } from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'

export interface DiscordIncomingMessage {
  /** Discord user snowflake ID. */
  externalUserId: string
  /** Discord username (display name or tag). */
  username: string
  text: string
}

export type DiscordRouteResult =
  | { kind: 'allowed'; channelUser: ChannelUserRecord }
  | { kind: 'blocked' }
  | { kind: 'pending'; reply: string }
  | { kind: 'limit-exceeded'; reply: string }

export interface DiscordChannelStorage {
  findChannelUser(platform: 'discord', externalUserId: string): ChannelUserRecord | undefined
  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord
}

const PENDING_REPLY =
  "Hey! I've let my owner know you'd like to chat. I won't send any more messages until they approve you – sit tight!"

const LIMIT_REPLY =
  "Sorry, you've reached your usage limit for this period. Please contact the owner to continue."

export function routeDiscordMessage(
  msg: DiscordIncomingMessage,
  storage: DiscordChannelStorage
): DiscordRouteResult {
  let channelUser = storage.findChannelUser('discord', msg.externalUserId)

  if (!channelUser) {
    channelUser = storage.createChannelUser({
      id: `dc-${msg.externalUserId}`,
      platform: 'discord',
      externalUserId: msg.externalUserId,
      username: msg.username,
      status: 'pending',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `dc-${msg.username}`)
    })
    return { kind: 'pending', reply: PENDING_REPLY }
  }

  const status: ChannelUserStatus = channelUser.status

  if (status === 'pending') {
    return { kind: 'blocked' }
  }

  if (status === 'blocked') {
    return { kind: 'blocked' }
  }

  if (
    channelUser.usageLimitKTokens !== null &&
    channelUser.usedKTokens >= channelUser.usageLimitKTokens
  ) {
    return { kind: 'limit-exceeded', reply: LIMIT_REPLY }
  }

  return { kind: 'allowed', channelUser }
}
