import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { MessageRecord } from '../../shared/yachiyo/protocol'

export const threadsTable = sqliteTable('threads', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  preview: text('preview'),
  archivedAt: text('archived_at'),
  updatedAt: text('updated_at').notNull(),
  createdAt: text('created_at').notNull()
})

export const messagesTable = sqliteTable('messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id')
    .notNull()
    .references(() => threadsTable.id, { onDelete: 'cascade' }),
  role: text('role').$type<MessageRecord['role']>().notNull(),
  content: text('content').notNull(),
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
  status: text('status').notNull(),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at')
})
