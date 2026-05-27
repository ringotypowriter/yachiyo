import type {
  ChannelGroupRecord,
  ChannelUserRecord,
  ChannelUserRole
} from '@yachiyo/shared/protocol'
import { channelGroupsTable, channelUsersTable } from './schema.ts'

export function toChannelUserRecord(row: typeof channelUsersTable.$inferSelect): ChannelUserRecord {
  return {
    id: row.id,
    platform: row.platform as ChannelUserRecord['platform'],
    externalUserId: row.externalUserId,
    username: row.username,
    label: row.label,
    status: row.status,
    role: (row.role ?? 'guest') as ChannelUserRole,
    usageLimitKTokens: row.usageLimitKTokens,
    usedKTokens: row.usedKTokens,
    workspacePath: row.workspacePath
  }
}

export function toChannelGroupRecord(
  row: typeof channelGroupsTable.$inferSelect
): ChannelGroupRecord {
  return {
    id: row.id,
    platform: row.platform as ChannelGroupRecord['platform'],
    externalGroupId: row.externalGroupId,
    name: row.name,
    label: row.label,
    status: row.status,
    workspacePath: row.workspacePath,
    createdAt: row.createdAt
  }
}
