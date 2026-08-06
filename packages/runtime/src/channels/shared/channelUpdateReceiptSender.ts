import type {
  ChannelGroupRecord,
  ChannelPlatform,
  ChannelUserRecord
} from '@yachiyo/shared/protocol'

import {
  sendWithUpdateReceipt,
  type ChannelDispatchGate,
  type ChannelSendOptions,
  type UpdateReceiptLease
} from './sendWithUpdateReceipt.ts'

export interface ChannelRecordDirectory {
  listChannelUsers(): ChannelUserRecord[]
  listChannelGroups(): ChannelGroupRecord[]
}

export function findChannelUserId(
  directory: ChannelRecordDirectory,
  platform: ChannelPlatform,
  externalUserId: string
): string | undefined {
  return directory
    .listChannelUsers()
    .find((user) => user.platform === platform && user.externalUserId === externalUserId)?.id
}

export function findChannelGroupId(
  directory: ChannelRecordDirectory,
  platform: ChannelPlatform,
  externalGroupId: string
): string | undefined {
  return directory
    .listChannelGroups()
    .find((group) => group.platform === platform && group.externalGroupId === externalGroupId)?.id
}

export function findChannelId(
  directory: ChannelRecordDirectory,
  platform: ChannelPlatform,
  externalId: string
): string | undefined {
  return (
    findChannelUserId(directory, platform, externalId) ??
    findChannelGroupId(directory, platform, externalId)
  )
}

export function createChannelUpdateReceiptSender<TTarget>(input: {
  resolveChannelId(target: TTarget): string | undefined
  send(target: TTarget, text: string, gate: ChannelDispatchGate): Promise<void>
  lease: UpdateReceiptLease
  onError?: (stage: string, error: unknown) => void
  now?: () => number
}): (target: TTarget, text: string, options?: ChannelSendOptions) => Promise<void> {
  return (target, text, options) =>
    sendWithUpdateReceipt({
      channelId: input.resolveChannelId(target),
      text,
      send: (body, gate) => input.send(target, body, gate),
      lease: input.lease,
      onError: input.onError,
      sendOptions: options,
      now: input.now
    })
}
