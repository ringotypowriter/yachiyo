import { z } from 'zod'

import {
  idSchema,
  isoDateTimeSchema,
  modelOverrideSchema,
  reasoningSelectionSchema,
  runModeSchema,
  themeAppearanceSchema,
  themeIdSchema
} from './common.ts'

/** Tool input/output previews are cut to this many UTF-16 code units. */
export const REMOTE_TOOL_PREVIEW_LIMIT = 4096

/** Thread previews are cut to this many characters. */
export const REMOTE_THREAD_PREVIEW_LIMIT = 200

export const remoteRunStatusSchema = z
  .enum(['running', 'completed', 'failed', 'cancelled'])
  .meta({ id: 'RemoteRunStatus' })

export const remoteThreadCapabilitiesSchema = z
  .object({
    canRetry: z.boolean(),
    canCreateBranch: z.boolean(),
    canSelectReplyBranch: z.boolean(),
    canEdit: z.boolean(),
    canSend: z.boolean()
  })
  .meta({ id: 'RemoteThreadCapabilities' })

export const remoteThreadSummarySchema = z
  .object({
    id: idSchema,
    title: z.string(),
    icon: z.string().optional(),
    colorTag: z.enum(['coral', 'azure', 'emerald', 'amethyst', 'slate']).optional(),
    starred: z.boolean(),
    updatedAt: isoDateTimeSchema,
    workspaceName: z.string().optional(),
    workspacePath: z.string().optional(),
    latestRun: z
      .object({
        runId: idSchema,
        status: remoteRunStatusSchema,
        startedAt: isoDateTimeSchema
      })
      .optional(),
    needsAttention: z.boolean(),
    preview: z.string().max(REMOTE_THREAD_PREVIEW_LIMIT).optional(),
    capabilities: remoteThreadCapabilitiesSchema,
    syncOriginDeviceId: z.string().optional(),
    privacyMode: z.boolean().optional()
  })
  .meta({ id: 'RemoteThreadSummary' })

export type RemoteThreadSummary = z.infer<typeof remoteThreadSummarySchema>

export const remoteImageRefSchema = z
  .object({
    imageId: idSchema,
    mediaType: z.string(),
    filename: z.string().optional(),
    altText: z.string().optional()
  })
  .meta({ id: 'RemoteImageRef' })

export const remoteFileRefSchema = z
  .object({
    filename: z.string(),
    mediaType: z.string()
  })
  .meta({ id: 'RemoteFileRef' })

export const remoteMessageSchema = z
  .object({
    id: idSchema,
    parentMessageId: idSchema.optional(),
    role: z.enum(['user', 'assistant']),
    content: z.string(),
    reasoning: z.string().optional(),
    images: z.array(remoteImageRefSchema),
    attachments: z.array(remoteFileRefSchema),
    status: z.enum(['completed', 'streaming', 'failed', 'stopped']),
    createdAt: isoDateTimeSchema,
    modelId: z.string().optional(),
    providerName: z.string().optional(),
    /**
     * Messages sharing this message's parent, oldest first (this one included). Present on the
     * branch path returned by `threads.load`; absent in live events.
     */
    siblingIds: z.array(idSchema).optional(),
    isPlanDocument: z.boolean(),
    requestKind: z.enum(['steer', 'follow-up']).optional()
  })
  .meta({ id: 'RemoteMessage' })

export type RemoteMessage = z.infer<typeof remoteMessageSchema>

export const remoteToolQuestionSchema = z
  .object({
    question: z.string(),
    choices: z.array(z.string()).optional(),
    answer: z.string().optional()
  })
  .meta({ id: 'RemoteToolQuestion' })

export const remoteToolCallSchema = z
  .object({
    id: idSchema,
    runId: idSchema.optional(),
    requestMessageId: idSchema.optional(),
    assistantMessageId: idSchema.optional(),
    toolName: z.string(),
    status: z.enum([
      'preparing',
      'running',
      'completed',
      'failed',
      'waiting-for-user',
      'background'
    ]),
    title: z.string(),
    inputPreview: z.string().max(REMOTE_TOOL_PREVIEW_LIMIT).optional(),
    outputPreview: z.string().max(REMOTE_TOOL_PREVIEW_LIMIT).optional(),
    truncated: z.boolean(),
    /** Previews exist but were omitted from this projection; see `tools.getPreview`. */
    hasPreview: z.boolean().optional(),
    error: z.string().optional(),
    question: remoteToolQuestionSchema.optional(),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.optional()
  })
  .meta({ id: 'RemoteToolCall' })

export type RemoteToolCall = z.infer<typeof remoteToolCallSchema>

export const remoteTodoItemSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed'])
  })
  .meta({ id: 'RemoteTodoItem' })

export const remoteThreadDetailSchema = z
  .object({
    thread: remoteThreadSummarySchema,
    messages: z.array(remoteMessageSchema),
    hasMoreBefore: z.boolean(),
    toolCalls: z.array(remoteToolCallSchema),
    queuedFollowUps: z.array(remoteMessageSchema),
    /** Buffered stream events through this sequence are already reflected in the load snapshot. */
    streamSnapshotSeq: z.number().int().nonnegative().optional(),
    activeRunId: idSchema.optional(),
    activeRunMode: runModeSchema.optional(),
    pendingPlan: z.boolean(),
    todoItems: z.array(remoteTodoItemSchema)
  })
  .meta({ id: 'RemoteThreadDetail' })

export type RemoteThreadDetail = z.infer<typeof remoteThreadDetailSchema>

export const remoteSelectableModelSchema = z
  .object({
    providerName: z.string(),
    model: z.string(),
    isDefault: z.boolean(),
    imageCapable: z.boolean(),
    reasoningEfforts: z.array(reasoningSelectionSchema),
    defaultReasoningEffort: reasoningSelectionSchema.optional()
  })
  .meta({ id: 'RemoteSelectableModel' })

export type RemoteSelectableModel = z.infer<typeof remoteSelectableModelSchema>

export const remoteEssentialSchema = z
  .object({
    id: idSchema,
    /** Emoji icon. Image bytes are fetched separately by essential ID. */
    icon: z.string().optional(),
    hasImageIcon: z.boolean().optional(),
    /** SHA-256 of normalized image bytes; absent for HTTP sources or unreadable images. */
    iconVersion: z.string().optional(),
    label: z.string().optional(),
    workspacePath: z.string().optional(),
    workspaceName: z.string().optional(),
    privacyMode: z.boolean(),
    modelOverride: modelOverrideSchema.optional(),
    order: z.number()
  })
  .meta({ id: 'RemoteEssential' })

export type RemoteEssential = z.infer<typeof remoteEssentialSchema>

export const remoteAppearanceSchema = z
  .object({
    themeId: themeIdSchema,
    themeAppearance: themeAppearanceSchema
  })
  .meta({ id: 'RemoteAppearance' })

export type RemoteAppearance = z.infer<typeof remoteAppearanceSchema>

export const remoteTaskSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['subagent', 'background']),
    title: z.string(),
    state: z.string(),
    startedAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema.optional(),
    progress: z.string().max(REMOTE_TOOL_PREVIEW_LIMIT).optional()
  })
  .meta({ id: 'RemoteTask' })

export type RemoteTask = z.infer<typeof remoteTaskSchema>

export const remoteWorkspaceSchema = z
  .object({
    path: z.string(),
    name: z.string(),
    lastUsedAt: isoDateTimeSchema
  })
  .meta({ id: 'RemoteWorkspace' })

export type RemoteWorkspace = z.infer<typeof remoteWorkspaceSchema>

export const remoteSearchResultSchema = z
  .object({
    threadId: idSchema,
    threadTitle: z.string(),
    threadUpdatedAt: isoDateTimeSchema,
    titleMatched: z.boolean(),
    messageMatches: z.array(
      z.object({
        messageId: idSchema,
        snippet: z.string(),
        role: z.enum(['user', 'assistant']).optional(),
        createdAt: isoDateTimeSchema.optional()
      })
    )
  })
  .meta({ id: 'RemoteSearchResult' })

export type RemoteSearchResult = z.infer<typeof remoteSearchResultSchema>
