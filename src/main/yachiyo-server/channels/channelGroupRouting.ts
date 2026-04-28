import { join } from 'node:path'

import type { ChannelGroupRecord, ChannelPlatform } from '../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoTempWorkspaceRoot } from '../config/paths.ts'

export interface ChannelGroupInbound {
  platform: ChannelPlatform
  externalGroupId: string
  name: string
}

export type ChannelGroupRouteResult =
  | { kind: 'approved'; group: ChannelGroupRecord }
  | { kind: 'blocked' }

export interface ChannelGroupStorage {
  findChannelGroup(
    platform: ChannelPlatform,
    externalGroupId: string
  ): ChannelGroupRecord | undefined
  createChannelGroup(group: Omit<ChannelGroupRecord, 'createdAt'>): ChannelGroupRecord
}

interface ChannelGroupRouteProfile {
  id(externalGroupId: string): string
  workspacePath(externalGroupId: string): string
}

function tempWorkspace(name: string): string {
  return join(resolveYachiyoTempWorkspaceRoot(), name)
}

const channelGroupProfiles: Record<ChannelPlatform, ChannelGroupRouteProfile> = {
  telegram: {
    id: (externalGroupId) => `tg-group-${externalGroupId}`,
    workspacePath: (externalGroupId) => tempWorkspace(`tg-group-${externalGroupId}`)
  },
  discord: {
    id: (externalGroupId) => `dc-group-${externalGroupId}`,
    workspacePath: (externalGroupId) => tempWorkspace(`dc-group-${externalGroupId}`)
  },
  qq: {
    id: (externalGroupId) => `qq-group-${externalGroupId}`,
    workspacePath: (externalGroupId) => tempWorkspace(`qq-group-${externalGroupId}`)
  },
  qqbot: {
    id: (externalGroupId) => `qqbot-group-${externalGroupId}`,
    workspacePath: (externalGroupId) => tempWorkspace(`qqbot-group-${externalGroupId}`)
  }
}

export function routeChannelGroupMessage(
  input: ChannelGroupInbound,
  storage: ChannelGroupStorage
): ChannelGroupRouteResult {
  let group = storage.findChannelGroup(input.platform, input.externalGroupId)

  if (!group) {
    const profile = channelGroupProfiles[input.platform]
    group = storage.createChannelGroup({
      id: profile.id(input.externalGroupId),
      platform: input.platform,
      externalGroupId: input.externalGroupId,
      name: input.name,
      label: '',
      status: 'pending',
      workspacePath: profile.workspacePath(input.externalGroupId)
    })
    console.log(
      `[${input.platform}-group] new group ${input.externalGroupId} registered as pending`
    )
    return { kind: 'blocked' }
  }

  if (group.status !== 'approved') {
    return { kind: 'blocked' }
  }

  return { kind: 'approved', group }
}
