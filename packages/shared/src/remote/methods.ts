import { z } from 'zod'

import { REMOTE_PROTOCOL_VERSION } from './protocolVersion.ts'
import {
  activeRunEnterBehaviorSchema,
  hexIdSchema,
  idSchema,
  modelOverrideSchema,
  reasoningSelectionSchema,
  runModeSchema
} from './common.ts'
import {
  remoteAppearanceSchema,
  remoteEssentialSchema,
  remoteMessageSchema,
  remoteSearchResultSchema,
  remoteSelectableModelSchema,
  remoteTaskSchema,
  remoteThreadDetailSchema,
  remoteThreadSummarySchema,
  remoteWorkspaceSchema
} from './projections.ts'

/** Upload limits mirror the desktop composer (`attachmentFileTypes.ts`). */
export const REMOTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
export const REMOTE_ATTACHMENT_CHUNK_BYTES = 512 * 1024
export const REMOTE_MAX_IMAGES_PER_MESSAGE = 4
export const REMOTE_MAX_FILES_PER_MESSAGE = 10
/** Decrypted WebSocket message cap. */
export const REMOTE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
export const REMOTE_MAX_CONTENT_CHARS = 200_000
export const REMOTE_THREAD_PAGE_DEFAULT = 50

const contentSchema = z.string().max(REMOTE_MAX_CONTENT_CHARS)
const attachmentIdsSchema = z
  .array(idSchema)
  .max(REMOTE_MAX_IMAGES_PER_MESSAGE + REMOTE_MAX_FILES_PER_MESSAGE)
const okSchema = z.object({ ok: z.literal(true) }).meta({ id: 'RemoteOk' })

export const remoteChatAcceptedSchema = z
  .object({
    kind: z.enum(['run-started', 'active-run-follow-up', 'active-run-steer-pending']),
    threadId: idSchema,
    runId: idSchema,
    userMessage: remoteMessageSchema.optional()
  })
  .meta({ id: 'RemoteChatAccepted' })

export type RemoteChatAccepted = z.infer<typeof remoteChatAcceptedSchema>

export const helloInputSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    client: z.object({ app: z.string().min(1).max(100), version: z.string().min(1).max(50) })
  })
  .meta({ id: 'RemoteHelloInput' })

export const helloOutputSchema = z
  .object({
    protocolVersion: z.literal(REMOTE_PROTOCOL_VERSION),
    remoteDeviceId: hexIdSchema,
    syncDeviceId: z.string().optional(),
    deviceName: z.string(),
    appVersion: z.string(),
    epoch: z.string().min(1),
    activeRunEnterBehavior: activeRunEnterBehaviorSchema
  })
  .meta({ id: 'RemoteHelloOutput' })

/**
 * Every method the phone may call. Inputs are validated on the desktop; anything not listed
 * here (settings, providers, channels, memory, sync, deletion) is unreachable by design.
 */
export const remoteMethods = {
  'remote.hello': { input: helloInputSchema, output: helloOutputSchema },
  'threads.list': {
    input: z.object({
      cursor: z.string().max(200).optional(),
      limit: z.int().min(1).max(200).optional()
    }),
    output: z.object({
      threads: z.array(remoteThreadSummarySchema),
      nextCursor: z.string().optional()
    })
  },
  'threads.load': {
    input: z.object({
      threadId: idSchema,
      limit: z.int().min(1).max(200).optional(),
      beforeMessageId: idSchema.optional()
    }),
    output: remoteThreadDetailSchema
  },
  'threads.create': {
    input: z.object({
      workspacePath: z.string().max(4096).optional(),
      modelOverride: modelOverrideSchema.optional(),
      reasoningEffort: reasoningSelectionSchema.optional()
    }),
    output: z.object({ thread: remoteThreadSummarySchema })
  },
  'threads.search': {
    input: z.object({
      query: z.string().trim().min(1).max(500),
      scope: z.enum(['active', 'archived']).optional()
    }),
    output: z.object({ results: z.array(remoteSearchResultSchema) })
  },
  'threads.star': {
    input: z.object({ threadId: idSchema, starred: z.boolean() }),
    output: okSchema
  },
  'threads.archive': {
    input: z.object({ threadId: idSchema }),
    output: okSchema
  },
  'workspaces.listRecent': {
    input: z.object({}),
    output: z.object({ workspaces: z.array(remoteWorkspaceSchema) })
  },
  'models.listSelectable': {
    input: z.object({}),
    output: z.object({ models: z.array(remoteSelectableModelSchema) })
  },
  'chat.send': {
    input: z.object({
      threadId: idSchema,
      content: contentSchema,
      attachmentIds: attachmentIdsSchema.optional(),
      mode: z.enum(['normal', 'steer', 'follow-up']).optional(),
      reasoningEffort: reasoningSelectionSchema.optional()
    }),
    output: remoteChatAcceptedSchema
  },
  'chat.startThread': {
    input: z.object({
      essentialId: idSchema.optional(),
      workspacePath: z.string().max(4096).optional(),
      modelOverride: modelOverrideSchema.optional(),
      reasoningEffort: reasoningSelectionSchema.optional(),
      runMode: runModeSchema.optional(),
      privacyMode: z.boolean().optional(),
      content: contentSchema,
      attachmentIds: attachmentIdsSchema.optional()
    }),
    output: z.object({ thread: remoteThreadSummarySchema, accepted: remoteChatAcceptedSchema })
  },
  'chat.retry': {
    input: z.object({ threadId: idSchema, messageId: idSchema }),
    output: z.object({ threadId: idSchema, runId: idSchema })
  },
  'chat.edit': {
    input: z.object({
      threadId: idSchema,
      messageId: idSchema,
      content: contentSchema,
      attachmentIds: attachmentIdsSchema.optional()
    }),
    output: remoteChatAcceptedSchema
  },
  'chat.withdrawSteer': {
    input: z.object({ threadId: idSchema }),
    output: okSchema
  },
  'chat.removeFollowUp': {
    input: z.object({ threadId: idSchema, messageId: idSchema }),
    output: okSchema
  },
  'branch.select': {
    input: z.object({ threadId: idSchema, assistantMessageId: idSchema }),
    output: okSchema
  },
  'branch.create': {
    input: z.object({ threadId: idSchema, messageId: idSchema }),
    output: z.object({ thread: remoteThreadSummarySchema })
  },
  'run.cancel': {
    input: z.object({ runId: idSchema }),
    output: okSchema
  },
  'run.answerToolQuestion': {
    input: z.object({
      threadId: idSchema,
      runId: idSchema,
      toolCallId: idSchema,
      answer: z.string().min(1).max(20_000)
    }),
    output: okSchema
  },
  'plan.read': {
    input: z.object({ threadId: idSchema }),
    output: z.object({
      content: z.string(),
      decision: z.enum(['pending', 'rejected', 'accepted']).optional()
    })
  },
  'plan.accept': {
    input: z.object({ threadId: idSchema, mode: z.enum(['direct', 'handoff']).optional() }),
    output: remoteChatAcceptedSchema
  },
  'attachments.begin': {
    input: z.object({
      filename: z.string().min(1).max(255),
      mediaType: z.string().min(1).max(255),
      size: z.int().min(1).max(REMOTE_ATTACHMENT_MAX_BYTES)
    }),
    output: z.object({ uploadId: idSchema, chunkSize: z.int() })
  },
  'attachments.chunk': {
    input: z.object({
      uploadId: idSchema,
      index: z.int().min(0),
      data: z
        .string()
        .max(Math.ceil(REMOTE_ATTACHMENT_CHUNK_BYTES / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    }),
    output: z.object({ received: z.int() })
  },
  'attachments.commit': {
    input: z.object({ uploadId: idSchema, sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    output: z.object({ attachmentId: idSchema, kind: z.enum(['image', 'file']) })
  },
  'images.get': {
    input: z.object({ threadId: idSchema, messageId: idSchema, imageId: idSchema }),
    output: z.object({ mediaType: z.string(), data: z.string() })
  },
  'files.get': {
    input: z.object({ threadId: idSchema, path: z.string().min(1).max(8192) }),
    output: z.object({ filename: z.string(), mediaType: z.string(), data: z.string() })
  },
  'essentials.list': {
    input: z.object({}),
    output: z.object({ essentials: z.array(remoteEssentialSchema) })
  },
  'essentials.getIcon': {
    input: z.object({ essentialId: idSchema }),
    output: z.object({ mediaType: z.string(), data: z.string() })
  },
  'appearance.get': {
    input: z.object({}),
    output: remoteAppearanceSchema
  },
  'tasks.list': {
    input: z.object({ threadId: idSchema }),
    output: z.object({ tasks: z.array(remoteTaskSchema) })
  },
  'events.subscribe': {
    input: z.object({
      threadIds: z.array(idSchema).max(32),
      resumeFrom: z.object({ epoch: z.string().min(1).max(100), seq: z.int().min(0) }).optional()
    }),
    output: z.object({
      epoch: z.string(),
      headSeq: z.int().min(0),
      resumed: z.boolean()
    })
  }
} as const

export type RemoteMethodName = keyof typeof remoteMethods
export type RemoteMethodInput<M extends RemoteMethodName> = z.infer<
  (typeof remoteMethods)[M]['input']
>
export type RemoteMethodOutput<M extends RemoteMethodName> = z.infer<
  (typeof remoteMethods)[M]['output']
>

export const REMOTE_METHOD_NAMES = Object.keys(remoteMethods) as RemoteMethodName[]

/** Methods that change desktop state; each call is written to the audit log. */
export const REMOTE_MUTATING_METHODS: ReadonlySet<RemoteMethodName> = new Set<RemoteMethodName>([
  'threads.create',
  'threads.star',
  'threads.archive',
  'chat.send',
  'chat.startThread',
  'chat.retry',
  'chat.edit',
  'chat.withdrawSteer',
  'chat.removeFollowUp',
  'branch.select',
  'branch.create',
  'run.cancel',
  'run.answerToolQuestion',
  'plan.accept',
  'attachments.commit'
])

export function isRemoteMethodName(value: string): value is RemoteMethodName {
  return Object.hasOwn(remoteMethods, value)
}
