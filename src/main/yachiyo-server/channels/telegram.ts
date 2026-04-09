/**
 * Telegram channel stub.
 *
 * Handles incoming Telegram messages: resolves the user's status in
 * channelUsersTable and either allows the conversation to proceed, blocks it,
 * or sends a one-time "pending approval" reply while discarding further input.
 *
 * Full Bot API integration (polling / webhook) is NOT wired up yet – this
 * module only contains the core routing logic so the DB schema, types, and
 * workspace resolution are exercisable before the transport layer lands.
 */

import { join } from 'node:path'
import type { ChannelUserRecord, ChannelUserStatus } from '../../../shared/yachiyo/protocol'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths'

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
export type TelegramRouteResult =
  | { kind: 'allowed'; channelUser: ChannelUserRecord; workspacePath: string }
  | { kind: 'blocked' }
  | { kind: 'pending'; reply: string }
  | { kind: 'limit-exceeded'; reply: string }

/** Storage subset the Telegram router needs. */
export interface TelegramChannelStorage {
  findChannelUser(platform: 'telegram', externalUserId: string): ChannelUserRecord | undefined
  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord
}

const PENDING_REPLY =
  "Hey! I've let my owner know you'd like to chat. I won't send any more messages until they approve you – sit tight!"

const LIMIT_REPLY =
  "Sorry, you've reached your usage limit for this period. Please contact the owner to continue."

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
  let channelUser = storage.findChannelUser('telegram', msg.externalUserId)

  if (!channelUser) {
    // First contact: register the user as pending and notify owner.
    channelUser = storage.createChannelUser({
      id: `tg-${msg.externalUserId}`,
      platform: 'telegram',
      externalUserId: msg.externalUserId,
      username: msg.username,
      label: '',
      status: 'pending',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: join(resolveYachiyoTempWorkspaceRoot(), `tg-${msg.username}`)
    })
    return { kind: 'pending', reply: PENDING_REPLY }
  }

  const status: ChannelUserStatus = channelUser.status

  if (status === 'pending') {
    // Already registered, silently discard to avoid spam.
    return { kind: 'blocked' }
  }

  if (status === 'blocked') {
    return { kind: 'blocked' }
  }

  // status === 'allowed'
  if (
    channelUser.usageLimitKTokens !== null &&
    channelUser.usedKTokens >= channelUser.usageLimitKTokens
  ) {
    return { kind: 'limit-exceeded', reply: LIMIT_REPLY }
  }

  return {
    kind: 'allowed',
    channelUser,
    workspacePath: channelUser.workspacePath
  }
}
