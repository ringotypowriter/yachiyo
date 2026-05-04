import { normalizeUserEnabledTools } from '../../../../../shared/yachiyo/protocol.ts'
import { isModelImageCapable } from '../../../../../shared/yachiyo/providerConfig.ts'
import { createServerEventBatcher } from '../serverEventBatcher.ts'
import type { AppState } from '../useAppStore.ts'
import {
  DEFAULT_SETTINGS,
  bootstrapRunsByThread,
  clearRecapForThread,
  collectThreadReasoningEfforts,
  deriveActiveThreadRunState,
  deriveSubagentStateFromToolCalls,
  findThread,
  getComposerDraft,
  getComposerDraftKey,
  getComposerReasoningEffort,
  getThreadRunPhase,
  getThreadRunStatus,
  isBlankNewChat,
  isThreadReusableNewChat,
  moveComposerDraft,
  moveReasoningEffort,
  normalizeWorkspacePath,
  refreshAvailableSkills,
  resolveEffectiveEnabledSkillNames,
  saveCollapsedFolderIds,
  setThreadRunPhaseValue,
  setThreadRunStatusValue,
  setThreadStringValue,
  sortThreads,
  upsertThread,
  waitForGlobalProcessingPaint,
  withFilterBase
} from './helpers.ts'

let bootstrapPromise: Promise<void> | null = null
let unsubscribeFromServer: (() => void) | null = null

export function createThreadLifecycleActions(input: {
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
  get: () => AppState
}): Pick<
  AppState,
  | 'cancelActiveRun'
  | 'cancelRunForThread'
  | 'createNewThread'
  | 'createNewThreadFromEssential'
  | 'initialize'
  | 'regenerateThreadTitle'
  | 'renameThread'
  | 'setThreadColor'
  | 'setThreadIcon'
  | 'starThread'
  | 'createFolderForThreads'
  | 'renameFolder'
  | 'setFolderColor'
  | 'deleteFolder'
  | 'moveThreadToFolder'
  | 'toggleFolderCollapsed'
  | 'setThreadPrivacyMode'
  | 'retryMessage'
  | 'selectReplyBranch'
  | 'selectModel'
  | 'clearThreadModelOverride'
> {
  const { set, get } = input

  return {
    cancelActiveRun: async () => {
      const activeThreadId = get().activeThreadId
      if (!activeThreadId) return
      await get().cancelRunForThread(activeThreadId)
    },

    cancelRunForThread: async (threadId) => {
      const runId = get().activeRunIdsByThread[threadId]
      if (!runId) return
      await window.api.yachiyo.cancelRun({ runId })
    },

    createNewThread: async () => {
      const pendingWorkspacePath = normalizeWorkspacePath(get().pendingWorkspacePath)
      const stagedReasoningEffort = get().reasoningEffortByThread[getComposerDraftKey(null)]
      const reusableThread = get().threads.find((thread) =>
        isThreadReusableNewChat(
          {
            composerDrafts: get().composerDrafts,
            messages: get().messages,
            pendingWorkspacePath
          },
          thread
        )
      )

      if (reusableThread) {
        set((state) => {
          const nextState = {
            ...state,
            activeThreadId: reusableThread.id,
            activeEssentialId: null,
            pendingModelOverride: null,
            pendingAcpBinding: null,
            composerDrafts: moveComposerDraft(
              state.composerDrafts,
              getComposerDraftKey(null),
              getComposerDraftKey(reusableThread.id)
            ),
            reasoningEffortByThread: moveReasoningEffort(
              state.reasoningEffortByThread,
              getComposerDraftKey(null),
              getComposerDraftKey(reusableThread.id)
            ),
            pendingWorkspacePath: null,
            ...withFilterBase(state.sidebarFilter, 'all')
          }

          return {
            ...nextState,
            ...deriveActiveThreadRunState(nextState)
          }
        })
        if (
          stagedReasoningEffort &&
          typeof window !== 'undefined' &&
          window.api?.yachiyo?.setThreadReasoningEffort
        ) {
          void window.api.yachiyo
            .setThreadReasoningEffort({
              threadId: reusableThread.id,
              reasoningEffort: stagedReasoningEffort
            })
            .then((updatedThread) => {
              set((state) => ({ threads: upsertThread(state.threads, updatedThread) }))
            })
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : 'Unable to save thread reasoning effort.'
              set({ lastError: message })
            })
        }
        await refreshAvailableSkills(set, get)
        return
      }

      const createThreadInput = {
        ...(pendingWorkspacePath ? { workspacePath: pendingWorkspacePath } : {}),
        ...(stagedReasoningEffort ? { reasoningEffort: stagedReasoningEffort } : {})
      }
      const thread = await window.api.yachiyo.createThread(
        Object.keys(createThreadInput).length > 0 ? createThreadInput : undefined
      )
      set((state) => {
        const nextState = {
          ...state,
          activeArchivedThreadId: state.activeArchivedThreadId,
          activeThreadId: thread.id,
          activeEssentialId: null,
          pendingModelOverride: null,
          pendingAcpBinding: null,
          composerDrafts: moveComposerDraft(
            state.composerDrafts,
            getComposerDraftKey(null),
            getComposerDraftKey(thread.id)
          ),
          reasoningEffortByThread: moveReasoningEffort(
            state.reasoningEffortByThread,
            getComposerDraftKey(null),
            getComposerDraftKey(thread.id)
          ),
          pendingWorkspacePath: null,
          ...withFilterBase(state.sidebarFilter, 'all'),
          messages: {
            ...state.messages,
            [thread.id]: state.messages[thread.id] ?? []
          },
          toolCalls: {
            ...state.toolCalls,
            [thread.id]: state.toolCalls[thread.id] ?? []
          },
          threads: upsertThread(state.threads, thread)
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
      await refreshAvailableSkills(set, get)
    },

    createNewThreadFromEssential: (essentialId) => {
      const config = get().config
      const essential = config?.essentials?.find((e) => e.id === essentialId)
      if (!essential) return

      set((state) => {
        const activeThread = state.activeThreadId
          ? state.threads.find((thread) => thread.id === state.activeThreadId)
          : null
        const composerDrafts =
          activeThread && isBlankNewChat({ messages: state.messages }, activeThread)
            ? moveComposerDraft(
                state.composerDrafts,
                getComposerDraftKey(activeThread.id),
                getComposerDraftKey(null)
              )
            : state.composerDrafts

        return {
          activeThreadId: null,
          activeEssentialId: essentialId,
          pendingWorkspacePath: normalizeWorkspacePath(essential.workspacePath ?? null),
          pendingModelOverride: essential.modelOverride ?? null,
          composerDrafts,
          ...withFilterBase(state.sidebarFilter, 'all')
        }
      })
      void refreshAvailableSkills(set, get)
    },

    initialize: async () => {
      if (bootstrapPromise) {
        return bootstrapPromise
      }

      bootstrapPromise = (async () => {
        set({
          connectionStatus: 'connecting',
          isBootstrapping: true
        })

        if (!unsubscribeFromServer) {
          const serverEventBatcher = createServerEventBatcher({
            applyEvent: (event) => get().applyServerEvent(event)
          })
          const unsubscribe = window.api.yachiyo.subscribe((event) => {
            serverEventBatcher.push(event)
          })
          unsubscribeFromServer = () => {
            serverEventBatcher.dispose()
            unsubscribe()
          }
        }

        try {
          const payload = await window.api.yachiyo.bootstrap()
          const recoveredSaveToasts = payload.recoveredInterruptedSaveThreadIds.map((threadId) => {
            const thread = [...payload.threads, ...payload.archivedThreads].find(
              (item) => item.id === threadId
            )
            return {
              id: crypto.randomUUID(),
              threadId,
              title: thread?.title ?? 'Thread save interrupted',
              body: 'Save Thread was interrupted before completion. The thread stays unarchived and is available again.',
              eventKey: `thread.save.recovered:${threadId}`
            }
          })
          set((state) => ({
            ...deriveSubagentStateFromToolCalls(
              payload.toolCallsByThread,
              state.subagentStateById,
              state.subagentProgressTimelineByThread
            ),
            activeThreadId: state.activeThreadId ?? payload.threads[0]?.id ?? null,
            activeArchivedThreadId:
              state.activeArchivedThreadId ?? payload.archivedThreads[0]?.id ?? null,
            activeToasts: [...state.activeToasts, ...recoveredSaveToasts],
            archivedThreads: sortThreads(payload.archivedThreads),
            config: payload.config ?? state.config,
            connectionStatus: 'connected',
            enabledTools: normalizeUserEnabledTools(
              payload.config?.enabledTools,
              state.enabledTools
            ),
            initialized: true,
            isBootstrapping: false,
            lastError: null,
            latestRunsByThread: payload.latestRunsByThread,
            runsByThread: bootstrapRunsByThread(payload.latestRunsByThread),
            runPhasesByThread: Object.fromEntries(
              Object.keys(payload.latestRunsByThread).map((threadId) => [threadId, 'idle'] as const)
            ),
            runStatusesByThread: Object.fromEntries(
              Object.entries(payload.latestRunsByThread).map(([threadId, run]) => [
                threadId,
                run.status === 'running' ? 'running' : 'idle'
              ])
            ),
            messages: payload.messagesByThread,
            reasoningEffortByThread: {
              ...state.reasoningEffortByThread,
              ...collectThreadReasoningEfforts([...payload.threads, ...payload.archivedThreads])
            },
            settings: payload.settings ?? state.settings ?? DEFAULT_SETTINGS,
            threads: sortThreads(payload.threads),
            folders: payload.folders ?? [],
            toolCalls: payload.toolCallsByThread
          }))
          set((state) => deriveActiveThreadRunState(state))

          const initialActiveThreadId = get().activeThreadId
          if (initialActiveThreadId && window.api?.yachiyo?.loadThreadData) {
            const data = await window.api.yachiyo.loadThreadData({
              threadId: initialActiveThreadId
            })
            set((state) => ({
              ...(data.runs
                ? { runsByThread: { ...state.runsByThread, [initialActiveThreadId]: data.runs } }
                : {})
            }))
          }

          await refreshAvailableSkills(set, get)
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Failed to bootstrap Yachiyo.'
          set({
            connectionStatus: 'disconnected',
            isBootstrapping: false,
            lastError: message,
            runPhase: 'idle',
            runStatus: 'failed'
          })
          throw error
        }
      })()

      return bootstrapPromise
    },

    regenerateThreadTitle: async (threadId) => {
      await window.api.yachiyo.regenerateThreadTitle({ threadId })
    },

    renameThread: async (threadId, title) => {
      await window.api.yachiyo.renameThread({ threadId, title })
    },

    setThreadColor: async (threadId, colorTag) => {
      await window.api.yachiyo.setThreadColor({ threadId, colorTag })
    },

    setThreadIcon: async (threadId, icon) => {
      await window.api.yachiyo.setThreadIcon({ threadId, icon })
    },

    starThread: async (threadId, starred) => {
      await window.api.yachiyo.starThread({ threadId, starred })
    },

    createFolderForThreads: async (threadIds) => {
      await window.api.yachiyo.createFolderForThreads({ threadIds })
    },

    renameFolder: async (folderId, title) => {
      await window.api.yachiyo.renameFolder({ folderId, title })
    },

    setFolderColor: async (folderId, colorTag) => {
      await window.api.yachiyo.setFolderColor({ folderId, colorTag })
    },

    deleteFolder: async (folderId) => {
      const processingTaskId = get().beginGlobalProcessing('Discarding folder...')
      try {
        await waitForGlobalProcessingPaint()
        await window.api.yachiyo.deleteFolder({ folderId })
      } finally {
        get().endGlobalProcessing(processingTaskId)
      }
    },

    moveThreadToFolder: async (threadId, folderId) => {
      await window.api.yachiyo.moveThreadToFolder({ threadId, folderId })
    },

    toggleFolderCollapsed: (folderId) => {
      set((state) => {
        const next = new Set(state.collapsedFolderIds)
        if (next.has(folderId)) {
          next.delete(folderId)
        } else {
          next.add(folderId)
        }
        saveCollapsedFolderIds(next)
        return { collapsedFolderIds: next }
      })
    },

    setThreadPrivacyMode: async (threadId, enabled) => {
      const thread = await window.api.yachiyo.setThreadPrivacyMode({ threadId, enabled })
      set((state) => ({ threads: upsertThread(state.threads, thread) }))
    },

    retryMessage: async (messageId) => {
      const currentState = get()
      const { activeThreadId: threadId, enabledTools } = currentState
      if (!threadId) {
        return
      }
      clearRecapForThread(set, get, threadId)

      const enabledSkillNames = resolveEffectiveEnabledSkillNames({
        config: currentState.config,
        draft: getComposerDraft(currentState)
      })
      const reasoningEffort = getComposerReasoningEffort(currentState, threadId)

      try {
        const accepted = await window.api.yachiyo.retryMessage({
          threadId,
          messageId,
          enabledTools,
          enabledSkillNames,
          reasoningEffort
        })
        set((state) => {
          const nextState = {
            ...state,
            activeRequestMessageIdsByThread: setThreadStringValue(
              state.activeRequestMessageIdsByThread,
              accepted.thread.id,
              accepted.requestMessageId
            ),
            activeRunIdsByThread: {
              ...state.activeRunIdsByThread,
              [accepted.thread.id]: accepted.runId
            },
            activeThreadId: accepted.thread.id,
            lastError: null,
            runPhasesByThread: setThreadRunPhaseValue(
              state.runPhasesByThread,
              accepted.thread.id,
              'preparing'
            ),
            runStatusesByThread: setThreadRunStatusValue(
              state.runStatusesByThread,
              accepted.thread.id,
              'running'
            ),
            ...withFilterBase(state.sidebarFilter, 'all'),
            threads: upsertThread(state.threads, accepted.thread)
          }

          return {
            ...nextState,
            ...deriveActiveThreadRunState(nextState)
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to retry this response.'
        set({ lastError: message })
        throw error
      }
    },

    selectReplyBranch: async (messageId) => {
      const threadId = get().activeThreadId
      if (!threadId) {
        return
      }
      clearRecapForThread(set, get, threadId)

      try {
        await window.api.yachiyo.selectReplyBranch({ threadId, assistantMessageId: messageId })
        set({ lastError: null })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to switch reply branches.'
        set({ lastError: message })
        throw error
      }
    },

    selectModel: async (providerName, model) => {
      const state = get()
      if (
        getThreadRunPhase(state, state.activeThreadId) !== 'idle' ||
        getThreadRunStatus(state, state.activeThreadId) === 'running'
      ) {
        return
      }

      if (state.activeThreadId && state.config) {
        const thread = findThread(state, state.activeThreadId)
        if (thread) {
          const currentOverride = thread.modelOverride ?? state.config.defaultModel
          const currentCapable = currentOverride
            ? isModelImageCapable(state.config, currentOverride.providerName, currentOverride.model)
            : true
          const targetCapable = isModelImageCapable(state.config, providerName, model)

          const draft = getComposerDraft(state)
          if (currentCapable && !targetCapable && draft.images.length > 0) {
            state.pushToast({
              threadId: state.activeThreadId,
              title: 'Cannot switch model',
              body: 'Remove images from the composer before switching to a non-image-capable model.',
              eventKey: 'model-switch-blocked-images'
            })
            return
          }

          if (currentCapable !== targetCapable && thread.headMessageId) {
            state.pushToast({
              threadId: state.activeThreadId,
              title: 'Cannot switch model',
              body: currentCapable
                ? 'This thread uses an image-capable model. Switching to a non-image-capable model is not allowed.'
                : 'This thread uses a non-image-capable model with I2T processing. Switching to an image-capable model is not allowed.',
              eventKey: 'model-switch-blocked-isolation'
            })
            return
          }
        }
      }

      if (state.activeThreadId) {
        const updatedThread = await window.api.yachiyo.setThreadModelOverride({
          threadId: state.activeThreadId,
          modelOverride: { providerName, model }
        })
        set((s) => ({ threads: upsertThread(s.threads, updatedThread) }))
      } else if (state.activeEssentialId) {
        set({ pendingModelOverride: { providerName, model } })
      } else {
        await window.api.yachiyo.saveSettings({ providerName, model })
      }
    },

    clearThreadModelOverride: async (threadId) => {
      const updatedThread = await window.api.yachiyo.setThreadModelOverride({
        threadId,
        modelOverride: null
      })
      set((s) => ({ threads: upsertThread(s.threads, updatedThread) }))
    }
  }
}
