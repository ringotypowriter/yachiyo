import {
  normalizeUserEnabledTools,
  normalizeSkillNames,
  type RunModeId
} from '../../../../../shared/yachiyo/protocol.ts'
import {
  deriveRunModeId,
  resolveRunModeEnabledTools
} from '../../../../../shared/yachiyo/toolModes.ts'
import { isComposerReasoningSelection } from '../../../../../shared/yachiyo/reasoningEffort.ts'
import { isExternalThread } from '../../../features/threads/lib/threadVisibility.ts'
import type { AppState, ComposerFileDraft, ComposerImageDraft } from '../useAppStore.ts'
import {
  DEFAULT_SIDEBAR_FILTER,
  EMPTY_COMPOSER_DRAFT,
  areEnabledToolsEqual,
  deriveActiveThreadRunState,
  deriveSubagentStateFromToolCalls,
  deriveThreadListMode,
  getComposerDraftKey,
  normalizeWorkspacePath,
  refreshAvailableSkills,
  saveSidebarFilter,
  setReasoningEffortValue,
  setThreadStringValue,
  sortThreads,
  toggleEnabledTools,
  updateComposerDraft,
  upsertThread,
  withFilterBase
} from './helpers.ts'

export function createComposerUiActions(input: {
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
  get: () => AppState
}): Pick<
  AppState,
  | 'setEnabledTools'
  | 'setRunMode'
  | 'setActiveThread'
  | 'setScrollToMessageId'
  | 'clearScrollToMessageId'
  | 'setComposerEnabledSkillNames'
  | 'setComposerReasoningEffort'
  | 'setActiveArchivedThread'
  | 'openThreadFromNotification'
  | 'setThreadListMode'
  | 'setSidebarFilterBase'
  | 'toggleSidebarFilterColor'
  | 'toggleSidebarFilterWorkspace'
  | 'toggleSidebarFilterRunning'
  | 'toggleSidebarFilterJustDone'
  | 'toggleSidebarFilterFolderOnly'
  | 'clearSidebarFilter'
  | 'toggleShowExternalThreads'
  | 'setComposerValue'
  | 'mergeBufferedPayloadIntoDraft'
  | 'setPendingAcpBinding'
  | 'setPendingWorkspacePath'
  | 'setThreadWorkspace'
  | 'toggleEnabledTool'
  | 'upsertComposerImage'
  | 'upsertComposerFile'
  | 'removeComposerFile'
> {
  const { set, get } = input

  return {
    setEnabledTools: async (enabledTools) => {
      const previousEnabledTools = get().enabledTools
      const previousRunMode = get().runMode
      const nextEnabledTools = normalizeUserEnabledTools(enabledTools, previousEnabledTools)
      const nextRunMode = deriveRunModeId(nextEnabledTools)

      if (
        areEnabledToolsEqual(previousEnabledTools, nextEnabledTools) &&
        previousRunMode === nextRunMode
      ) {
        return
      }

      set((state) => ({
        config: state.config
          ? { ...state.config, enabledTools: nextEnabledTools, runMode: nextRunMode }
          : state.config,
        enabledTools: nextEnabledTools,
        runMode: nextRunMode,
        lastError: null
      }))

      try {
        const config = await window.api.yachiyo.saveToolPreferences({
          enabledTools: nextEnabledTools,
          runMode: nextRunMode
        })
        set({
          config,
          enabledTools: normalizeUserEnabledTools(config.enabledTools, nextEnabledTools),
          runMode: config.runMode ?? nextRunMode,
          lastError: null
        })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to update tool availability.'
        set((state) => ({
          config: state.config
            ? { ...state.config, enabledTools: previousEnabledTools, runMode: previousRunMode }
            : state.config,
          enabledTools: previousEnabledTools,
          runMode: previousRunMode,
          lastError: message
        }))
        throw error
      }
    },

    setRunMode: async (runMode: RunModeId) => {
      if (runMode === 'custom') return
      await get().setEnabledTools(resolveRunModeEnabledTools(runMode))
    },

    setActiveThread: (id, scrollToMessageId) => {
      const { messages } = get()

      set((state) => {
        const nextState = {
          ...state,
          activeThreadId: id,
          activeEssentialId: null,
          pendingModelOverride: null,
          pendingAcpBinding: null,
          pendingWorkspacePath: null,
          editingMessage: state.editingMessage?.threadId === id ? state.editingMessage : null,
          justDoneRunIdsByThread: setThreadStringValue(state.justDoneRunIdsByThread, id, null),
          ...withFilterBase(state.sidebarFilter, 'all'),
          scrollToMessageId: scrollToMessageId ?? null
        }

        return {
          ...nextState,
          ...deriveActiveThreadRunState(nextState)
        }
      })
      void refreshAvailableSkills(set, get)

      // Load thread data on-demand. Messages and tool calls are loaded only when
      // not yet in memory; runs are always refreshed so the run history sidebar
      // shows the full list from the database.
      if (typeof window !== 'undefined' && window.api?.yachiyo?.loadThreadData) {
        const needsMessages = !messages[id]?.length
        if (needsMessages) {
          console.log(`[setActiveThread] loading thread data for ${id}`)
        }
        void window.api.yachiyo.loadThreadData({ threadId: id }).then((data) => {
          set((state) => {
            const toolCalls = needsMessages
              ? { ...state.toolCalls, [id]: data.toolCalls }
              : state.toolCalls
            return {
              ...(needsMessages ? { messages: { ...state.messages, [id]: data.messages } } : {}),
              toolCalls,
              ...(data.runs ? { runsByThread: { ...state.runsByThread, [id]: data.runs } } : {}),
              ...deriveSubagentStateFromToolCalls(
                toolCalls,
                state.subagentStateById,
                state.subagentProgressTimelineByThread
              )
            }
          })
        })
      }
    },
    setScrollToMessageId: (messageId) => set({ scrollToMessageId: messageId }),
    clearScrollToMessageId: () => set({ scrollToMessageId: null }),
    setComposerEnabledSkillNames: (enabledSkillNames) =>
      set((state) => {
        const draftKey = getComposerDraftKey(state.activeThreadId)
        return {
          composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
            ...draft,
            enabledSkillNames: enabledSkillNames ? normalizeSkillNames(enabledSkillNames) : null
          }))
        }
      }),

    setComposerReasoningEffort: (reasoningEffort) => {
      if (!isComposerReasoningSelection(reasoningEffort)) {
        return
      }

      const threadId = get().activeThreadId
      set((state) => {
        const draftKey = getComposerDraftKey(state.activeThreadId)
        return {
          reasoningEffortByThread: {
            ...state.reasoningEffortByThread,
            [draftKey]: reasoningEffort
          }
        }
      })

      if (
        threadId &&
        typeof window !== 'undefined' &&
        window.api?.yachiyo?.setThreadReasoningEffort
      ) {
        void window.api.yachiyo
          .setThreadReasoningEffort({ threadId, reasoningEffort })
          .then((updatedThread) => {
            set((state) => ({
              reasoningEffortByThread: setReasoningEffortValue(
                state.reasoningEffortByThread,
                updatedThread.id,
                updatedThread.reasoningEffort
              ),
              threads: upsertThread(state.threads, updatedThread)
            }))
          })
          .catch((error) => {
            const message =
              error instanceof Error ? error.message : 'Unable to save thread reasoning effort.'
            set({ lastError: message })
          })
      }
    },

    setActiveArchivedThread: (id) => {
      set((state) => ({
        activeArchivedThreadId: id,
        justDoneRunIdsByThread: setThreadStringValue(state.justDoneRunIdsByThread, id, null),
        ...withFilterBase(state.sidebarFilter, 'archived')
      }))
      // Mark as read when the user opens an archived thread.
      void window.api.yachiyo.markThreadAsRead({ threadId: id }).then((updated) => {
        set((state) => ({
          archivedThreads: state.archivedThreads.map((t) => (t.id === id ? updated : t))
        }))
      })
    },

    openThreadFromNotification: (id, target = 'thread') => {
      const isArchived =
        target === 'archivedThread' || get().archivedThreads.some((t) => t.id === id)
      if (isArchived) {
        get().setActiveArchivedThread(id)
      } else {
        get().setActiveThread(id)
      }
    },

    setThreadListMode: (mode) =>
      set((state) => ({
        activeArchivedThreadId:
          mode === 'archived'
            ? (state.activeArchivedThreadId ?? state.archivedThreads[0]?.id ?? null)
            : state.activeArchivedThreadId,
        activeThreadId:
          mode === 'active'
            ? (state.activeThreadId ?? state.threads[0]?.id ?? null)
            : state.activeThreadId,
        ...withFilterBase(state.sidebarFilter, mode === 'archived' ? 'archived' : 'all')
      })),

    setSidebarFilterBase: (base) => {
      set((state) => {
        const next = { ...state.sidebarFilter, base }
        saveSidebarFilter(next)
        return {
          ...withFilterBase(next, base),
          activeArchivedThreadId:
            base === 'archived'
              ? (state.activeArchivedThreadId ?? state.archivedThreads[0]?.id ?? null)
              : state.activeArchivedThreadId,
          activeThreadId:
            base === 'all'
              ? (state.activeThreadId ?? state.threads[0]?.id ?? null)
              : state.activeThreadId
        }
      })
    },

    toggleSidebarFilterColor: (colorTag) =>
      set((state) => {
        const next = { ...state.sidebarFilter, colorTags: new Set(state.sidebarFilter.colorTags) }
        if (next.colorTags.has(colorTag)) next.colorTags.delete(colorTag)
        else next.colorTags.add(colorTag)
        saveSidebarFilter(next)
        return { sidebarFilter: next, threadListMode: deriveThreadListMode(next) }
      }),

    toggleSidebarFilterWorkspace: (workspacePath) =>
      set((state) => {
        const next = {
          ...state.sidebarFilter,
          workspacePaths: new Set(state.sidebarFilter.workspacePaths)
        }
        if (next.workspacePaths.has(workspacePath)) next.workspacePaths.delete(workspacePath)
        else next.workspacePaths.add(workspacePath)
        saveSidebarFilter(next)
        return { sidebarFilter: next, threadListMode: deriveThreadListMode(next) }
      }),

    toggleSidebarFilterRunning: () =>
      set((state) => {
        const next = { ...state.sidebarFilter, running: !state.sidebarFilter.running }
        saveSidebarFilter(next)
        return { sidebarFilter: next, threadListMode: deriveThreadListMode(next) }
      }),

    toggleSidebarFilterJustDone: () =>
      set((state) => {
        const next = { ...state.sidebarFilter, justDone: !state.sidebarFilter.justDone }
        saveSidebarFilter(next)
        return { sidebarFilter: next, threadListMode: deriveThreadListMode(next) }
      }),

    toggleSidebarFilterFolderOnly: () =>
      set((state) => {
        const next = { ...state.sidebarFilter, folderOnly: !state.sidebarFilter.folderOnly }
        saveSidebarFilter(next)
        return { sidebarFilter: next, threadListMode: deriveThreadListMode(next) }
      }),

    clearSidebarFilter: () => {
      saveSidebarFilter(DEFAULT_SIDEBAR_FILTER)
      set({ sidebarFilter: DEFAULT_SIDEBAR_FILTER, threadListMode: 'active' })
    },

    toggleShowExternalThreads: () => {
      const { showExternalThreads } = get()
      if (!showExternalThreads) {
        void window.api.yachiyo.listExternalThreads().then((records) => {
          set({ externalThreads: records, showExternalThreads: true })
        })
      } else {
        set({ externalThreads: [], showExternalThreads: false })
      }
    },

    setComposerValue: (value) =>
      set((state) => {
        const draftKey = getComposerDraftKey(state.activeThreadId)

        return {
          composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
            ...draft,
            text: value
          }))
        }
      }),

    mergeBufferedPayloadIntoDraft: (payload, targetThreadId) =>
      set((state) => {
        const draftKey = getComposerDraftKey(
          targetThreadId !== undefined ? targetThreadId : state.activeThreadId
        )
        const makeId = (): string =>
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random()}`

        const newImageDrafts: ComposerImageDraft[] = payload.images.map((img) => ({
          id: makeId(),
          dataUrl: img.dataUrl,
          mediaType: img.mediaType,
          ...(img.filename !== undefined ? { filename: img.filename } : {}),
          status: 'ready'
        }))
        const newFileDrafts: ComposerFileDraft[] = payload.attachments.map((att) => ({
          id: makeId(),
          filename: att.filename,
          mediaType: att.mediaType,
          dataUrl: att.dataUrl,
          status: 'ready'
        }))

        return {
          composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => {
            // Buffered content predates the live draft; prepend it with a
            // newline so both segments remain editable and in order.
            const mergedText =
              draft.text.length > 0 && payload.content.length > 0
                ? `${payload.content}\n${draft.text}`
                : payload.content.length > 0
                  ? payload.content
                  : draft.text
            // Keep the live draft's skill selection. The staged payload predates
            // the current draft, so if the user adjusted skills for the new
            // draft those choices must win; on send, the merged content will be
            // scoped by the selection that is live at that moment.
            return {
              ...draft,
              text: mergedText,
              images: [...draft.images, ...newImageDrafts],
              files: [...draft.files, ...newFileDrafts]
            }
          })
        }
      }),

    setPendingAcpBinding: (binding) => {
      set({ pendingAcpBinding: binding })
    },

    setPendingWorkspacePath: (workspacePath) => {
      set({
        pendingWorkspacePath: normalizeWorkspacePath(workspacePath)
      })
      void refreshAvailableSkills(set, get)
    },

    setThreadWorkspace: async (workspacePath, targetThreadId) => {
      const threadId = targetThreadId ?? get().activeThreadId
      if (!threadId) {
        set({
          pendingWorkspacePath: normalizeWorkspacePath(workspacePath)
        })
        await refreshAvailableSkills(set, get)
        return
      }

      try {
        const thread = await window.api.yachiyo.updateThreadWorkspace({
          threadId,
          workspacePath: normalizeWorkspacePath(workspacePath)
        })
        set((state) => {
          const nextState: Partial<AppState> = {
            lastError: null
          }

          if (isExternalThread(thread)) {
            nextState.externalThreads = sortThreads([
              thread,
              ...state.externalThreads.filter((item) => item.id !== thread.id)
            ])
          } else {
            nextState.threads = upsertThread(state.threads, thread)
          }

          return nextState
        })
        if (get().activeThreadId === threadId) {
          await refreshAvailableSkills(set, get)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to change the workspace.'
        set({ lastError: message })
        throw error
      }
    },

    toggleEnabledTool: async (toolName) => {
      await get().setEnabledTools(toggleEnabledTools(get().enabledTools, toolName))
    },

    upsertComposerImage: (image, threadId) =>
      set((state) => {
        const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)
        const currentDraft = state.composerDrafts[draftKey] ?? EMPTY_COMPOSER_DRAFT
        const existingIndex = currentDraft.images.findIndex((entry) => entry.id === image.id)

        if (existingIndex === -1 && image.status !== 'loading') {
          return state
        }

        const images =
          existingIndex === -1
            ? [...currentDraft.images, image]
            : currentDraft.images.map((entry, index) => (index === existingIndex ? image : entry))

        return {
          composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
            ...draft,
            images
          }))
        }
      }),

    upsertComposerFile: (file, threadId) =>
      set((state) => {
        const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)
        const currentDraft = state.composerDrafts[draftKey] ?? EMPTY_COMPOSER_DRAFT
        const existingIndex = currentDraft.files.findIndex((entry) => entry.id === file.id)

        if (existingIndex === -1 && file.status !== 'loading') {
          return state
        }

        const files =
          existingIndex === -1
            ? [...currentDraft.files, file]
            : currentDraft.files.map((entry, index) => (index === existingIndex ? file : entry))

        return {
          composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
            ...draft,
            files
          }))
        }
      }),

    removeComposerFile: (fileId, threadId) =>
      set((state) => {
        const draftKey = getComposerDraftKey(threadId ?? state.activeThreadId)

        return {
          composerDrafts: updateComposerDraft(state.composerDrafts, draftKey, (draft) => ({
            ...draft,
            files: draft.files.filter((file) => file.id !== fileId)
          }))
        }
      })
  }
}
