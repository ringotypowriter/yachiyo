import { sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

import type { MessageRecord, RunRecord, ToolCallRecord } from '../../../../shared/yachiyo/protocol'

export const threadsTable = sqliteTable('threads', {
  id: text('id').primaryKey(),
  icon: text('icon'),
  title: text('title').notNull(),
  memoryRecallState: text('memory_recall_state'),
  workspacePath: text('workspace_path'),
  preview: text('preview'),
  branchFromThreadId: text('branch_from_thread_id'),
  branchFromMessageId: text('branch_from_message_id'),
  headMessageId: text('head_message_id'),
  queuedFollowUpMessageId: text('queued_follow_up_message_id'),
  queuedFollowUpEnabledTools: text('queued_follow_up_enabled_tools'),
  queuedFollowUpEnabledSkillNames: text('queued_follow_up_enabled_skill_names'),
  archivedAt: text('archived_at'),
  starredAt: text('starred_at'),
  privacyMode: text('privacy_mode'),
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
  reasoning: text('reasoning'),
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
  completedAt: text('completed_at')
})

export const toolCallsTable = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => runsTable.id, { onDelete: 'cascade' }),
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
  finishedAt: text('finished_at')
})
