import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findChannelGroupId,
  findChannelUserId,
  type ChannelRecordDirectory
} from './channelUpdateReceiptSender.ts'

test('resolves QQ user and group ids in their separate external-id namespaces', () => {
  const directory = {
    listChannelUsers: () => [
      {
        id: 'qq-user-42',
        platform: 'qq',
        externalUserId: '42'
      }
    ],
    listChannelGroups: () => [
      {
        id: 'qq-group-42',
        platform: 'qq',
        externalGroupId: '42'
      }
    ]
  } as unknown as ChannelRecordDirectory

  assert.equal(findChannelUserId(directory, 'qq', '42'), 'qq-user-42')
  assert.equal(findChannelGroupId(directory, 'qq', '42'), 'qq-group-42')
})
