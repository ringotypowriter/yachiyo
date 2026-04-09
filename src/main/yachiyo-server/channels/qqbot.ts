/**
 * QQBot channel routing — access control for incoming QQ Official Bot DMs.
 *
 * Same pattern as qq.ts: resolve user status from channelUsersTable,
 * allow/block/pend accordingly. All QQBot API calls are the caller's responsibility.
 *
 * QQBot uses opaque openId instead of raw QQ numbers.
 */

import { join } from 'node:path'
import type { ChannelUserRecord, ChannelUserStatus } from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'

export interface QQBotIncomingMessage {
  /** Opaque user identifier from QQ Official Bot API. */
  openId: string
  /** Message text content. */
  text: string
}

export type QQBotRouteResult =
  | { kind: 'allowed'; channelUser: ChannelUserRecord }
  | { kind: 'blocked' }
  | { kind: 'limit-exceeded'; reply: string }

export interface QQBotChannelStorage {
  findChannelUser(platform: 'qqbot', externalUserId: string): ChannelUserRecord | undefined
  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord
}

const LIMIT_REPLY = '抱歉，你的使用额度已经用完了，请联系主人。'

export function routeQQBotMessage(
  msg: QQBotIncomingMessage,
  storage: QQBotChannelStorage
): QQBotRouteResult {
  let channelUser = storage.findChannelUser('qqbot', msg.openId)

  if (!channelUser) {
    channelUser = storage.createChannelUser({
      id: `qqbot-${msg.openId}`,
      platform: 'qqbot',
      externalUserId: msg.openId,
      username: msg.openId.slice(0, 8),
      status: 'pending',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `qqbot-${msg.openId.slice(0, 16)}`)
    })
    return { kind: 'blocked' }
  }

  const status: ChannelUserStatus = channelUser.status

  if (status === 'pending' || status === 'blocked') {
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
