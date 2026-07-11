import assert from 'node:assert/strict'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from './memoryStorage.ts'

test('in-memory review eligibility counts only review-visible source threads', () => {
  const storage = createInMemoryYachiyoStorage()
  const timestamp = '2026-07-11T10:00:00.000Z'

  storage.createChannelGroup({
    id: 'group-1',
    platform: 'qq',
    externalGroupId: '459936541',
    name: '杂鱼村',
    label: '杂鱼村',
    status: 'approved',
    workspacePath: '/tmp/group-workspace'
  })
  const owner = storage.createChannelUser({
    id: 'owner-user',
    platform: 'telegram',
    externalUserId: 'owner-1',
    username: 'owner',
    label: '',
    status: 'allowed',
    role: 'owner',
    usageLimitKTokens: null,
    workspacePath: '/tmp/owner'
  })
  const guest = storage.createChannelUser({
    id: 'guest-user',
    platform: 'telegram',
    externalUserId: 'guest-1',
    username: 'guest',
    label: '',
    status: 'allowed',
    role: 'guest',
    usageLimitKTokens: null,
    workspacePath: '/tmp/guest'
  })

  for (const thread of [
    { id: 'local-thread', title: 'Local conversation', source: 'local' },
    { id: 'owner-thread', title: 'Owner DM', source: 'telegram', channelUserId: owner.id },
    { id: 'guest-thread', title: 'Guest DM', source: 'telegram', channelUserId: guest.id },
    { id: 'group-thread', title: '杂鱼村 [group probe]', source: 'qq', channelGroupId: 'group-1' },
    { id: 'archived-thread', title: 'Archived', source: 'local' },
    { id: 'private-thread', title: 'Private', source: 'local', privacyMode: true },
    {
      id: 'schedule-thread',
      title: 'Scheduled',
      source: 'local',
      createdFromScheduleId: 'schedule-1'
    }
  ] as const) {
    storage.createThread({
      thread: {
        ...thread,
        headMessageId: `${thread.id}-message`,
        updatedAt: timestamp
      },
      createdAt: timestamp,
      messages: [
        {
          id: `${thread.id}-message`,
          threadId: thread.id,
          role: 'user',
          content: thread.title,
          status: 'completed',
          createdAt: timestamp
        }
      ]
    })
  }
  storage.archiveThread({
    threadId: 'archived-thread',
    archivedAt: timestamp,
    updatedAt: timestamp
  })

  assert.equal(storage.countSelfReviewableThreads(), 2)
  assert.equal(storage.countThingReviewSourceThreadsActiveSince('2026-07-11T00:00:00.000Z'), 2)
})
