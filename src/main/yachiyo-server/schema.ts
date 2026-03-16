import { sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'

import type { MessageRecord } from '../../shared/yachiyo/protocol'

export const threadsTable = sqliteTable('threads', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  preview: text('preview'),
  branchFromThreadId: text('branch_from_thread_id'),
  branchFromMessageId: text('branch_from_message_id'),
  headMessageId: text('head_message_id'),
  archivedAt: text('archived_at'),
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
  images: text('images'),
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
  status: text('status').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at')
})
