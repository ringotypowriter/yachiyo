import { join } from 'node:path'

import type {
  ChannelPlatform,
  ChannelUserRecord,
  ChannelUserStatus
} from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'

export interface ChannelDirectMessageInput {
  platform: ChannelPlatform
  externalUserId: string
  username: string
}

export type ChannelDirectMessageRouteResult =
  | { kind: 'allowed'; channelUser: ChannelUserRecord; workspacePath: string }
  | { kind: 'blocked' }
  | { kind: 'pending'; reply: string }
  | { kind: 'limit-exceeded'; reply: string }

export interface ChannelDirectMessageStorage {
  findChannelUser(platform: ChannelPlatform, externalUserId: string): ChannelUserRecord | undefined
  createChannelUser(user: Omit<ChannelUserRecord, 'usedKTokens'>): ChannelUserRecord
}

interface ChannelDirectMessageRouteProfile {
  id(input: ChannelDirectMessageInput): string
  username(input: ChannelDirectMessageInput): string
  workspacePath(input: ChannelDirectMessageInput): string
  firstContactReply?: string
  limitReply: string
}

const ENGLISH_PENDING_REPLY =
  "Hey! I've let my owner know you'd like to chat. I won't send any more messages until they approve you – sit tight!"

const ENGLISH_LIMIT_REPLY =
  "Sorry, you've reached your usage limit for this period. Please contact the owner to continue."

const CHINESE_LIMIT_REPLY = '抱歉，你的使用额度已经用完了，请联系主人。'

function tempWorkspace(name: string): string {
  return join(resolveYachiyoTempWorkspaceRoot(), name)
}

const channelDirectMessageProfiles: Record<ChannelPlatform, ChannelDirectMessageRouteProfile> = {
  telegram: {
    id: (input) => `tg-${input.externalUserId}`,
    username: (input) => input.username,
    workspacePath: (input) => tempWorkspace(`tg-${input.username}`),
    firstContactReply: ENGLISH_PENDING_REPLY,
    limitReply: ENGLISH_LIMIT_REPLY
  },
  discord: {
    id: (input) => `dc-${input.externalUserId}`,
    username: (input) => input.username,
    workspacePath: (input) => tempWorkspace(`dc-${input.username}`),
    firstContactReply: ENGLISH_PENDING_REPLY,
    limitReply: ENGLISH_LIMIT_REPLY
  },
  qq: {
    id: (input) => `qq-${input.externalUserId}`,
    username: (input) => input.username,
    workspacePath: (input) => tempWorkspace(`qq-${input.externalUserId}`),
    limitReply: CHINESE_LIMIT_REPLY
  },
  qqbot: {
    id: (input) => `qqbot-${input.externalUserId}`,
    username: (input) => input.externalUserId.slice(0, 8),
    workspacePath: (input) => tempWorkspace(`qqbot-${input.externalUserId.slice(0, 16)}`),
    limitReply: CHINESE_LIMIT_REPLY
  }
}

export function routeChannelDirectMessage(
  input: ChannelDirectMessageInput,
  storage: ChannelDirectMessageStorage
): ChannelDirectMessageRouteResult {
  const profile = channelDirectMessageProfiles[input.platform]
  let channelUser = storage.findChannelUser(input.platform, input.externalUserId)

  if (!channelUser) {
    channelUser = storage.createChannelUser({
      id: profile.id(input),
      platform: input.platform,
      externalUserId: input.externalUserId,
      username: profile.username(input),
      label: '',
      status: 'pending',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: profile.workspacePath(input)
    })
    return profile.firstContactReply
      ? { kind: 'pending', reply: profile.firstContactReply }
      : { kind: 'blocked' }
  }

  const status: ChannelUserStatus = channelUser.status

  if (status === 'pending' || status === 'blocked') {
    return { kind: 'blocked' }
  }

  if (
    channelUser.usageLimitKTokens !== null &&
    channelUser.usedKTokens >= channelUser.usageLimitKTokens
  ) {
    return { kind: 'limit-exceeded', reply: profile.limitReply }
  }

  return {
    kind: 'allowed',
    channelUser,
    workspacePath: channelUser.workspacePath
  }
}
