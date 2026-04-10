import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  ChannelsConfig,
  GroupChannelConfig,
  ProviderConfig,
  ThreadModelOverride,
  UpdateChannelGroupInput,
  UpdateChannelUserInput
} from '../../../shared/yachiyo/protocol.ts'

export function hasPendingChannelUserChanges(
  savedUsers: ChannelUserRecord[],
  draftUsers: ChannelUserRecord[]
): boolean {
  return JSON.stringify(savedUsers) !== JSON.stringify(draftUsers)
}

export function hasPendingChannelGroupChanges(
  savedGroups: ChannelGroupRecord[],
  draftGroups: ChannelGroupRecord[]
): boolean {
  return JSON.stringify(savedGroups) !== JSON.stringify(draftGroups)
}

function sanitizeModelOverride(
  modelOverride: ThreadModelOverride | undefined,
  providerNames: Set<string>
): ThreadModelOverride | undefined {
  if (!modelOverride) {
    return undefined
  }

  return providerNames.has(modelOverride.providerName) ? modelOverride : undefined
}

function sanitizeGroupConfig(
  group: GroupChannelConfig | undefined,
  providerNames: Set<string>
): GroupChannelConfig | undefined {
  if (!group) {
    return undefined
  }

  return {
    ...group,
    model: sanitizeModelOverride(group.model, providerNames)
  }
}

export function sanitizeChannelsConfig(
  config: ChannelsConfig,
  providers: ProviderConfig[]
): ChannelsConfig {
  const providerNames = new Set(
    providers.map((provider) => provider.name).filter((name) => name.trim().length > 0)
  )
  const sanitizedConfig: ChannelsConfig = { ...config }

  if (config.telegram) {
    sanitizedConfig.telegram = {
      ...config.telegram,
      model: sanitizeModelOverride(config.telegram.model, providerNames),
      group: sanitizeGroupConfig(config.telegram.group, providerNames)
    }
  }

  if (config.qq) {
    sanitizedConfig.qq = {
      ...config.qq,
      model: sanitizeModelOverride(config.qq.model, providerNames),
      group: sanitizeGroupConfig(config.qq.group, providerNames)
    }
  }

  if (config.discord) {
    sanitizedConfig.discord = {
      ...config.discord,
      model: sanitizeModelOverride(config.discord.model, providerNames),
      group: sanitizeGroupConfig(config.discord.group, providerNames)
    }
  }

  if (config.qqbot) {
    sanitizedConfig.qqbot = {
      ...config.qqbot,
      model: sanitizeModelOverride(config.qqbot.model, providerNames)
    }
  }

  if (config.imageToText) {
    sanitizedConfig.imageToText = {
      ...config.imageToText,
      model: sanitizeModelOverride(config.imageToText.model, providerNames)
    }
  }

  return sanitizedConfig
}

function buildUserPatch(
  savedUser: ChannelUserRecord,
  draftUser: ChannelUserRecord
): UpdateChannelUserInput | null {
  const patch: UpdateChannelUserInput = { id: draftUser.id }

  if (savedUser.status !== draftUser.status) {
    patch.status = draftUser.status
  }
  if (savedUser.role !== draftUser.role) {
    patch.role = draftUser.role
  }
  if (savedUser.label !== draftUser.label) {
    patch.label = draftUser.label
  }
  if (savedUser.usageLimitKTokens !== draftUser.usageLimitKTokens) {
    patch.usageLimitKTokens = draftUser.usageLimitKTokens
  }

  return Object.keys(patch).length > 1 ? patch : null
}

function buildGroupPatch(
  savedGroup: ChannelGroupRecord,
  draftGroup: ChannelGroupRecord
): UpdateChannelGroupInput | null {
  const patch: UpdateChannelGroupInput = { id: draftGroup.id }

  if (savedGroup.status !== draftGroup.status) {
    patch.status = draftGroup.status
  }
  if (savedGroup.label !== draftGroup.label) {
    patch.label = draftGroup.label
  }

  return Object.keys(patch).length > 1 ? patch : null
}

export async function persistChannelUserDrafts(
  savedUsers: ChannelUserRecord[],
  draftUsers: ChannelUserRecord[]
): Promise<ChannelUserRecord[]> {
  const savedUsersById = new Map(savedUsers.map((user) => [user.id, user]))

  for (const draftUser of draftUsers) {
    const savedUser = savedUsersById.get(draftUser.id)
    if (!savedUser) {
      continue
    }

    const patch = buildUserPatch(savedUser, draftUser)
    if (patch) {
      await window.api.yachiyo.updateChannelUser(patch)
    }
  }

  return window.api.yachiyo.listChannelUsers()
}

export async function persistChannelGroupDrafts(
  savedGroups: ChannelGroupRecord[],
  draftGroups: ChannelGroupRecord[]
): Promise<ChannelGroupRecord[]> {
  const savedGroupsById = new Map(savedGroups.map((group) => [group.id, group]))

  for (const draftGroup of draftGroups) {
    const savedGroup = savedGroupsById.get(draftGroup.id)
    if (!savedGroup) {
      continue
    }

    const patch = buildGroupPatch(savedGroup, draftGroup)
    if (patch) {
      await window.api.yachiyo.updateChannelGroup(patch)
    }
  }

  return window.api.yachiyo.listChannelGroups()
}
