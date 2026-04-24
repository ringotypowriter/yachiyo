import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ChannelsConfig,
  ProviderConfig,
  UpdateChannelGroupInput,
  UpdateChannelUserInput
} from '../../../shared/yachiyo/protocol.ts'
import {
  hasPendingChannelGroupChanges,
  hasPendingChannelUserChanges,
  persistChannelGroupDrafts,
  persistChannelUserDrafts,
  sanitizeChannelsConfig
} from './channelsPaneModel.ts'

type CallRecord = string | UpdateChannelUserInput | UpdateChannelGroupInput

function withWindowApiMock(mock: Partial<Window['api']['yachiyo']>): () => void {
  const globalScope = globalThis as typeof globalThis & {
    window?: {
      api: {
        yachiyo: Partial<Window['api']['yachiyo']>
      }
    }
  }
  const originalWindow = globalScope.window

  Object.defineProperty(globalScope, 'window', {
    value: {
      api: {
        yachiyo: mock
      }
    },
    configurable: true,
    writable: true
  })

  return () => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalScope, 'window')
      return
    }

    Object.defineProperty(globalScope, 'window', {
      value: originalWindow,
      configurable: true,
      writable: true
    })
  }
}

test('persistChannelUserDrafts saves only changed editable user fields and reloads users', async () => {
  const calls: CallRecord[] = []
  const restore = withWindowApiMock({
    updateChannelUser: async (input) => {
      calls.push(input)
      return {
        id: 'u1',
        platform: 'telegram',
        externalUserId: '1',
        username: 'leader',
        label: 'Leader',
        status: 'allowed',
        role: 'owner',
        usageLimitKTokens: 64,
        usedKTokens: 12,
        workspacePath: '/tmp/ws'
      }
    },
    listChannelUsers: async () => {
      calls.push('reload-users')
      return [
        {
          id: 'u1',
          platform: 'telegram',
          externalUserId: '1',
          username: 'leader',
          label: 'Leader',
          status: 'allowed',
          role: 'owner',
          usageLimitKTokens: 64,
          usedKTokens: 12,
          workspacePath: '/tmp/ws'
        }
      ]
    }
  })

  try {
    const savedUsers = [
      {
        id: 'u1',
        platform: 'telegram' as const,
        externalUserId: '1',
        username: 'leader',
        label: '',
        status: 'pending' as const,
        role: 'guest' as const,
        usageLimitKTokens: null,
        usedKTokens: 12,
        workspacePath: '/tmp/ws'
      }
    ]
    const draftUsers = [
      {
        ...savedUsers[0],
        label: 'Leader',
        status: 'allowed' as const,
        role: 'owner' as const,
        usageLimitKTokens: 64
      }
    ]

    assert.deepEqual(await persistChannelUserDrafts(savedUsers, draftUsers), [
      {
        id: 'u1',
        platform: 'telegram',
        externalUserId: '1',
        username: 'leader',
        label: 'Leader',
        status: 'allowed',
        role: 'owner',
        usageLimitKTokens: 64,
        usedKTokens: 12,
        workspacePath: '/tmp/ws'
      }
    ])
    assert.deepEqual(calls, [
      {
        id: 'u1',
        label: 'Leader',
        role: 'owner',
        status: 'allowed',
        usageLimitKTokens: 64
      },
      'reload-users'
    ])
  } finally {
    restore()
  }
})

test('persistChannelGroupDrafts saves only changed editable group fields and reloads groups', async () => {
  const calls: CallRecord[] = []
  const restore = withWindowApiMock({
    updateChannelGroup: async (input) => {
      calls.push(input)
      return {
        id: 'g1',
        platform: 'discord',
        externalGroupId: '42',
        name: 'Ops',
        label: 'Ops Room',
        status: 'approved',
        workspacePath: '/tmp/ws',
        createdAt: '2026-04-10T10:00:00.000Z'
      }
    },
    listChannelGroups: async () => {
      calls.push('reload-groups')
      return [
        {
          id: 'g1',
          platform: 'discord',
          externalGroupId: '42',
          name: 'Ops',
          label: 'Ops Room',
          status: 'approved',
          workspacePath: '/tmp/ws',
          createdAt: '2026-04-10T10:00:00.000Z'
        }
      ]
    }
  })

  try {
    const savedGroups = [
      {
        id: 'g1',
        platform: 'discord' as const,
        externalGroupId: '42',
        name: 'Ops',
        label: '',
        status: 'pending' as const,
        workspacePath: '/tmp/ws',
        createdAt: '2026-04-10T10:00:00.000Z'
      }
    ]
    const draftGroups = [
      {
        ...savedGroups[0],
        label: 'Ops Room',
        status: 'approved' as const
      }
    ]

    assert.deepEqual(await persistChannelGroupDrafts(savedGroups, draftGroups), [
      {
        id: 'g1',
        platform: 'discord',
        externalGroupId: '42',
        name: 'Ops',
        label: 'Ops Room',
        status: 'approved',
        workspacePath: '/tmp/ws',
        createdAt: '2026-04-10T10:00:00.000Z'
      }
    ])
    assert.deepEqual(calls, [
      {
        id: 'g1',
        label: 'Ops Room',
        status: 'approved'
      },
      'reload-groups'
    ])
  } finally {
    restore()
  }
})

test('pending channel change helpers track unsaved draft state', () => {
  const savedUsers = [
    {
      id: 'u1',
      platform: 'telegram' as const,
      externalUserId: '1',
      username: 'leader',
      label: '',
      status: 'pending' as const,
      role: 'guest' as const,
      usageLimitKTokens: null,
      usedKTokens: 0,
      workspacePath: '/tmp/ws'
    }
  ]
  const savedGroups = [
    {
      id: 'g1',
      platform: 'discord' as const,
      externalGroupId: '42',
      name: 'Ops',
      label: '',
      status: 'pending' as const,
      workspacePath: '/tmp/ws',
      createdAt: '2026-04-10T10:00:00.000Z'
    }
  ]

  assert.equal(hasPendingChannelUserChanges(savedUsers, savedUsers), false)
  assert.equal(
    hasPendingChannelUserChanges(savedUsers, [{ ...savedUsers[0], status: 'allowed' }]),
    true
  )
  assert.equal(hasPendingChannelGroupChanges(savedGroups, savedGroups), false)
  assert.equal(
    hasPendingChannelGroupChanges(savedGroups, [{ ...savedGroups[0], label: 'Ops Room' }]),
    true
  )
})

test('sanitizeChannelsConfig drops overrides that reference unsaved provider names', () => {
  const providers: ProviderConfig[] = [
    {
      id: 'saved-work',
      name: 'work',
      type: 'openai',
      apiKey: 'secret',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    }
  ]
  const config: ChannelsConfig = {
    telegram: {
      enabled: true,
      botToken: 'token',
      model: { providerName: 'draft-only', model: 'gpt-5' },
      group: {
        enabled: true,
        model: { providerName: 'work', model: 'gpt-5' }
      }
    },
    qqbot: {
      enabled: true,
      appId: 'app',
      clientSecret: 'secret',
      model: { providerName: 'renamed-provider', model: 'gpt-5' }
    },
    imageToText: {
      enabled: true
    }
  }

  assert.deepEqual(sanitizeChannelsConfig(config, providers), {
    telegram: {
      enabled: true,
      botToken: 'token',
      model: undefined,
      group: {
        enabled: true,
        model: { providerName: 'work', model: 'gpt-5' }
      }
    },
    qqbot: {
      enabled: true,
      appId: 'app',
      clientSecret: 'secret',
      model: undefined
    },
    imageToText: {
      enabled: true
    }
  })
})

test('sanitizeChannelsConfig preserves overrides for whitespace-padded provider names', () => {
  const providers: ProviderConfig[] = [
    {
      id: 'padded',
      name: ' work ',
      type: 'openai',
      apiKey: 'secret',
      baseUrl: 'https://api.openai.com/v1',
      modelList: { enabled: ['gpt-5'], disabled: [] }
    }
  ]
  const config: ChannelsConfig = {
    telegram: {
      enabled: true,
      botToken: 'token',
      model: { providerName: ' work ', model: 'gpt-5' }
    }
  }

  // The override should be kept — the provider name matches verbatim
  const result = sanitizeChannelsConfig(config, providers)
  assert.deepEqual(result.telegram?.model, { providerName: ' work ', model: 'gpt-5' })
})
