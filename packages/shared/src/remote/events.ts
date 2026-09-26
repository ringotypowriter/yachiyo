import { z } from 'zod'

import { idSchema, isoDateTimeSchema } from './common.ts'
import {
  remoteAppearanceSchema,
  remoteMessageSchema,
  remoteRunStatusSchema,
  remoteThreadSummarySchema,
  remoteTodoItemSchema,
  remoteToolCallSchema
} from './projections.ts'

/**
 * Inbox-scope events reach every connection; thread-scope events only reach connections
 * whose `events.subscribe` call listed the thread.
 */
export const REMOTE_INBOX_EVENT_TYPES = [
  'thread.summary',
  'thread.removed',
  'run.status',
  'appearance.changed'
] as const

export const remoteEventSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('thread.summary'),
      threadId: idSchema,
      summary: remoteThreadSummarySchema
    }),
    z.object({
      type: z.literal('thread.removed'),
      threadId: idSchema,
      reason: z.enum(['archived', 'deleted'])
    }),
    z.object({
      type: z.literal('run.status'),
      threadId: idSchema,
      runId: idSchema,
      status: remoteRunStatusSchema,
      error: z.string().optional()
    }),
    z.object({
      type: z.literal('appearance.changed'),
      appearance: remoteAppearanceSchema
    }),
    z.object({
      type: z.literal('thread.invalidated'),
      threadId: idSchema
    }),
    z.object({
      type: z.literal('message.started'),
      threadId: idSchema,
      runId: idSchema,
      messageId: idSchema,
      parentMessageId: idSchema.optional()
    }),
    z.object({
      type: z.literal('message.delta'),
      threadId: idSchema,
      runId: idSchema,
      messageId: idSchema,
      delta: z.string()
    }),
    z.object({
      type: z.literal('message.reasoning.delta'),
      threadId: idSchema,
      runId: idSchema,
      messageId: idSchema,
      delta: z.string()
    }),
    z.object({
      type: z.literal('message.completed'),
      threadId: idSchema,
      runId: idSchema,
      message: remoteMessageSchema,
      queuedFollowUps: z.array(remoteMessageSchema).optional()
    }),
    z.object({
      type: z.literal('tool.updated'),
      threadId: idSchema,
      runId: idSchema.optional(),
      toolCall: remoteToolCallSchema
    }),
    z.object({
      type: z.literal('todo.updated'),
      threadId: idSchema,
      items: z.array(remoteTodoItemSchema)
    }),
    z.object({
      type: z.literal('run.retrying'),
      threadId: idSchema,
      runId: idSchema,
      attempt: z.int(),
      maxAttempts: z.int(),
      error: z.string()
    }),
    z.object({
      type: z.literal('tasks.changed'),
      threadId: idSchema
    })
  ])
  .meta({ id: 'RemoteEvent' })

export type RemoteEvent = z.infer<typeof remoteEventSchema>
export type RemoteEventType = RemoteEvent['type']

export const remotePushBatchItemSchema = z
  .object({ seq: z.int().min(1), event: remoteEventSchema })
  .meta({ id: 'RemotePushBatchItem' })

/** Server-pushed payloads, delivered as `rpc:event` messages. */
export const remotePushSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('event'),
      epoch: z.string().min(1),
      seq: z.int().min(1),
      timestamp: isoDateTimeSchema,
      event: remoteEventSchema
    }),
    /**
     * One hub flush, sent only when the `event-batch` feature was negotiated. Items keep
     * ascending seqs; each applies exactly like an `event` push with the batch epoch/timestamp.
     */
    z.object({
      type: z.literal('batch'),
      epoch: z.string().min(1),
      timestamp: isoDateTimeSchema,
      items: z.array(remotePushBatchItemSchema).min(1)
    }),
    z.object({
      type: z.literal('resync'),
      epoch: z.string().min(1),
      seq: z.int().min(0),
      reason: z.enum(['epoch-changed', 'out-of-buffer', 'overflow'])
    })
  ])
  .meta({ id: 'RemotePush' })

export type RemotePush = z.infer<typeof remotePushSchema>

export function isRemoteInboxEvent(event: RemoteEvent): boolean {
  return (REMOTE_INBOX_EVENT_TYPES as readonly string[]).includes(event.type)
}
