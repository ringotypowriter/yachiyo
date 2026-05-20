import type { Message } from '../../types.ts'
import { hasMessagePayload } from '../../../../../shared/yachiyo/messageContent.ts'
import { normalizeSkillNames } from '../../../../../shared/yachiyo/protocol.ts'
import { collectDescendantIds } from '../../../../../shared/yachiyo/threadTree.ts'
import type { AppState } from '../useAppStore.ts'
import {
  appendPendingSteer,
  clearRecapForThread,
  deriveActiveThreadRunState,
  getComposerDraft,
  getComposerDraftKey,
  getComposerReasoningEffort,
  getThreadActiveRunId,
  moveComposerDraft,
  moveReasoningEffort,
  normalizeWorkspacePath,
  removeComposerDraft,
  removePendingSteerMessage,
  removeThread,
  replaceMessage,
  resolveEffectiveEnabledSkillNames,
  setThreadRunPhaseValue,
  setThreadRunStatusValue,
  setThreadStringValue,
  toReadyFileAttachments,
  toReadyMessageImages,
  upsertThread,
  withFilterBase
} from './helpers.ts'

const SEND_DEDUP_WINDOW_MS = 1500
let sendInFlight = false
let lastSendFingerprint: string | null = null
let lastSendAt = 0

export function createSendMessageActions(input: {
  set: (partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void
  get: () => AppState
}): Pick<AppState, 'sendMessage'> {
  const { set, get } = input

  return {
    sendMessage: async (mode = 'normal', override) => {
      // Guard against accidental double-submits (double Enter, key repeat,
      // Composer remount during steer, etc). Module-level so it survives
      // component lifecycles. Combines an in-flight lock with a content+thread
      // fingerprint within a recency window.
      if (sendInFlight) return false
      const currentState = get()
      const draft = getComposerDraft(currentState)
      const trimmed = override ? override.content.trim() : draft.text.trim()
      const images = override ? override.images : toReadyMessageImages(draft.images)
      const attachments = override ? override.attachments : toReadyFileAttachments(draft.files)

      // Reject locally-invalid drafts BEFORE arming the dedup window. Otherwise
      // an invalid attempt would poison the window and silently drop the user's
      // immediate retry after they fix the draft. The override path (e.g. input
      // buffer flush) carries an already-ready payload so the draft status
      // checks do not apply.
      if (!override) {
        if (
          draft.images.some((image) => image.status === 'loading' || image.status === 'failed') ||
          draft.files.some((file) => file.status === 'loading' || file.status === 'failed') ||
          !hasMessagePayload({ content: trimmed, images, attachments })
        ) {
          return false
        }
      } else if (!hasMessagePayload({ content: trimmed, images, attachments })) {
        return false
      }

      const planRevisionThreadId = (() => {
        if (override || mode !== 'normal' || !currentState.activeThreadId) return null
        const planDocument = currentState.planDocumentsByThread[currentState.activeThreadId]
        return planDocument?.decision === 'pending' || planDocument?.decision === 'rejected'
          ? currentState.activeThreadId
          : null
      })()
      if (
        planRevisionThreadId &&
        currentState.planDocumentsByThread[planRevisionThreadId]?.decision === 'pending'
      ) {
        await get().rejectPlanDocument(planRevisionThreadId)
      }

      const fingerprint = JSON.stringify({
        t: currentState.activeThreadId,
        m: mode,
        c: trimmed,
        iN: images.length,
        aN: attachments.length
      })
      const fpNow = Date.now()
      if (
        trimmed.length > 0 &&
        lastSendFingerprint === fingerprint &&
        fpNow - lastSendAt < SEND_DEDUP_WINDOW_MS
      ) {
        return false
      }
      lastSendFingerprint = fingerprint
      lastSendAt = fpNow
      sendInFlight = true
      if (currentState.activeThreadId) {
        clearRecapForThread(set, get, currentState.activeThreadId)
      }
      try {
        const enabledTools = currentState.enabledTools
        const runMode = planRevisionThreadId ? 'plan' : currentState.runMode
        const enabledSkillNames = override
          ? normalizeSkillNames(override.enabledSkillNames ?? currentState.config?.skills?.enabled)
          : resolveEffectiveEnabledSkillNames({
              config: currentState.config,
              draft
            })
        // Whether the caller explicitly scoped skills (null = use defaults).
        // Mirrors the draft.enabledSkillNames !== null semantics for overrides.
        const hasExplicitSkillNames = override
          ? override.enabledSkillNames !== undefined && override.enabledSkillNames !== null
          : draft.enabledSkillNames !== null

        // Override carries an explicit threadId; never fall back to
        // activeThreadId for override sends, so the payload cannot be
        // delivered into a thread the user switched to mid-flush.
        let threadId: string | null = override ? override.threadId : currentState.activeThreadId
        const reasoningEffort =
          override?.reasoningEffort ?? getComposerReasoningEffort(currentState, threadId)
        const workspacePath = normalizeWorkspacePath(
          threadId
            ? currentState.threads.find((thread) => thread.id === threadId)?.workspacePath
            : currentState.pendingWorkspacePath
        )

        if (!threadId && mode !== 'normal') {
          return false
        }

        if (!threadId) {
          const essentialId = currentState.activeEssentialId
          const essential = essentialId
            ? currentState.config?.essentials?.find((entry) => entry.id === essentialId)
            : undefined
          const pendingModel = currentState.pendingModelOverride
          const pendingAcp = currentState.pendingAcpBinding
          const pendingReasoningEffort =
            currentState.reasoningEffortByThread[getComposerDraftKey(null)]
          const thread = await window.api.yachiyo.createThread({
            ...(workspacePath ? { workspacePath } : {}),
            ...(essentialId ? { createdFromEssentialId: essentialId } : {}),
            ...(essential?.privacyMode ? { privacyMode: true } : {}),
            ...(pendingReasoningEffort ? { reasoningEffort: pendingReasoningEffort } : {})
          })

          // Commit local state first so the thread is visible even if setup calls fail.
          if (pendingModel) thread.modelOverride = pendingModel
          if (pendingAcp) thread.runtimeBinding = pendingAcp
          if (pendingReasoningEffort) thread.reasoningEffort = pendingReasoningEffort
          if (essential?.privacyMode) {
            thread.privacyMode = true
          }
          if (essential?.icon && essential.iconType === 'emoji') {
            thread.icon = essential.icon
          }

          set((state) => ({
            activeThreadId: thread.id,
            activeEssentialId: null,
            pendingModelOverride: null,
            pendingAcpBinding: null,
            pendingWorkspacePath: null,
            ...withFilterBase(state.sidebarFilter, 'all'),
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
            messages: {
              ...state.messages,
              [thread.id]: state.messages[thread.id] ?? []
            },
            toolCalls: {
              ...state.toolCalls,
              [thread.id]: state.toolCalls[thread.id] ?? []
            },
            threads: upsertThread(state.threads, thread)
          }))
          threadId = thread.id

          // Best-effort: persist model/icon to server. Failures are non-fatal —
          // the thread is already stored locally with the correct values.
          if (pendingModel) {
            window.api.yachiyo
              .setThreadModelOverride({ threadId: thread.id, modelOverride: pendingModel })
              .catch(() => {})
          }
          if (essential?.icon && essential.iconType === 'emoji') {
            window.api.yachiyo
              .setThreadIcon({ threadId: thread.id, icon: essential.icon })
              .catch(() => {})
          }

          // ACP binding must be persisted server-side before sendChat, because the
          // run router reads it from storage to decide whether to use the ACP path.
          if (pendingAcp) {
            const updatedThread = await window.api.yachiyo.setThreadRuntimeBinding({
              threadId: thread.id,
              runtimeBinding: pendingAcp
            })
            set((s) => ({ threads: upsertThread(s.threads, updatedThread) }))
          }
        }

        const editingMessage = currentState.editingMessage
        const isEditMode =
          !override &&
          mode === 'normal' &&
          editingMessage !== null &&
          editingMessage.threadId === threadId

        try {
          const accepted = isEditMode
            ? await window.api.yachiyo.editMessage({
                threadId,
                messageId: editingMessage.messageId,
                content: trimmed,
                enabledTools,
                runMode,
                enabledSkillNames: draft.enabledSkillNames !== null ? enabledSkillNames : undefined,
                reasoningEffort,
                ...(images.length > 0 ? { images } : {}),
                ...(attachments.length > 0 ? { attachments } : {})
              })
            : await window.api.yachiyo.sendChat({
                content: trimmed,
                enabledTools,
                runMode,
                enabledSkillNames:
                  mode === 'follow-up' || hasExplicitSkillNames ? enabledSkillNames : undefined,
                reasoningEffort,
                ...(images.length > 0 ? { images } : {}),
                ...(attachments.length > 0 ? { attachments } : {}),
                ...(mode !== 'normal' ? { mode } : {}),
                threadId
              })

          const threadActiveRunId = getThreadActiveRunId(currentState, threadId)
          const acceptedKind =
            accepted.kind ??
            (mode === 'follow-up'
              ? 'active-run-follow-up'
              : threadActiveRunId
                ? 'active-run-steer'
                : 'run-started')
          const acceptedUserMessage = 'userMessage' in accepted ? accepted.userMessage : null
          const acceptedReplacedMessageId =
            'replacedMessageId' in accepted ? accepted.replacedMessageId : undefined

          set((state) => {
            const nextActiveRequestMessageIdsByThread =
              acceptedKind !== 'active-run-follow-up' && acceptedKind !== 'active-run-steer-pending'
                ? setThreadStringValue(
                    state.activeRequestMessageIdsByThread,
                    accepted.thread.id,
                    acceptedUserMessage?.id ?? null
                  )
                : state.activeRequestMessageIdsByThread

            const nextActiveRunIdsByThread = { ...state.activeRunIdsByThread }
            if (acceptedKind !== 'active-run-follow-up' && accepted.runId) {
              nextActiveRunIdsByThread[accepted.thread.id] = accepted.runId
            }

            const nextMessages =
              acceptedKind === 'active-run-steer-pending'
                ? (state.messages[accepted.thread.id] ?? [])
                : replaceMessage(
                    state.messages[accepted.thread.id] ?? [],
                    acceptedUserMessage as Message,
                    acceptedReplacedMessageId
                  )

            // Edit mode deletes the targeted message and all its descendants
            // before starting a fresh run. The authoritative cleanup arrives
            // via thread.state.replaced, but if that event races with this
            // acceptance handler, stale tool calls from the deleted subtree can
            // linger. Compute the deleted descendant IDs and filter them out here.
            let nextToolCalls = state.toolCalls
            if (isEditMode && acceptedReplacedMessageId) {
              const currentMessages = state.messages[accepted.thread.id] ?? []
              const deletedIds = collectDescendantIds(currentMessages, acceptedReplacedMessageId)
              const filteredToolCalls = (state.toolCalls[accepted.thread.id] ?? []).filter(
                (tc) => !tc.requestMessageId || !deletedIds.has(tc.requestMessageId)
              )
              nextToolCalls = { ...state.toolCalls, [accepted.thread.id]: filteredToolCalls }
            }

            const nextState = {
              ...state,
              activeRequestMessageIdsByThread: nextActiveRequestMessageIdsByThread,
              activeRunIdsByThread: nextActiveRunIdsByThread,
              activeThreadId: accepted.thread.id,
              archivedThreads: removeThread(state.archivedThreads, accepted.thread.id),
              // Preserve the live draft when the payload came from an override
              // (e.g. input buffer flush). The user may already be typing the
              // next message into the composer while the buffered one is
              // sending, and that text must not be discarded.
              composerDrafts: override
                ? state.composerDrafts
                : removeComposerDraft(state.composerDrafts, accepted.thread.id),
              // Buffered flushes are unrelated to any active edit — do not
              // silently abandon an edit the user started after staging.
              editingMessage: override ? state.editingMessage : null,
              lastError: null,
              messages: {
                ...state.messages,
                [accepted.thread.id]: nextMessages
              },
              toolCalls: nextToolCalls,
              pendingSteerMessages:
                acceptedKind === 'active-run-steer-pending'
                  ? {
                      ...state.pendingSteerMessages,
                      [accepted.thread.id]: appendPendingSteer(
                        state.pendingSteerMessages[accepted.thread.id],
                        trimmed,
                        images,
                        draft.files.filter((f) => f.status === 'ready'),
                        draft.enabledSkillNames ?? null
                      )
                    }
                  : acceptedKind === 'active-run-steer'
                    ? removePendingSteerMessage(state.pendingSteerMessages, accepted.thread.id)
                    : state.pendingSteerMessages,
              runPhasesByThread:
                acceptedKind === 'active-run-follow-up' ||
                acceptedKind === 'active-run-steer-pending'
                  ? state.runPhasesByThread
                  : setThreadRunPhaseValue(
                      state.runPhasesByThread,
                      accepted.thread.id,
                      'preparing'
                    ),
              runStatusesByThread:
                acceptedKind === 'active-run-follow-up' ||
                acceptedKind === 'active-run-steer-pending'
                  ? state.runStatusesByThread
                  : setThreadRunStatusValue(
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
          return true
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unable to send the message.'
          // Clear the dedup fingerprint so the user can immediately retry the
          // same prompt after a transient failure.
          lastSendFingerprint = null
          lastSendAt = 0
          set({
            activeThreadId: threadId,
            lastError: message,
            runStatus: 'failed'
          })
          return false
        }
      } finally {
        sendInFlight = false
      }
    }
  }
}
