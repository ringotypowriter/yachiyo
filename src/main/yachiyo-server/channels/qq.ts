/**
 * QQ channel routing — access control for incoming QQ private messages.
 *
 * Same pattern as telegram.ts: resolve user status from channelUsersTable,
 * allow/block/pend accordingly. All QQ API calls are the caller's responsibility.
 */

import { join } from 'node:path'
import type { ChannelUserRecord, ChannelUserStatus } from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'

export interface QQIncomingMessage {
  /** QQ number as string. */
  userId: string
  /** QQ nickname. */
  nickname: string
  text: string
}

export type QQRouteResult =
  | { kind: 'allowed'; channelUser: ChannelUserRecord }
  | { kind: 'blocked' }
  | { kind: 'limit-exceeded'; reply: string }

export interface QQChannelStorage {
  findChannelUser(platform: 'qq', externalUserId: string): ChannelUserRecord | undefined
  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord
}

const LIMIT_REPLY = '抱歉，你的使用额度已经用完了，请联系主人。'

export function routeQQMessage(msg: QQIncomingMessage, storage: QQChannelStorage): QQRouteResult {
  let channelUser = storage.findChannelUser('qq', msg.userId)

  if (!channelUser) {
    channelUser = storage.createChannelUser({
      id: `qq-${msg.userId}`,
      platform: 'qq',
      externalUserId: msg.userId,
      username: msg.nickname,
      label: '',
      status: 'pending',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `qq-${msg.userId}`)
    })
    // Silent on first contact — QQ monitors auto-replies from bots.
    // User is created as pending; owner approves via settings.
    return { kind: 'blocked' }
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
