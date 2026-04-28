import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ChannelGroupRecord, ChannelPlatform } from '../../../shared/yachiyo/protocol.ts'
import { routeChannelGroupMessage, type ChannelGroupStorage } from './channelGroupRouting.ts'

function createMockStorage(groups: ChannelGroupRecord[] = []): ChannelGroupStorage {
  const store = new Map(
    groups.map((group) => [`${group.platform}:${group.externalGroupId}`, group])
  )
  return {
    findChannelGroup(platform, externalGroupId) {
      return store.get(`${platform}:${externalGroupId}`)
    },
    createChannelGroup(group) {
      const record: ChannelGroupRecord = {
        ...group,
        createdAt: '2026-04-28T00:00:00.000Z'
      }
      store.set(`${record.platform}:${record.externalGroupId}`, record)
      return record
    }
  }
}

function createGroup(
  platform: ChannelPlatform,
  status: ChannelGroupRecord['status']
): ChannelGroupRecord {
  return {
    id: `${platform}-group-1`,
    platform,
    externalGroupId: 'group-1',
    name: 'Group One',
    label: '',
    status,
    workspacePath: `/tmp/${platform}-group-1`,
    createdAt: '2026-04-28T00:00:00.000Z'
  }
}

describe('routeChannelGroupMessage', () => {
  it('registers unknown groups as pending with the platform workspace profile', () => {
    const storage = createMockStorage()

    const result = routeChannelGroupMessage(
      {
        platform: 'discord',
        externalGroupId: '123',
        name: 'Guild#general'
      },
      storage
    )

    assert.equal(result.kind, 'blocked')

    const created = storage.findChannelGroup('discord', '123')
    assert.ok(created)
    assert.equal(created.id, 'dc-group-123')
    assert.equal(created.status, 'pending')
    assert.equal(created.workspacePath.endsWith('/dc-group-123'), true)
  })

  it('blocks pending and blocked groups from the shared approval gate', () => {
    const pending = routeChannelGroupMessage(
      { platform: 'telegram', externalGroupId: 'group-1', name: 'Group One' },
      createMockStorage([createGroup('telegram', 'pending')])
    )
    const blocked = routeChannelGroupMessage(
      { platform: 'telegram', externalGroupId: 'group-1', name: 'Group One' },
      createMockStorage([createGroup('telegram', 'blocked')])
    )

    assert.equal(pending.kind, 'blocked')
    assert.equal(blocked.kind, 'blocked')
  })

  it('returns approved groups for monitor routing', () => {
    const group = createGroup('qq', 'approved')

    const result = routeChannelGroupMessage(
      { platform: 'qq', externalGroupId: 'group-1', name: 'Group One' },
      createMockStorage([group])
    )

    assert.deepEqual(result, { kind: 'approved', group })
  })
})
