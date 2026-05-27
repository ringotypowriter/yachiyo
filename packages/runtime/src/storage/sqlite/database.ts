import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import { createSqliteAuxiliaryStorageMethods } from './auxiliaryStorage.ts'
import { createSqliteActivitySourceStorageMethods } from './activitySourceStorage.ts'
import { createBackgroundResponseMessagesRepairQueue } from './backgroundResponseMessagesRepair.ts'
import { createSqliteBootstrapStorageMethods } from './bootstrapStorage.ts'
import { toChannelGroupRecord, toChannelUserRecord } from './channelRecords.ts'
import {
  channelUsersTable,
  messagesTable,
  runRecoveryCheckpointsTable,
  runsTable,
  scheduleRunsTable,
  threadsTable,
  toolCallsTable
} from './schema.ts'
import { openMigratedSqliteDatabase } from './sqliteRuntime.ts'
import { ensureThreadSearchIndex, repairRunRequestMessageIds } from './threadSearchIndex.ts'
import { createSqliteThreadSearchStorageMethods } from './threadSearchStorage.ts'
import {
  serializeEnabledTools,
  serializeModelOverride,
  serializeSkillNames,
  serializeMessageAttachments,
  serializeMessageImages,
  serializeMessageTextBlocks,
  serializeReasoningSelection,
  serializeThreadMemoryRecallState,
  serializeRuntimeBinding,
  serializeLastDelegatedSession,
  serializeTodoItems,
  serializeToolCallDetails,
  toRunRecoveryCheckpoint,
  toStoredRunRecoveryCheckpointRow,
  toMessageRecord,
  serializeReasoning,
  serializeResponseMessages,
  serializeTurnContext,
  toRunRecord,
  toToolCallRecord,
  toThreadRecord,
  type CompleteRunInput,
  type CreateThreadInput,
  type DeleteMessagesInput,
  type RunRecoveryCheckpoint,
  type StartRunInput,
  type YachiyoStorage
} from '../storage.ts'
import type { ChannelUserRole } from '@yachiyo/shared/protocol'
import { sortToolCallsChronologically } from '@yachiyo/shared/toolCallOrder'

export function createSqliteYachiyoStorage(dbPath: string): YachiyoStorage {
  const { client, db } = openMigratedSqliteDatabase(dbPath)
  ensureThreadSearchIndex(client)
  repairRunRequestMessageIds(client)
  const backgroundResponseMessagesRepairQueue = createBackgroundResponseMessagesRepairQueue(dbPath)
  const getChannelUserRole = (channelUserId: string | null): ChannelUserRole | undefined => {
    if (channelUserId === null) return undefined
    const row = db
      .select({ role: channelUsersTable.role })
      .from(channelUsersTable)
      .where(eq(channelUsersTable.id, channelUserId))
      .get()
    return row ? ((row.role ?? 'guest') as ChannelUserRole) : undefined
  }
  const isOwnerDmThread = (thread: {
    channelGroupId: string | null
    channelUserId: string | null
  }): boolean => {
    if (thread.channelGroupId !== null || thread.channelUserId === null) return false
    return getChannelUserRole(thread.channelUserId) === 'owner'
  }
  const isBootstrapThread = (thread: {
    channelGroupId: string | null
    channelUserId: string | null
    source: string | null
  }): boolean => {
    if ((thread.source === null || thread.source === 'local') && thread.channelUserId === null) {
      return true
    }
    return isOwnerDmThread(thread)
  }
  const toThreadRecordWithChannelUserRole = (
    row: Parameters<typeof toThreadRecord>[0]
  ): ReturnType<typeof toThreadRecord> => {
    const record = toThreadRecord(row)
    const role = getChannelUserRole(row.channelUserId)
    return role ? { ...record, channelUserRole: role } : record
  }

  return {
    close() {
      backgroundResponseMessagesRepairQueue.close()
      client.close()
    },

    flushBackgroundTasks(): Promise<void> {
      return backgroundResponseMessagesRepairQueue.flush()
    },

    ...createSqliteBootstrapStorageMethods({
      db,
      isBootstrapThread,
      toThreadRecordWithChannelUserRole
    }),

    recoverInterruptedRuns({ error, finishedAt }) {
      const recoverableRunIds = new Set(
        db
          .select({ runId: runRecoveryCheckpointsTable.runId })
          .from(runRecoveryCheckpointsTable)
          .all()
          .map((row) => row.runId)
      )
      const interruptedRuns = db
        .select({
          id: runsTable.id
        })
        .from(runsTable)
        .where(eq(runsTable.status, 'running'))
        .all()

      if (interruptedRuns.length === 0) {
        return
      }

      const interruptedRunIds = interruptedRuns.map((run) => run.id)
      const failedRunIds = interruptedRunIds.filter((runId) => !recoverableRunIds.has(runId))

      db.transaction((tx) => {
        if (failedRunIds.length > 0) {
          tx.update(runsTable)
            .set({
              completedAt: finishedAt,
              error,
              status: 'failed'
            })
            .where(inArray(runsTable.id, failedRunIds))
            .run()
        }

        tx.update(toolCallsTable)
          .set({
            error: 'Tool execution was interrupted before completion.',
            finishedAt,
            outputSummary: 'Tool execution was interrupted before completion.',
            status: 'failed'
          })
          .where(
            and(
              inArray(toolCallsTable.runId, interruptedRunIds),
              inArray(toolCallsTable.status, ['preparing', 'running'])
            )
          )
          .run()
      })
    },

    listRunRecoveryCheckpoints() {
      return db
        .select()
        .from(runRecoveryCheckpointsTable)
        .orderBy(asc(runRecoveryCheckpointsTable.updatedAt))
        .all()
        .map(toRunRecoveryCheckpoint)
    },

    getRunRecoveryCheckpoint(runId) {
      const checkpoint = db
        .select()
        .from(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .get()
      return checkpoint ? toRunRecoveryCheckpoint(checkpoint) : undefined
    },

    upsertRunRecoveryCheckpoint(checkpoint) {
      db.insert(runRecoveryCheckpointsTable)
        .values(toStoredRunRecoveryCheckpointRow(checkpoint as RunRecoveryCheckpoint))
        .onConflictDoUpdate({
          target: runRecoveryCheckpointsTable.runId,
          set: toStoredRunRecoveryCheckpointRow(checkpoint as RunRecoveryCheckpoint)
        })
        .run()
    },

    deleteRunRecoveryCheckpoint(runId) {
      db.delete(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .run()
    },

    getRun(runId) {
      const run = db.select().from(runsTable).where(eq(runsTable.id, runId)).get()

      return run ? toRunRecord(run) : undefined
    },

    getThread(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          starredAt: threadsTable.starredAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          handoffFromThreadId: threadsTable.handoffFromThreadId,
          folderId: threadsTable.folderId,
          colorTag: threadsTable.colorTag,
          headMessageId: threadsTable.headMessageId,
          icon: threadsTable.icon,
          id: threadsTable.id,
          memoryRecallState: threadsTable.memoryRecallState,
          modelOverride: threadsTable.modelOverride,
          preview: threadsTable.preview,
          privacyMode: threadsTable.privacyMode,
          queuedFollowUpEnabledTools: threadsTable.queuedFollowUpEnabledTools,
          queuedFollowUpEnabledSkillNames: threadsTable.queuedFollowUpEnabledSkillNames,
          queuedFollowUpMessageId: threadsTable.queuedFollowUpMessageId,
          queuedFollowUpReasoningEffort: threadsTable.queuedFollowUpReasoningEffort,
          enabledTools: threadsTable.enabledTools,
          runMode: threadsTable.runMode,
          reasoningEffort: threadsTable.reasoningEffort,
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          rollingSummary: threadsTable.rollingSummary,
          summaryWatermarkMessageId: threadsTable.summaryWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          createdFromScheduleId: threadsTable.createdFromScheduleId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          todoItems: threadsTable.todoItems,
          recapText: threadsTable.recapText,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .where(and(eq(threadsTable.id, threadId), isNull(threadsTable.archivedAt)))
        .get()

      return thread ? toThreadRecordWithChannelUserRole(thread) : undefined
    },

    getArchivedThread(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          starredAt: threadsTable.starredAt,
          branchFromMessageId: threadsTable.branchFromMessageId,
          branchFromThreadId: threadsTable.branchFromThreadId,
          handoffFromThreadId: threadsTable.handoffFromThreadId,
          folderId: threadsTable.folderId,
          colorTag: threadsTable.colorTag,
          headMessageId: threadsTable.headMessageId,
          icon: threadsTable.icon,
          id: threadsTable.id,
          memoryRecallState: threadsTable.memoryRecallState,
          modelOverride: threadsTable.modelOverride,
          preview: threadsTable.preview,
          privacyMode: threadsTable.privacyMode,
          queuedFollowUpEnabledTools: threadsTable.queuedFollowUpEnabledTools,
          queuedFollowUpEnabledSkillNames: threadsTable.queuedFollowUpEnabledSkillNames,
          queuedFollowUpMessageId: threadsTable.queuedFollowUpMessageId,
          queuedFollowUpReasoningEffort: threadsTable.queuedFollowUpReasoningEffort,
          enabledTools: threadsTable.enabledTools,
          runMode: threadsTable.runMode,
          reasoningEffort: threadsTable.reasoningEffort,
          source: threadsTable.source,
          channelUserId: threadsTable.channelUserId,
          channelGroupId: threadsTable.channelGroupId,
          rollingSummary: threadsTable.rollingSummary,
          summaryWatermarkMessageId: threadsTable.summaryWatermarkMessageId,
          readAt: threadsTable.readAt,
          createdFromEssentialId: threadsTable.createdFromEssentialId,
          createdFromScheduleId: threadsTable.createdFromScheduleId,
          runtimeBinding: threadsTable.runtimeBinding,
          lastDelegatedSession: threadsTable.lastDelegatedSession,
          todoItems: threadsTable.todoItems,
          recapText: threadsTable.recapText,
          title: threadsTable.title,
          updatedAt: threadsTable.updatedAt,
          workspacePath: threadsTable.workspacePath
        })
        .from(threadsTable)
        .where(eq(threadsTable.id, threadId))
        .get()

      if (!thread || thread.archivedAt === null) {
        return undefined
      }

      return toThreadRecordWithChannelUserRole(thread)
    },

    getThreadCreatedAt(threadId) {
      const thread = db
        .select({
          archivedAt: threadsTable.archivedAt,
          createdAt: threadsTable.createdAt
        })
        .from(threadsTable)
        .where(eq(threadsTable.id, threadId))
        .get()

      if (!thread || thread.archivedAt !== null) {
        return undefined
      }

      return thread.createdAt
    },

    createThread({ thread, createdAt, messages }: CreateThreadInput) {
      db.transaction((tx) => {
        tx.insert(threadsTable)
          .values({
            archivedAt: null,
            starredAt: null,
            branchFromMessageId: thread.branchFromMessageId ?? null,
            branchFromThreadId: thread.branchFromThreadId ?? null,
            handoffFromThreadId: thread.handoffFromThreadId ?? null,
            folderId: thread.folderId ?? null,
            colorTag: thread.colorTag ?? null,
            createdAt,
            headMessageId: thread.headMessageId ?? null,
            icon: thread.icon ?? null,
            id: thread.id,
            memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
            modelOverride: serializeModelOverride(thread.modelOverride),
            preview: thread.preview ?? null,
            privacyMode: thread.privacyMode ? '1' : null,
            queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              thread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
            queuedFollowUpReasoningEffort: serializeReasoningSelection(
              thread.queuedFollowUpReasoningEffort
            ),
            enabledTools: serializeEnabledTools(thread.enabledTools),
            runMode: thread.runMode ?? null,
            reasoningEffort: serializeReasoningSelection(thread.reasoningEffort),
            source: thread.source ?? 'local',
            channelUserId: thread.channelUserId ?? null,
            channelGroupId: thread.channelGroupId ?? null,
            rollingSummary: thread.rollingSummary ?? null,
            summaryWatermarkMessageId: thread.summaryWatermarkMessageId ?? null,
            createdFromEssentialId: thread.createdFromEssentialId ?? null,
            createdFromScheduleId: thread.createdFromScheduleId ?? null,
            title: thread.title,
            updatedAt: thread.updatedAt,
            workspacePath: thread.workspacePath ?? null,
            runtimeBinding: serializeRuntimeBinding(thread.runtimeBinding),
            lastDelegatedSession: serializeLastDelegatedSession(thread.lastDelegatedSession),
            todoItems: serializeTodoItems(thread.todoItems),
            recapText: thread.recapText ?? null
          })
          .run()

        if (messages && messages.length > 0) {
          tx.insert(messagesTable)
            .values(
              messages.map(
                ({
                  textBlocks,
                  reasoning,
                  attachments,
                  responseMessages,
                  turnContext,
                  ...rest
                }) => ({
                  ...rest,
                  textBlocks: serializeMessageTextBlocks(textBlocks),
                  images: serializeMessageImages(rest.images),
                  attachments: serializeMessageAttachments(attachments),
                  reasoning: serializeReasoning(reasoning),
                  responseMessages: serializeResponseMessages(responseMessages),
                  turnContext: serializeTurnContext(turnContext)
                })
              )
            )
            .run()
        }
      })
    },

    renameThread({ threadId, title, updatedAt }) {
      db.update(threadsTable)
        .set({
          title,
          updatedAt
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    archiveThread({ threadId, archivedAt, updatedAt, readAt }) {
      db.update(threadsTable)
        .set({
          archivedAt,
          updatedAt,
          // null = unread (system-initiated), timestamp = read (user-initiated)
          readAt: readAt ?? null
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    markThreadAsRead({ threadId, readAt }) {
      db.update(threadsTable).set({ readAt }).where(eq(threadsTable.id, threadId)).run()
    },

    markThreadReviewed({ threadId, reviewedAt }) {
      db.update(threadsTable)
        .set({ selfReviewedAt: reviewedAt })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    restoreThread({ threadId, updatedAt }) {
      db.update(threadsTable)
        .set({
          archivedAt: null,
          updatedAt,
          createdFromScheduleId: null
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    beginThreadSave({ threadId, savingStartedAt }) {
      db.update(threadsTable).set({ savingStartedAt }).where(eq(threadsTable.id, threadId)).run()
    },

    clearThreadSave({ threadId }) {
      db.update(threadsTable)
        .set({ savingStartedAt: null })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    recoverInterruptedSaves() {
      const recoveredThreadIds = db
        .select({ id: threadsTable.id })
        .from(threadsTable)
        .where(isNotNull(threadsTable.savingStartedAt))
        .all()
        .map((thread) => thread.id)

      if (recoveredThreadIds.length === 0) {
        return recoveredThreadIds
      }

      db.update(threadsTable)
        .set({ savingStartedAt: null })
        .where(isNotNull(threadsTable.savingStartedAt))
        .run()

      return recoveredThreadIds
    },

    deleteThread({ threadId }) {
      db.transaction((tx) => {
        tx.delete(runRecoveryCheckpointsTable)
          .where(eq(runRecoveryCheckpointsTable.threadId, threadId))
          .run()
        tx.delete(toolCallsTable).where(eq(toolCallsTable.threadId, threadId)).run()
        tx.delete(runsTable).where(eq(runsTable.threadId, threadId)).run()
        tx.update(scheduleRunsTable)
          .set({ threadId: null })
          .where(eq(scheduleRunsTable.threadId, threadId))
          .run()
        tx.update(messagesTable)
          .set({ parentMessageId: null })
          .where(eq(messagesTable.threadId, threadId))
          .run()
        tx.delete(messagesTable).where(eq(messagesTable.threadId, threadId)).run()
        tx.delete(threadsTable).where(eq(threadsTable.id, threadId)).run()
      })
    },

    resetThreadHistory({ threadId, updatedAt }) {
      db.transaction((tx) => {
        tx.delete(toolCallsTable).where(eq(toolCallsTable.threadId, threadId)).run()
        tx.delete(runsTable).where(eq(runsTable.threadId, threadId)).run()
        tx.delete(messagesTable).where(eq(messagesTable.threadId, threadId)).run()
        tx.update(threadsTable)
          .set({
            headMessageId: null,
            preview: null,
            queuedFollowUpEnabledTools: null,
            queuedFollowUpEnabledSkillNames: null,
            queuedFollowUpMessageId: null,
            queuedFollowUpReasoningEffort: null,
            rollingSummary: null,
            summaryWatermarkMessageId: null,
            recapText: null,
            updatedAt
          })
          .where(eq(threadsTable.id, threadId))
          .run()
      })
    },

    resetThreadsHistory({ threadIds, updatedAt }) {
      if (threadIds.length === 0) {
        return
      }

      db.transaction((tx) => {
        tx.delete(toolCallsTable).where(inArray(toolCallsTable.threadId, threadIds)).run()
        tx.delete(runsTable).where(inArray(runsTable.threadId, threadIds)).run()
        tx.delete(messagesTable).where(inArray(messagesTable.threadId, threadIds)).run()
        tx.update(threadsTable)
          .set({
            headMessageId: null,
            preview: null,
            queuedFollowUpEnabledTools: null,
            queuedFollowUpEnabledSkillNames: null,
            queuedFollowUpMessageId: null,
            queuedFollowUpReasoningEffort: null,
            rollingSummary: null,
            summaryWatermarkMessageId: null,
            recapText: null,
            updatedAt
          })
          .where(inArray(threadsTable.id, threadIds))
          .run()
      })
    },

    resetChannelGroupThreadsHistory({ channelGroupId, updatedAt }) {
      const threadIds = db
        .select({ id: threadsTable.id })
        .from(threadsTable)
        .where(eq(threadsTable.channelGroupId, channelGroupId))
        .all()
        .map((thread) => thread.id)

      if (threadIds.length === 0) {
        return
      }

      this.resetThreadsHistory({ threadIds, updatedAt })
    },

    updateThread(thread) {
      db.update(threadsTable)
        .set({
          branchFromMessageId: thread.branchFromMessageId ?? null,
          branchFromThreadId: thread.branchFromThreadId ?? null,
          colorTag: thread.colorTag ?? null,
          headMessageId: thread.headMessageId ?? null,
          icon: thread.icon ?? null,
          starredAt: thread.starredAt ?? null,
          memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
          modelOverride: serializeModelOverride(thread.modelOverride),
          preview: thread.preview ?? null,
          privacyMode: thread.privacyMode ? '1' : null,
          queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
          queuedFollowUpEnabledSkillNames: serializeSkillNames(
            thread.queuedFollowUpEnabledSkillNames
          ),
          queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
          queuedFollowUpReasoningEffort: serializeReasoningSelection(
            thread.queuedFollowUpReasoningEffort
          ),
          enabledTools: serializeEnabledTools(thread.enabledTools),
          runMode: thread.runMode ?? null,
          reasoningEffort: serializeReasoningSelection(thread.reasoningEffort),
          source: thread.source ?? null,
          channelUserId: thread.channelUserId ?? null,
          channelGroupId: thread.channelGroupId ?? null,
          rollingSummary: thread.rollingSummary ?? null,
          summaryWatermarkMessageId: thread.summaryWatermarkMessageId ?? null,
          title: thread.title,
          updatedAt: thread.updatedAt,
          workspacePath: thread.workspacePath ?? null,
          runtimeBinding: serializeRuntimeBinding(thread.runtimeBinding),
          lastDelegatedSession: serializeLastDelegatedSession(thread.lastDelegatedSession),
          todoItems: serializeTodoItems(thread.todoItems),
          recapText: thread.recapText ?? null
        })
        .where(eq(threadsTable.id, thread.id))
        .run()
    },

    setThreadIcon({ threadId, icon, updatedAt }) {
      db.update(threadsTable).set({ icon, updatedAt }).where(eq(threadsTable.id, threadId)).run()
    },

    setThreadColor({ threadId, colorTag }) {
      db.update(threadsTable)
        .set({ colorTag })
        .where(and(eq(threadsTable.id, threadId), isNull(threadsTable.archivedAt)))
        .run()
    },

    starThread({ threadId, starredAt }) {
      db.update(threadsTable).set({ starredAt }).where(eq(threadsTable.id, threadId)).run()
    },

    setThreadPrivacyMode({ threadId, privacyMode, updatedAt }) {
      db.update(threadsTable)
        .set({
          privacyMode: privacyMode ? '1' : null,
          updatedAt
        })
        .where(eq(threadsTable.id, threadId))
        .run()
    },

    saveThreadMessage({ thread, updatedThread, message, replacedMessageId }) {
      db.transaction((tx) => {
        if (replacedMessageId) {
          tx.delete(messagesTable).where(eq(messagesTable.id, replacedMessageId)).run()
        }

        const {
          textBlocks,
          reasoning,
          attachments,
          responseMessages,
          turnContext,
          ...persistedMessage
        } = message
        tx.insert(messagesTable)
          .values({
            ...persistedMessage,
            textBlocks: serializeMessageTextBlocks(textBlocks),
            images: serializeMessageImages(message.images),
            attachments: serializeMessageAttachments(attachments),
            reasoning: serializeReasoning(reasoning),
            responseMessages: serializeResponseMessages(responseMessages),
            turnContext: serializeTurnContext(turnContext)
          })
          .run()

        tx.update(threadsTable)
          .set({
            branchFromMessageId: updatedThread.branchFromMessageId ?? null,
            branchFromThreadId: updatedThread.branchFromThreadId ?? null,
            headMessageId: updatedThread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(updatedThread.memoryRecall),
            preview: updatedThread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(
              updatedThread.queuedFollowUpEnabledTools
            ),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              updatedThread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
            queuedFollowUpReasoningEffort: serializeReasoningSelection(
              updatedThread.queuedFollowUpReasoningEffort
            ),
            todoItems: serializeTodoItems(updatedThread.todoItems),
            recapText: updatedThread.recapText ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt,
            workspacePath: updatedThread.workspacePath ?? null
          })
          .where(eq(threadsTable.id, thread.id))
          .run()
      })
    },

    startRun({
      runId,
      thread,
      updatedThread,
      requestMessageId,
      userMessage,
      createdAt
    }: StartRunInput) {
      db.transaction((tx) => {
        if (userMessage) {
          const {
            textBlocks,
            reasoning,
            attachments,
            responseMessages,
            turnContext,
            ...persistedUserMessage
          } = userMessage
          tx.insert(messagesTable)
            .values({
              ...persistedUserMessage,
              textBlocks: serializeMessageTextBlocks(textBlocks),
              images: serializeMessageImages(userMessage.images),
              attachments: serializeMessageAttachments(attachments),
              reasoning: serializeReasoning(reasoning),
              responseMessages: serializeResponseMessages(responseMessages),
              turnContext: serializeTurnContext(turnContext)
            })
            .run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: updatedThread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(updatedThread.memoryRecall),
            preview: updatedThread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(
              updatedThread.queuedFollowUpEnabledTools
            ),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              updatedThread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
            queuedFollowUpReasoningEffort: serializeReasoningSelection(
              updatedThread.queuedFollowUpReasoningEffort
            ),
            todoItems: serializeTodoItems(updatedThread.todoItems),
            recapText: updatedThread.recapText ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt,
            workspacePath: updatedThread.workspacePath ?? null
          })
          .where(eq(threadsTable.id, thread.id))
          .run()

        tx.insert(runsTable)
          .values({
            assistantMessageId: null,
            completedAt: null,
            createdAt,
            error: null,
            id: runId,
            requestMessageId,
            status: 'running',
            threadId: thread.id
          })
          .run()
      })
    },

    completeRun({
      runId,
      updatedThread,
      assistantMessage,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      cacheReadTokens,
      cacheWriteTokens,
      modelId,
      providerName
    }: CompleteRunInput) {
      db.transaction((tx) => {
        tx.delete(runRecoveryCheckpointsTable)
          .where(eq(runRecoveryCheckpointsTable.runId, runId))
          .run()

        const {
          textBlocks,
          reasoning,
          attachments,
          responseMessages,
          turnContext,
          ...persistedAssistantMessage
        } = assistantMessage
        tx.insert(messagesTable)
          .values({
            ...persistedAssistantMessage,
            textBlocks: serializeMessageTextBlocks(textBlocks),
            images: serializeMessageImages(assistantMessage.images),
            attachments: serializeMessageAttachments(attachments),
            reasoning: serializeReasoning(reasoning),
            responseMessages: serializeResponseMessages(responseMessages),
            turnContext: serializeTurnContext(turnContext)
          })
          .run()

        tx.update(threadsTable)
          .set({
            headMessageId: updatedThread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(updatedThread.memoryRecall),
            preview: updatedThread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(
              updatedThread.queuedFollowUpEnabledTools
            ),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              updatedThread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: updatedThread.queuedFollowUpMessageId ?? null,
            queuedFollowUpReasoningEffort: serializeReasoningSelection(
              updatedThread.queuedFollowUpReasoningEffort
            ),
            runtimeBinding: serializeRuntimeBinding(updatedThread.runtimeBinding),
            lastDelegatedSession: serializeLastDelegatedSession(updatedThread.lastDelegatedSession),
            todoItems: serializeTodoItems(updatedThread.todoItems),
            recapText: updatedThread.recapText ?? null,
            title: updatedThread.title,
            updatedAt: updatedThread.updatedAt,
            workspacePath: updatedThread.workspacePath ?? null
          })
          .where(eq(threadsTable.id, updatedThread.id))
          .run()

        tx.update(runsTable)
          .set({
            assistantMessageId: assistantMessage.id,
            completedAt: updatedThread.updatedAt,
            status: 'completed',
            ...(promptTokens !== undefined ? { promptTokens } : {}),
            ...(completionTokens !== undefined ? { completionTokens } : {}),
            ...(totalPromptTokens !== undefined ? { totalPromptTokens } : {}),
            ...(totalCompletionTokens !== undefined ? { totalCompletionTokens } : {}),
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            ...(modelId !== undefined ? { modelId } : {}),
            ...(providerName !== undefined ? { providerName } : {})
          })
          .where(eq(runsTable.id, runId))
          .run()

        tx.update(toolCallsTable)
          .set({
            assistantMessageId: assistantMessage.id
          })
          .where(and(eq(toolCallsTable.runId, runId), isNull(toolCallsTable.assistantMessageId)))
          .run()
      })
    },

    cancelRun({
      runId,
      completedAt,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      cacheReadTokens,
      cacheWriteTokens
    }) {
      db.delete(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .run()

      db.update(runsTable)
        .set({
          completedAt,
          status: 'cancelled',
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
          ...(totalPromptTokens !== undefined ? { totalPromptTokens } : {}),
          ...(totalCompletionTokens !== undefined ? { totalCompletionTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {})
        })
        .where(eq(runsTable.id, runId))
        .run()

      db.update(toolCallsTable)
        .set({ status: 'failed', finishedAt: completedAt })
        .where(
          and(
            eq(toolCallsTable.runId, runId),
            inArray(toolCallsTable.status, ['preparing', 'running'])
          )
        )
        .run()
    },

    failRun({
      runId,
      completedAt,
      error,
      promptTokens,
      completionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      cacheReadTokens,
      cacheWriteTokens
    }) {
      db.delete(runRecoveryCheckpointsTable)
        .where(eq(runRecoveryCheckpointsTable.runId, runId))
        .run()

      db.update(runsTable)
        .set({
          completedAt,
          error,
          status: 'failed',
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { completionTokens } : {}),
          ...(totalPromptTokens !== undefined ? { totalPromptTokens } : {}),
          ...(totalCompletionTokens !== undefined ? { totalCompletionTokens } : {}),
          ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {})
        })
        .where(eq(runsTable.id, runId))
        .run()

      db.update(toolCallsTable)
        .set({ status: 'failed', finishedAt: completedAt })
        .where(
          and(
            eq(toolCallsTable.runId, runId),
            inArray(toolCallsTable.status, ['preparing', 'running'])
          )
        )
        .run()
    },

    updateRunRequestMessageId(runId, requestMessageId) {
      db.update(runsTable).set({ requestMessageId }).where(eq(runsTable.id, runId)).run()
    },

    updateRunSnapshot(runId, snapshot) {
      db.update(runsTable)
        .set({
          snapshotFileCount: snapshot.fileCount,
          workspacePath: snapshot.workspacePath ?? null
        })
        .where(eq(runsTable.id, runId))
        .run()
    },

    listThreadRuns(threadId) {
      return db
        .select({
          assistantMessageId: runsTable.assistantMessageId,
          completedAt: runsTable.completedAt,
          completionTokens: runsTable.completionTokens,
          createdAt: runsTable.createdAt,
          error: runsTable.error,
          id: runsTable.id,
          promptTokens: runsTable.promptTokens,
          requestMessageId: runsTable.requestMessageId,
          status: runsTable.status,
          threadId: runsTable.threadId,
          totalCompletionTokens: runsTable.totalCompletionTokens,
          totalPromptTokens: runsTable.totalPromptTokens,
          cacheReadTokens: runsTable.cacheReadTokens,
          cacheWriteTokens: runsTable.cacheWriteTokens,
          modelId: runsTable.modelId,
          providerName: runsTable.providerName,
          snapshotFileCount: runsTable.snapshotFileCount,
          workspacePath: runsTable.workspacePath
        })
        .from(runsTable)
        .where(eq(runsTable.threadId, threadId))
        .orderBy(desc(runsTable.createdAt))
        .all()
        .map(toRunRecord)
    },

    listThreadMessages(threadId) {
      return db
        .select({
          attachments: messagesTable.attachments,
          content: messagesTable.content,
          createdAt: messagesTable.createdAt,
          id: messagesTable.id,
          images: messagesTable.images,
          modelId: messagesTable.modelId,
          parentMessageId: messagesTable.parentMessageId,
          providerName: messagesTable.providerName,
          reasoning: messagesTable.reasoning,
          responseMessages: messagesTable.responseMessages,
          turnContext: messagesTable.turnContext,
          visibleReply: messagesTable.visibleReply,
          senderName: messagesTable.senderName,
          senderExternalUserId: messagesTable.senderExternalUserId,
          hidden: messagesTable.hidden,
          role: messagesTable.role,
          status: messagesTable.status,
          textBlocks: messagesTable.textBlocks,
          threadId: messagesTable.threadId
        })
        .from(messagesTable)
        .where(eq(messagesTable.threadId, threadId))
        .orderBy(asc(messagesTable.createdAt))
        .all()
        .map(toMessageRecord)
    },

    updateMessage(message) {
      db.update(messagesTable)
        .set({
          content: message.content,
          images: serializeMessageImages(message.images),
          reasoning: serializeReasoning(message.reasoning),
          responseMessages: serializeResponseMessages(message.responseMessages),
          turnContext: serializeTurnContext(message.turnContext),
          visibleReply: message.visibleReply ?? null,
          textBlocks: serializeMessageTextBlocks(message.textBlocks),
          modelId: message.modelId ?? null,
          parentMessageId: message.parentMessageId ?? null,
          providerName: message.providerName ?? null,
          role: message.role,
          status: message.status
        })
        .where(eq(messagesTable.id, message.id))
        .run()
    },

    persistResponseMessagesRepairInBackground(input) {
      const responseMessages = serializeResponseMessages(input.responseMessages)
      if (!responseMessages) {
        return
      }

      backgroundResponseMessagesRepairQueue.schedule({
        messageId: input.messageId,
        responseMessages
      })
    },

    listThreadToolCalls(threadId) {
      return sortToolCallsChronologically(
        db
          .select({
            assistantMessageId: toolCallsTable.assistantMessageId,
            cwd: toolCallsTable.cwd,
            details: toolCallsTable.details,
            error: toolCallsTable.error,
            finishedAt: toolCallsTable.finishedAt,
            id: toolCallsTable.id,
            inputSummary: toolCallsTable.inputSummary,
            outputSummary: toolCallsTable.outputSummary,
            requestMessageId: toolCallsTable.requestMessageId,
            runId: toolCallsTable.runId,
            startedAt: toolCallsTable.startedAt,
            stepBudget: toolCallsTable.stepBudget,
            stepIndex: toolCallsTable.stepIndex,
            status: toolCallsTable.status,
            threadId: toolCallsTable.threadId,
            toolName: toolCallsTable.toolName
          })
          .from(toolCallsTable)
          .where(eq(toolCallsTable.threadId, threadId))
          .orderBy(asc(toolCallsTable.startedAt))
          .all()
          .map(toToolCallRecord)
      )
    },

    createToolCall(toolCall) {
      db.insert(toolCallsTable)
        .values({
          assistantMessageId: toolCall.assistantMessageId ?? null,
          cwd: toolCall.cwd ?? null,
          details: serializeToolCallDetails(toolCall.details),
          error: toolCall.error ?? null,
          finishedAt: toolCall.finishedAt ?? null,
          id: toolCall.id,
          inputSummary: toolCall.inputSummary,
          outputSummary: toolCall.outputSummary ?? null,
          requestMessageId: toolCall.requestMessageId ?? null,
          runId: toolCall.runId ?? null,
          startedAt: toolCall.startedAt,
          stepBudget: toolCall.stepBudget ?? null,
          stepIndex: toolCall.stepIndex ?? null,
          status: toolCall.status,
          threadId: toolCall.threadId,
          toolName: toolCall.toolName
        })
        .run()
    },

    updateToolCall(toolCall) {
      db.update(toolCallsTable)
        .set({
          assistantMessageId: toolCall.assistantMessageId ?? null,
          cwd: toolCall.cwd ?? null,
          details: serializeToolCallDetails(toolCall.details),
          error: toolCall.error ?? null,
          finishedAt: toolCall.finishedAt ?? null,
          inputSummary: toolCall.inputSummary,
          outputSummary: toolCall.outputSummary ?? null,
          requestMessageId: toolCall.requestMessageId ?? null,
          stepBudget: toolCall.stepBudget ?? null,
          stepIndex: toolCall.stepIndex ?? null,
          status: toolCall.status
        })
        .where(eq(toolCallsTable.id, toolCall.id))
        .run()
    },

    deleteMessages({ thread, messageIds }: DeleteMessagesInput) {
      db.transaction((tx) => {
        if (messageIds.length > 0) {
          const runsToDelete = tx
            .select({
              id: runsTable.id
            })
            .from(runsTable)
            .where(
              or(
                inArray(runsTable.requestMessageId, messageIds),
                inArray(runsTable.assistantMessageId, messageIds)
              )
            )
            .all()

          if (runsToDelete.length > 0) {
            const runIdsToDelete = runsToDelete.map((run) => run.id)
            tx.delete(toolCallsTable)
              .where(
                and(
                  inArray(toolCallsTable.runId, runIdsToDelete),
                  or(
                    inArray(
                      toolCallsTable.assistantMessageId,
                      messageIds.filter((id) => id != null) as string[]
                    ),
                    isNull(toolCallsTable.assistantMessageId)
                  )
                )
              )
              .run()
            // Detach any remaining tool calls for these runs so they survive
            // the run deletion (e.g. tool calls bound to a stopped assistant
            // branch after a steer restart).
            tx.update(toolCallsTable)
              .set({ runId: null })
              .where(inArray(toolCallsTable.runId, runIdsToDelete))
              .run()
            tx.delete(runsTable).where(inArray(runsTable.id, runIdsToDelete)).run()
          }

          tx.delete(messagesTable).where(inArray(messagesTable.id, messageIds)).run()
        }

        tx.update(threadsTable)
          .set({
            headMessageId: thread.headMessageId ?? null,
            memoryRecallState: serializeThreadMemoryRecallState(thread.memoryRecall),
            preview: thread.preview ?? null,
            queuedFollowUpEnabledTools: serializeEnabledTools(thread.queuedFollowUpEnabledTools),
            queuedFollowUpEnabledSkillNames: serializeSkillNames(
              thread.queuedFollowUpEnabledSkillNames
            ),
            queuedFollowUpMessageId: thread.queuedFollowUpMessageId ?? null,
            queuedFollowUpReasoningEffort: serializeReasoningSelection(
              thread.queuedFollowUpReasoningEffort
            ),
            todoItems: serializeTodoItems(thread.todoItems),
            title: thread.title,
            updatedAt: thread.updatedAt
          })
          .where(eq(threadsTable.id, thread.id))
          .run()
      })
    },

    ...createSqliteThreadSearchStorageMethods({ client, db }),

    findActiveChannelThread(channelUserId, maxAgeMs) {
      const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
      const rows = db
        .select()
        .from(threadsTable)
        .where(and(eq(threadsTable.channelUserId, channelUserId), isNull(threadsTable.archivedAt)))
        .orderBy(desc(threadsTable.updatedAt))
        .all()

      const row = rows.find((r) => r.updatedAt >= cutoff)
      return row ? toThreadRecordWithChannelUserRole(row) : undefined
    },

    getThreadTotalTokens(threadId) {
      const row = db
        .select({ promptTokens: runsTable.promptTokens })
        .from(runsTable)
        .where(and(eq(runsTable.threadId, threadId), eq(runsTable.status, 'completed')))
        .orderBy(desc(runsTable.completedAt))
        .limit(1)
        .get()

      if (!row) return 0
      // Last step's prompt tokens = actual context window size.
      return row.promptTokens ?? 0
    },

    ...createSqliteActivitySourceStorageMethods({ db }),

    ...createSqliteAuxiliaryStorageMethods({
      db,
      isBootstrapThread,
      isOwnerDmThread,
      toChannelGroupRecord,
      toChannelUserRecord,
      toThreadRecordWithChannelUserRole
    })
  }
}
