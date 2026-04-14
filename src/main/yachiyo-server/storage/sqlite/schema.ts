import { integer, real, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

import type {
  ChannelGroupStatus,
  ChannelUserRole,
  ChannelUserStatus,
  FolderColorTag,
  MessageRecord,
  RunRecord,
  ScheduleResultStatus,
  ScheduleRunStatus,
  ToolCallRecord
} from '../../../../shared/yachiyo/protocol'

export const channelUsersTable = sqliteTable('channel_users', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  externalUserId: text('external_user_id').notNull(),
  username: text('username').notNull(),
  label: text('label').notNull().default(''),
  status: text('status').$type<ChannelUserStatus>().notNull().default('pending'),
  role: text('role').$type<ChannelUserRole>().notNull().default('guest'),
  usageLimitKTokens: integer('usage_limit_k_tokens'),
  usedKTokens: integer('used_k_tokens').notNull().default(0),
  workspacePath: text('workspace_path').notNull()
})

export const channelGroupsTable = sqliteTable('channel_groups', {
  id: text('id').primaryKey(),
  platform: text('platform').notNull(),
  externalGroupId: text('external_group_id').notNull(),
  name: text('name').notNull(),
  label: text('label').notNull().default(''),
  status: text('status').$type<ChannelGroupStatus>().notNull().default('pending'),
  workspacePath: text('workspace_path').notNull(),
  createdAt: text('created_at').notNull()
})

export const threadFoldersTable = sqliteTable('thread_folders', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  colorTag: text('color_tag').$type<FolderColorTag>(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const threadsTable = sqliteTable('threads', {
  id: text('id').primaryKey(),
  icon: text('icon'),
  title: text('title').notNull(),
  memoryRecallState: text('memory_recall_state'),
  workspacePath: text('workspace_path'),
  preview: text('preview'),
  branchFromThreadId: text('branch_from_thread_id'),
  branchFromMessageId: text('branch_from_message_id'),
  handoffFromThreadId: text('handoff_from_thread_id'),
  folderId: text('folder_id').references(() => threadFoldersTable.id, { onDelete: 'set null' }),
  headMessageId: text('head_message_id'),
  queuedFollowUpMessageId: text('queued_follow_up_message_id'),
  queuedFollowUpEnabledTools: text('queued_follow_up_enabled_tools'),
  queuedFollowUpEnabledSkillNames: text('queued_follow_up_enabled_skill_names'),
  archivedAt: text('archived_at'),
  savingStartedAt: text('saving_started_at'),
  starredAt: text('starred_at'),
  privacyMode: text('privacy_mode'),
  modelOverride: text('model_override'),
  source: text('source').default('local'),
  channelUserId: text('channel_user_id').references(() => channelUsersTable.id),
  channelGroupId: text('channel_group_id').references(() => channelGroupsTable.id),
  rollingSummary: text('rolling_summary'),
  summaryWatermarkMessageId: text('summary_watermark_message_id'),
  readAt: text('read_at'),
  createdFromEssentialId: text('created_from_essential_id'),
  runtimeBinding: text('runtime_binding'),
  lastDelegatedSession: text('last_delegated_session'),
  selfReviewedAt: text('self_reviewed_at'),
  updatedAt: text('updated_at').notNull(),
  createdAt: text('created_at').notNull()
})

export const messagesTable = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threadsTable.id, { onDelete: 'cascade' }),
  parentMessageId: text('parent_message_id').references((): AnySQLiteColumn => messagesTable.id, {
    onDelete: 'cascade'
  }),
  role: text('role').$type<MessageRecord['role']>().notNull(),
  content: text('content').notNull(),
  textBlocks: text('text_blocks'),
  images: text('images'),
  attachments: text('attachments'),
  reasoning: text('reasoning'),
  responseMessages: text('response_messages'),
  turnContext: text('turn_context'),
  visibleReply: text('visible_reply'),
  senderName: text('sender_name'),
  senderExternalUserId: text('sender_external_user_id'),
  hidden: integer('hidden', { mode: 'boolean' }),
  status: text('status').$type<MessageRecord['status']>().notNull(),
  createdAt: text('created_at').notNull(),
  modelId: text('model_id'),
  providerName: text('provider_name')
})

export const runsTable = sqliteTable('runs', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threadsTable.id, { onDelete: 'cascade' }),
  requestMessageId: text('request_message_id').references(() => messagesTable.id, {
    onDelete: 'set null'
  }),
  assistantMessageId: text('assistant_message_id').references(() => messagesTable.id, {
    onDelete: 'set null'
  }),
  status: text('status').$type<RunRecord['status']>().notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  totalPromptTokens: integer('total_prompt_tokens'),
  totalCompletionTokens: integer('total_completion_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  modelId: text('model_id'),
  providerName: text('provider_name'),
  snapshotFileCount: integer('snapshot_file_count')
})

export const runRecoveryCheckpointsTable = sqliteTable('run_recovery_checkpoints', {
  runId: text('run_id')
    .primaryKey()
    .references(() => runsTable.id, { onDelete: 'cascade' }),
  threadId: text('thread_id')
    .notNull()
    .references(() => threadsTable.id, { onDelete: 'cascade' }),
  requestMessageId: text('request_message_id')
    .notNull()
    .references(() => messagesTable.id, {
      onDelete: 'cascade'
    }),
  assistantMessageId: text('assistant_message_id').notNull(),
  content: text('content').notNull(),
  textBlocks: text('text_blocks'),
  reasoning: text('reasoning'),
  responseMessages: text('response_messages'),
  enabledTools: text('enabled_tools').notNull(),
  enabledSkillNames: text('enabled_skill_names'),
  channelHint: text('channel_hint'),
  updateHeadOnComplete: text('update_head_on_complete').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  recoveryAttempts: integer('recovery_attempts').notNull().default(0),
  lastError: text('last_error')
})

export const toolCallsTable = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => runsTable.id),
  requestMessageId: text('request_message_id').references(() => messagesTable.id, {
    onDelete: 'set null'
  }),
  assistantMessageId: text('assistant_message_id').references(() => messagesTable.id, {
    onDelete: 'set null'
  }),
  threadId: text('thread_id')
    .notNull()
    .references(() => threadsTable.id, { onDelete: 'cascade' }),
  toolName: text('tool_name').$type<ToolCallRecord['toolName']>().notNull(),
  status: text('status').$type<ToolCallRecord['status']>().notNull(),
  inputSummary: text('input_summary').notNull(),
  outputSummary: text('output_summary'),
  cwd: text('cwd'),
  error: text('error'),
  details: text('details'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  stepIndex: integer('step_index'),
  stepBudget: integer('step_budget')
})

export const imageAltTextsTable = sqliteTable('image_alt_texts', {
  imageHash: text('image_hash').primaryKey(),
  altText: text('alt_text').notNull(),
  createdAt: text('created_at').notNull()
})

export const schedulesTable = sqliteTable('schedules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cronExpression: text('cron_expression'),
  runAt: text('run_at'),
  prompt: text('prompt').notNull(),
  workspacePath: text('workspace_path'),
  modelOverride: text('model_override'),
  enabledTools: text('enabled_tools'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})

export const scheduleRunsTable = sqliteTable('schedule_runs', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id')
    .notNull()
    .references(() => schedulesTable.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').references(() => threadsTable.id, { onDelete: 'set null' }),
  status: text('status').$type<ScheduleRunStatus>().notNull(),
  resultStatus: text('result_status').$type<ScheduleResultStatus>(),
  resultSummary: text('result_summary'),
  error: text('error'),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at')
})

export const groupMonitorBuffersTable = sqliteTable('group_monitor_buffers', {
  groupId: text('group_id')
    .primaryKey()
    .references(() => channelGroupsTable.id, { onDelete: 'cascade' }),
  phase: text('phase').notNull().default('dormant'),
  buffer: text('buffer').notNull(),
  savedAt: text('saved_at').notNull()
})

export const builtinMemoriesTable = sqliteTable('builtin_memories', {
  id: text('id').primaryKey(),
  topic: text('topic').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  labels: text('labels').notNull(),
  unitType: text('unit_type').notNull(),
  importance: real('importance'),
  sourceThreadId: text('source_thread_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull()
})
