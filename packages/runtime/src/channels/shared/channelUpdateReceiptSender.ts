import type {
  ChannelGroupRecord,
  ChannelPlatform,
  ChannelUserRecord
} from '@yachiyo/shared/protocol'

import { sendWithUpdateReceipt, type UpdateReceiptLease } from './sendWithUpdateReceipt.ts'

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
  send(target: TTarget, text: string): Promise<void>
  lease: UpdateReceiptLease
  onError?: (stage: string, error: unknown) => void
}): (target: TTarget, text: string) => Promise<void> {
  return (target, text) =>
    sendWithUpdateReceipt({
      channelId: input.resolveChannelId(target),
      text,
      send: (body) => input.send(target, body),
      lease: input.lease,
      onError: input.onError
    })
}
