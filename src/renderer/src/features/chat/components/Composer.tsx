import type React from 'react'
import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  DEFAULT_SETTINGS,
  EMPTY_COMPOSER_DRAFT,
  getEffectiveModel,
  getComposerReasoningEffort,
  useAppStore
} from '@renderer/app/store/useAppStore'
import { getComposerActionState } from '@renderer/features/chat/lib/composerActionState'
import { canRemoveQueuedFollowUp } from '@renderer/features/chat/lib/messageActionState'
import type { ChatInputBufferPayload } from '@renderer/features/chat/lib/chatInputBuffer'
import { useChatInputBuffer } from '@renderer/features/chat/hooks/useChatInputBuffer'
import { computePretextLines } from '@renderer/features/chat/lib/pretextSync'
import {
  forwardComposerWheelToTimeline,
  resolveComposerWheelDestination,
  resolveWheelScrollOffset
} from '@renderer/features/chat/lib/composerWheel'
import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD,
  getThreadCapabilities,
  normalizeSkillNames,
  type MessageImageRecord,
  type SendChatAttachment
} from '../../../../../shared/yachiyo/protocol.ts'
import { getReasoningSelectorState } from '../../../../../shared/yachiyo/reasoningEffort.ts'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { useAppDialog } from '@renderer/components/AppDialogContext'
import { selectContextPromptTokens } from '@renderer/lib/contextPromptTokens'
import { estimateDraftPromptTokens } from '@renderer/lib/estimatePromptTokens'
import {
  canChangeThreadWorkspace,
  isFreshHandoffWorkspaceThread
} from '../../../../../shared/yachiyo/threadWorkspaceRules.ts'
import {
  COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX,
  MAX_COMPOSER_FILES,
  MAX_COMPOSER_IMAGES,
  NEW_THREAD_DRAFT_KEY,
  EMPTY_MESSAGES,
  EMPTY_RUNS,
  getWorkspaceHint,
  type AttachmentUploadNotice,
  type PendingWorkspaceChangeConfirmation
} from './Composer/support.tsx'
import { ComposerView } from './Composer/ComposerView.tsx'
import { useComposerCompletions } from './Composer/useComposerCompletions.ts'
import { useComposerInputHandlers } from './Composer/useComposerInputHandlers.ts'

export function Composer({
  onSelectThreadOperation
}: {
  onSelectThreadOperation?: (key: ThreadContextOperationKey) => void
}): React.JSX.Element {
  const dialog = useAppDialog()
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const composerDraft = useAppStore(
    (s) => s.composerDrafts[s.activeThreadId ?? NEW_THREAD_DRAFT_KEY] ?? EMPTY_COMPOSER_DRAFT
  )
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const availableSkills = useAppStore((s) => s.availableSkills)
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)
  const effectiveModel = useAppStore(useShallow(getEffectiveModel))
  const composerReasoningEffort = useAppStore(useShallow(getComposerReasoningEffort))
  const activeRunId = useAppStore((s) =>
    s.activeThreadId ? (s.activeRunIdsByThread[s.activeThreadId] ?? null) : null
  )
  const runStatus = useAppStore((s) =>
    s.activeThreadId ? (s.runStatusesByThread[s.activeThreadId] ?? 'idle') : 'idle'
  )
  const threadIsSaving = useAppStore((s) =>
    s.activeThreadId ? s.savingThreadIds.has(s.activeThreadId) : false
  )
  const config = useAppStore((s) => s.config)
  const activeThreadMessageState = useAppStore(
    useShallow((s) => {
      const messages = s.activeThreadId
        ? (s.messages[s.activeThreadId] ?? EMPTY_MESSAGES)
        : EMPTY_MESSAGES
      return {
        activeThreadMessageCount: messages.length,
        isFreshHandoffWorkspace:
          s.activeThreadId !== null &&
          isFreshHandoffWorkspaceThread({
            messages,
            threadCreatedAt: null
          }),
        isWorkspaceLocked:
          s.activeThreadId !== null &&
          !canChangeThreadWorkspace({
            messages,
            threadCreatedAt: null
          })
      }
    })
  )
  const pendingWorkspacePath = useAppStore((s) => s.pendingWorkspacePath)
  const pendingAcpBinding = useAppStore((s) => s.pendingAcpBinding)
  const setPendingAcpBinding = useAppStore((s) => s.setPendingAcpBinding)
  const runPhase = useAppStore((s) =>
    s.activeThreadId ? (s.runPhasesByThread[s.activeThreadId] ?? 'idle') : 'idle'
  )
  const cancelActiveRun = useAppStore((s) => s.cancelActiveRun)
  const latestRun = useAppStore((s) =>
    s.activeThreadId ? (s.latestRunsByThread[s.activeThreadId] ?? null) : null
  )
  const activeThreadRuns = useAppStore((s) =>
    s.activeThreadId ? (s.runsByThread[s.activeThreadId] ?? EMPTY_RUNS) : EMPTY_RUNS
  )
  const enabledTools = useAppStore((s) => s.enabledTools)
  const editingMessage = useAppStore((s) => (s.activeThreadId ? s.editingMessage : null))
  const cancelEditMessage = useAppStore((s) => s.cancelEditMessage)
  const removeComposerImage = useAppStore((s) => s.removeComposerImage)
  const removeComposerFile = useAppStore((s) => s.removeComposerFile)
  const pendingSteerEntry = useAppStore((s) =>
    s.activeThreadId ? (s.pendingSteerMessages[s.activeThreadId] ?? null) : null
  )
  const revertPendingSteer = useAppStore((s) => s.revertPendingSteer)
  const revertQueuedFollowUp = useAppStore((s) => s.revertQueuedFollowUp)
  const deleteMessage = useAppStore((s) => s.deleteMessage)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const selectModel = useAppStore((s) => s.selectModel)
  const pushToast = useAppStore((s) => s.pushToast)
  const setComposerEnabledSkillNames = useAppStore((s) => s.setComposerEnabledSkillNames)
  const setComposerReasoningEffort = useAppStore((s) => s.setComposerReasoningEffort)
  const mergeBufferedPayloadIntoDraft = useAppStore((s) => s.mergeBufferedPayloadIntoDraft)
  const setComposerValue = useAppStore((s) => s.setComposerValue)
  const setThreadWorkspace = useAppStore((s) => s.setThreadWorkspace)
  const toggleEnabledTool = useAppStore((s) => s.toggleEnabledTool)
  const threads = useAppStore((s) => s.threads)
  const upsertComposerImage = useAppStore((s) => s.upsertComposerImage)
  const upsertComposerFile = useAppStore((s) => s.upsertComposerFile)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // Lock the composer while a send is in flight. Each send invocation gets a
  // UUID; the lock clears only when that exact send resolves. Prevents
  // duplicate steer/follow-up messages from rapid Enter presses or double key
  // events while the server is mid-accept.
  const inFlightSendIdRef = useRef<string | null>(null)
  const [isSendInFlight, setIsSendInFlight] = useState(false)
  const [isCancelInFlight, setIsCancelInFlight] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLDivElement>(null)
  const popupContainerRef = useRef<HTMLDivElement>(null)
  const modelSelectorRef = useRef<HTMLDivElement>(null)
  const reasoningSelectorRef = useRef<HTMLDivElement>(null)
  const skillsSelectorRef = useRef<HTMLDivElement>(null)
  const toolSelectorRef = useRef<HTMLDivElement>(null)
  const workspaceSelectorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentStripRef = useRef<HTMLDivElement>(null)
  /** Set when the user inserts a hard/soft line break so we scroll after layout (hidden native caret). */
  const scrollComposerToEndAfterBreakRef = useRef(false)
  /** True when any composer popup is open; used by the auto-focus keydown listener. */
  const anyPopupOpenRef = useRef(false)
  const composerRootRef = useRef<HTMLDivElement>(null)

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [reasoningSelectorOpen, setReasoningSelectorOpen] = useState(false)
  const [skillsSelectorOpen, setSkillsSelectorOpen] = useState(false)
  const [toolSelectorOpen, setToolSelectorOpen] = useState(false)
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(false)
  const [workspaceHintHovered, setWorkspaceHintHovered] = useState(false)
  const [workspaceHintPinned, setWorkspaceHintPinned] = useState(false)
  const [attachmentUploadNotice, setAttachmentUploadNotice] =
    useState<AttachmentUploadNotice | null>(null)
  const [isBackendSwitchPending, setIsBackendSwitchPending] = useState(false)
  const [pendingWorkspaceChangeConfirmation, setPendingWorkspaceChangeConfirmation] =
    useState<PendingWorkspaceChangeConfirmation | null>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [isTextareaFocused, setIsTextareaFocused] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const inputBufferDurable = config?.chat?.inputBufferEnabled === true
  // Session-local override: starts from the durable setting, follows durable
  // changes, but any in-session flip stays in component memory only.
  const [inputBufferSession, setInputBufferSession] = useState(inputBufferDurable)
  useEffect(() => {
    setInputBufferSession(inputBufferDurable)
  }, [inputBufferDurable])
  const dragCounterRef = useRef(0)
  // Pretext-driven overlay lines — overlay renders these instead of letting CSS wrap.
  // Guarantees the visible text breaks at the same positions pretext uses for the caret.
  const [overlayLineTexts, setOverlayLineTexts] = useState<string[] | null>(null)
  // Custom selection range for the pretext-driven overlay (native ::selection is hidden).
  const [overlaySelRange, setOverlaySelRange] = useState<[number, number] | null>(null)
  const composerValue = composerDraft.text
  const draftImages = composerDraft.images
  const draftFiles = composerDraft.files
  const readyImageCount = draftImages.filter((image) => image.status === 'ready').length
  const readyFileCount = draftFiles.filter((file) => file.status === 'ready').length
  const hasLoadingImages = draftImages.some((image) => image.status === 'loading')
  const hasLoadingFiles = draftFiles.some((file) => file.status === 'loading')
  const hasFailedImages = draftImages.some((image) => image.status === 'failed')
  const hasFailedFiles = draftFiles.some((file) => file.status === 'failed')
  const hasPayload = composerValue.trim().length > 0 || readyImageCount > 0 || readyFileCount > 0
  const canAddImages = draftImages.length < MAX_COMPOSER_IMAGES
  const canAddFiles = draftFiles.length < MAX_COMPOSER_FILES
  const hasActiveRun = activeRunId !== null

  const estimatedDraftTokens = useMemo(() => {
    return estimateDraftPromptTokens({
      text: composerValue,
      imageCount: draftImages.filter((image) => image.status === 'ready').length,
      files: draftFiles.filter((file) => file.status === 'ready')
    })
  }, [composerValue, draftImages, draftFiles])

  // Clear cancel-in-flight when the run actually ends. Delay slightly so that
  // if a queued follow-up starts immediately after cancellation the composer
  // doesn't flicker from stop → send → stop.
  useEffect(() => {
    if (!hasActiveRun) {
      const timer = setTimeout(() => setIsCancelInFlight(false), 100)
      return () => clearTimeout(timer)
    }
    setIsCancelInFlight(false)
    return undefined
  }, [hasActiveRun])

  useEffect(() => {
    if (!attachmentUploadNotice) {
      return undefined
    }

    const timer = setTimeout(() => setAttachmentUploadNotice(null), 5000)
    return () => clearTimeout(timer)
  }, [attachmentUploadNotice])

  const defaultEnabledSkillNames = useMemo(() => {
    const enabledNames = normalizeSkillNames(config?.skills?.enabled)
    const disabledNames = new Set(normalizeSkillNames(config?.skills?.disabled))
    const result: string[] = []
    for (const skill of availableSkills) {
      if (skill.autoEnabled && !disabledNames.has(skill.name)) {
        result.push(skill.name)
      }
    }
    for (const name of enabledNames) {
      if (!result.includes(name)) {
        result.push(name)
      }
    }
    return result
  }, [config?.skills?.enabled, config?.skills?.disabled, availableSkills])
  const effectiveEnabledSkillNames = composerDraft.enabledSkillNames ?? defaultEnabledSkillNames
  const hasCustomSkillOverride =
    composerDraft.enabledSkillNames !== null && composerDraft.enabledSkillNames !== undefined
  const enabledSkillCount = effectiveEnabledSkillNames.length
  const displayPromptTokens = selectContextPromptTokens({
    latestRun,
    runs: activeThreadRuns
  })
  const placeholderRunId = activeRunId ?? latestRun?.id ?? null
  const matchedPlaceholderRunIndex =
    placeholderRunId === null
      ? -1
      : activeThreadRuns.findIndex((run) => run.id === placeholderRunId)
  const placeholderRunIndex = matchedPlaceholderRunIndex >= 0 ? matchedPlaceholderRunIndex : null
  const hasRunStatsText = displayPromptTokens != null || estimatedDraftTokens > 0
  const showRunStats = hasActiveRun || hasRunStatsText
  const stripCompactThresholdTokens =
    config?.chat?.stripCompactThresholdTokens ?? DEFAULT_STRIP_COMPACT_TOKEN_THRESHOLD
  const externalThreads = useAppStore((s) => s.externalThreads)
  const activeThread =
    threads.find((thread) => thread.id === activeThreadId) ??
    externalThreads.find((thread) => thread.id === activeThreadId) ??
    null
  const queuedFollowUpMessageIdFromThread = activeThread?.queuedFollowUpMessageId ?? null
  const queuedFollowUpMessage = useAppStore((s) => {
    if (!activeThreadId || !queuedFollowUpMessageIdFromThread) return null
    return (
      (s.messages[activeThreadId] ?? EMPTY_MESSAGES).find(
        (message) => message.id === queuedFollowUpMessageIdFromThread
      ) ?? null
    )
  })
  const queuedFollowUpMessageId =
    queuedFollowUpMessage?.id ?? activeThread?.queuedFollowUpMessageId ?? null
  const queuedFollowUpCanRemove = activeThread
    ? canRemoveQueuedFollowUp({ threadCapabilities: getThreadCapabilities(activeThread) })
    : false
  const { activeThreadMessageCount, isFreshHandoffWorkspace, isWorkspaceLocked } =
    activeThreadMessageState
  const currentWorkspacePath = activeThread?.workspacePath ?? pendingWorkspacePath
  const activeAcpBinding =
    activeThread?.runtimeBinding?.kind === 'acp' ? activeThread.runtimeBinding : null
  // For a brand-new thread (no activeThreadId yet) the user may have picked an ACP agent
  // from the model selector. Show it in the toolbar and allow send until a thread exists.
  const effectiveAcpBinding =
    activeAcpBinding ?? (activeThreadId === null ? pendingAcpBinding : null)
  const isModelSelectorLocked =
    isBackendSwitchPending || runPhase === 'preparing' || runPhase === 'streaming'
  const needsApiKey = settings.provider !== 'vertex' && settings.provider !== 'openai-codex'
  const needsCodexSession =
    settings.provider === 'openai-codex' && !settings.codexSessionPath?.trim()
  const isConfigured =
    ((!needsApiKey || settings.apiKey.trim().length > 0) &&
      !needsCodexSession &&
      effectiveModel.model.trim().length > 0) ||
    effectiveAcpBinding !== null
  const savedWorkspacePaths = useMemo(
    () => config?.workspace?.savedPaths ?? [],
    [config?.workspace]
  )
  const workspaceHint = getWorkspaceHint({
    isWorkspaceLocked,
    workspacePath: currentWorkspacePath
  })
  const showWorkspaceHint = !workspaceSelectorOpen && (workspaceHintHovered || workspaceHintPinned)
  const threadIsBusy = threadIsSaving || isBackendSwitchPending

  const {
    activeSkillTag,
    atSkillPrefixMatch,
    dismissSlashPopup,
    fileMentionAnchorRect,
    fileMentionMatch,
    fileMentionMatchesState,
    fileMentionQuery,
    fileMentionRawQuery,
    isFileMentionSearchPending,
    loadMoreFileMentionMatches,
    matchingSlashCommands,
    showSlashCommandPopup,
    skillQuery,
    slashQuery,
    slashSelectedIndex,
    setSlashSelectedIndex,
    validatedFileTags,
    canRunThreadOperations,
    canHandoffActiveThread,
    commitWorkspaceSelection,
    requestWorkspaceSelection,
    userPrompts
  } = useComposerCompletions({
    activeThreadId,
    activeThread,
    availableSkills,
    anyPopupOpenRef,
    composerValue,
    config,
    currentWorkspacePath,
    isFreshHandoffWorkspace,
    modelSelectorOpen,
    pendingWorkspaceChangeConfirmation,
    reasoningSelectorOpen,
    runStatus,
    savedWorkspacePaths,
    setPendingWorkspaceChangeConfirmation,
    setThreadWorkspace,
    setWorkspaceHintPinned,
    skillsSelectorOpen,
    textareaRef,
    toolSelectorOpen,
    workspaceHintPinned,
    workspaceSelectorOpen
  })
  const runBackendSwitch = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setIsBackendSwitchPending(true)
    try {
      await action()
    } finally {
      setIsBackendSwitchPending(false)
    }
  }, [])

  const notifyAcpRebindBlocked = useCallback((): void => {
    if (!activeThreadId) {
      return
    }

    pushToast({
      threadId: activeThreadId,
      title: 'Start a new ACP thread',
      body: 'ACP agents can only be attached before a thread has any messages.',
      eventKey: `acp-bind-blocked:${activeThreadId}`
    })
  }, [activeThreadId, pushToast])

  const { canSend: canSendBase, showStopButton } = getComposerActionState({
    connectionStatus,
    hasActiveRun,
    hasFailedImages: hasFailedImages || hasFailedFiles,
    hasLoadingImages: hasLoadingImages || hasLoadingFiles,
    hasPayload,
    threadIsSaving: threadIsBusy,
    isConfigured
  })
  const canSend = canSendBase && !isSendInFlight && !isCancelInFlight

  // Buffering only runs on real threads. In the new-thread composer we don't
  // have a stable target yet; forcing a staged payload through sendMessage's
  // new-thread path would create the thread before the send attempt, which
  // leaks state on failure and races with the user switching threads.
  const inputBufferApplicable =
    inputBufferSession && !hasActiveRun && editingMessage === null && activeThreadId !== null

  // Buffered flush sends the merged payload directly via the send override so
  // the user's in-progress draft (text typed AFTER staging) is never
  // overwritten or cleared by the send pipeline.
  const handleBufferedFlush = useCallback(
    async (payload: ChatInputBufferPayload) => {
      // Propagate sendMessage's boolean so the buffer hook can re-stage the
      // payload when the send was skipped (in-flight lock, dedup) or failed
      // outright. sourceThreadId pins the delivery to the thread where the
      // payload was composed regardless of where the user is now.
      return await sendMessage('normal', {
        content: payload.content,
        images: payload.images,
        attachments: payload.attachments,
        enabledSkillNames: payload.enabledSkillNames ?? null,
        reasoningEffort: payload.reasoningEffort,
        threadId: payload.sourceThreadId
      })
    },
    [sendMessage]
  )

  const inputBuffer = useChatInputBuffer({ onFlush: handleBufferedFlush })

  const handleEditQueuedFollowUp = useCallback(() => {
    if (!queuedFollowUpMessageId) return

    void (async () => {
      try {
        await revertQueuedFollowUp(queuedFollowUpMessageId)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : 'Failed to edit queued follow-up.'
        })
      }
    })()
  }, [dialog, queuedFollowUpMessageId, revertQueuedFollowUp])

  const handleRemoveQueuedFollowUp = useCallback(() => {
    void (async () => {
      if (!queuedFollowUpMessageId) return
      const confirmed = await dialog.confirm({
        title: 'Remove this queued follow-up?',
        confirmLabel: 'Remove',
        tone: 'danger'
      })
      if (!confirmed) return

      try {
        await deleteMessage(queuedFollowUpMessageId)
      } catch (error) {
        await dialog.alert({
          title: error instanceof Error ? error.message : 'Failed to remove queued follow-up.'
        })
      }
    })()
  }, [deleteMessage, dialog, queuedFollowUpMessageId])

  const dispatchSend = useCallback(
    (mode: 'normal' | 'steer' | 'follow-up') => {
      if (inFlightSendIdRef.current !== null) return

      if (mode === 'normal' && inputBufferApplicable && activeThreadId !== null) {
        const trimmed = composerValue.trim()
        const readyImages: MessageImageRecord[] = draftImages
          .filter((img) => img.status === 'ready')
          .map((img) => ({
            dataUrl: img.dataUrl,
            mediaType: img.mediaType,
            ...(img.filename !== undefined ? { filename: img.filename } : {})
          }))
        const readyAttachments: SendChatAttachment[] = draftFiles
          .filter((file) => file.status === 'ready')
          .map((file) => ({
            filename: file.filename,
            mediaType: file.mediaType,
            dataUrl: file.dataUrl
          }))
        if (trimmed.length === 0 && readyImages.length === 0 && readyAttachments.length === 0) {
          return
        }
        inputBuffer.stage({
          sourceThreadId: activeThreadId,
          content: trimmed,
          images: readyImages,
          attachments: readyAttachments,
          enabledSkillNames: composerDraft.enabledSkillNames,
          reasoningEffort: composerReasoningEffort
        })
        setComposerValue('')
        for (const img of draftImages) removeComposerImage(img.id)
        for (const file of draftFiles) removeComposerFile(file.id)
        return
      }

      const sendId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`
      inFlightSendIdRef.current = sendId
      setIsSendInFlight(true)
      void (async () => {
        try {
          await sendMessage(mode)
        } finally {
          if (inFlightSendIdRef.current === sendId) {
            inFlightSendIdRef.current = null
            setIsSendInFlight(false)
          }
        }
      })()
    },
    [
      activeThreadId,
      composerReasoningEffort,
      composerDraft.enabledSkillNames,
      composerValue,
      draftFiles,
      draftImages,
      inputBuffer,
      inputBufferApplicable,
      removeComposerFile,
      removeComposerImage,
      sendMessage,
      setComposerValue
    ]
  )

  // When buffering stops being applicable (settings toggle off, active run
  // kicked off, user starts editing) or the user navigates away from the
  // staging thread, move the staged payload back into its source thread's
  // draft so no content is ever silently dropped. `payload.sourceThreadId`
  // is captured at stage time so the merge lands on the correct thread even
  // if `activeThreadId` has already advanced.
  useEffect(() => {
    if (!inputBuffer.staged) return
    const payload = inputBuffer.staged
    const navigatedAway = payload.sourceThreadId !== activeThreadId
    if (!inputBufferApplicable || navigatedAway) {
      inputBuffer.cancel()
      mergeBufferedPayloadIntoDraft(payload, payload.sourceThreadId)
    }
  }, [activeThreadId, inputBufferApplicable, inputBuffer, mergeBufferedPayloadIntoDraft])

  const toggleInputBufferSession = useCallback(() => {
    setInputBufferSession((v) => !v)
  }, [])
  const activeRunEnterBehavior =
    config?.chat?.activeRunEnterBehavior ?? DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
  const primarySendMode = hasActiveRun
    ? effectiveAcpBinding !== null || activeRunEnterBehavior !== 'enter-steers'
      ? 'follow-up'
      : 'steer'
    : 'normal'
  const activeRunHint =
    effectiveAcpBinding !== null
      ? 'Enter to queue follow-up.'
      : activeRunEnterBehavior === 'enter-steers'
        ? 'Enter to steer, Option+Enter to queue follow-up.'
        : 'Option+Enter to steer, Enter to queue follow-up.'

  const composerStatus = (() => {
    if (connectionStatus !== 'connected') {
      return {
        tone: 'error' as const,
        text: 'Local server is unavailable. Reconnect before sending.'
      }
    }

    if (attachmentUploadNotice) {
      return attachmentUploadNotice
    }

    if (!isConfigured) {
      return {
        tone: 'muted' as const,
        text: 'Choose a provider and model in Settings before sending.'
      }
    }

    if (hasLoadingImages || hasLoadingFiles) {
      return {
        tone: 'muted' as const,
        text: hasLoadingFiles ? 'Preparing file...' : 'Preparing image...'
      }
    }

    if (isBackendSwitchPending) {
      return {
        tone: 'muted' as const,
        text: 'Saving backend selection...'
      }
    }

    if (hasFailedImages || hasFailedFiles) {
      return {
        tone: 'error' as const,
        text: hasFailedFiles
          ? 'This file could not be prepared.'
          : 'This image could not be prepared.'
      }
    }

    if (hasActiveRun) {
      return {
        tone: 'muted' as const,
        text: activeRunHint
      }
    }

    return null
  })()

  /**
   * Autogrow uses height:auto to measure — that briefly expands the box and browsers often reset
   * scrollTop. Without restoring scroll (or max-scroll when the user was at the bottom), the
   * viewport jumps to the top while selection stays at the end → fake caret and highlight misalign.
   *
   * When the field is already capped at max height and content still overflows, **do not** set
   * height:auto again: WebKit can report a stale/wrong scrollHeight for one frame and the last
   * logical line (e.g. trailing newline) never scrolls into view. Keep a fixed height and read
   * scrollHeight directly (no padding workaround).
   */
  const resizeTextarea = useCallback((options?: { forceScrollToBottom?: boolean }) => {
    const element = textareaRef.current
    if (!element) {
      return
    }

    // Fast path: when the textarea is empty (e.g. after send), collapse immediately.
    // This avoids stale scrollHeight measurements that can keep the box expanded.
    if (!element.value) {
      element.style.height = 'auto'
      element.style.overflowY = 'hidden'
      element.scrollTop = 0
      if (overlayRef.current) overlayRef.current.scrollTop = 0
      return
    }

    const maxPx = COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX
    const forceToBottom = options?.forceScrollToBottom ?? false
    const eps = 3

    const prevTop = element.scrollTop
    const prevScrollHeight = element.scrollHeight
    const prevClientHeight = element.clientHeight
    const wasScrollable = prevScrollHeight > prevClientHeight + eps
    const wasAtBottom =
      forceToBottom || !wasScrollable || prevTop + prevClientHeight >= prevScrollHeight - eps

    const styleHeightPx = parseFloat(element.style.height)
    const boxLooksMax =
      prevClientHeight >= maxPx - eps ||
      (!Number.isNaN(styleHeightPx) && styleHeightPx >= maxPx - eps)
    const alreadyCappedAndOverflowing = boxLooksMax && prevScrollHeight > prevClientHeight + eps

    if (alreadyCappedAndOverflowing) {
      element.style.height = `${maxPx}px`
      element.style.overflowY = 'auto'
    } else {
      element.style.height = 'auto'
      const fullScrollHeight = element.scrollHeight
      const nextHeight = Math.min(fullScrollHeight, maxPx)
      element.style.height = `${nextHeight}px`
      element.style.overflowY = fullScrollHeight > maxPx ? 'auto' : 'hidden'
    }

    void element.offsetHeight

    const sh = element.scrollHeight
    const ch = element.clientHeight
    if (sh > ch + eps) {
      const maxScroll = sh - ch
      element.scrollTop = wasAtBottom ? maxScroll : Math.min(Math.max(0, prevTop), maxScroll)
    } else {
      element.scrollTop = 0
    }

    if (overlayRef.current) {
      overlayRef.current.scrollTop = element.scrollTop
      // Overlay content includes a trailing-newline sentinel, so its scrollHeight may be
      // larger than the textarea's. When scrolled to bottom, let the overlay reach its own max.
      if (wasAtBottom) {
        const oMax = Math.max(0, overlayRef.current.scrollHeight - overlayRef.current.clientHeight)
        if (oMax > overlayRef.current.scrollTop) {
          overlayRef.current.scrollTop = oMax
        }
      }
    }
  }, [])

  useLayoutEffect(() => {
    const force = scrollComposerToEndAfterBreakRef.current
    scrollComposerToEndAfterBreakRef.current = false
    resizeTextarea({ forceScrollToBottom: force })

    const t = textareaRef.current
    if (!t) return

    const catchUpScrollIfCaretAtEnd = (): void => {
      if (document.activeElement !== t) return
      const o = overlayRef.current
      const tOverflows = t.scrollHeight > t.clientHeight + 3
      const oOverflows = o ? o.scrollHeight > o.clientHeight + 3 : false
      if (!tOverflows && !oOverflows) return
      const len = t.value.length
      if (t.selectionStart !== len || t.selectionEnd !== len) return
      t.scrollTop = t.scrollHeight - t.clientHeight
      if (o) o.scrollTop = Math.max(t.scrollTop, o.scrollHeight - o.clientHeight)
    }

    void t.offsetHeight
    catchUpScrollIfCaretAtEnd()
    let cancelled = false
    const id = requestAnimationFrame(() => {
      if (cancelled) return
      catchUpScrollIfCaretAtEnd()
      requestAnimationFrame(() => {
        if (cancelled) return
        catchUpScrollIfCaretAtEnd()
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [composerValue, resizeTextarea])

  // Compute pretext layout lines for overlay rendering. Runs after resizeTextarea
  // so the textarea has its final clientWidth/height. Both the overlay and
  // SmoothCaretOverlay use the same pretext engine, ensuring the visible text
  // wraps at exactly the positions pretext uses for caret positioning.
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea || !composerValue) {
      setOverlayLineTexts(null)
      return
    }
    const lines = computePretextLines(composerValue, textarea)
    setOverlayLineTexts(lines ? lines.map((l) => l.text) : null)
  }, [composerValue])

  // Recompute pretext lines when the textarea width changes (window resize, sidebar toggle).
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    let lastWidth = textarea.clientWidth
    const ro = new ResizeObserver(() => {
      const w = textarea.clientWidth
      if (w !== lastWidth) {
        lastWidth = w
        if (composerValue) {
          const lines = computePretextLines(composerValue, textarea)
          setOverlayLineTexts(lines ? lines.map((l) => l.text) : null)
        }
      }
    })
    ro.observe(textarea)
    return () => ro.disconnect()
  }, [composerValue])

  // Track textarea selection so the overlay can render its own highlight.
  useEffect(() => {
    const onSelectionChange = (): void => {
      const textarea = textareaRef.current
      if (!textarea || document.activeElement !== textarea) {
        setOverlaySelRange(null)
        return
      }
      const s = textarea.selectionStart
      const e = textarea.selectionEnd
      setOverlaySelRange(s !== e ? [s, e] : null)
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [activeThreadId])

  useEffect(() => {
    if (editingMessage !== null) {
      textareaRef.current?.focus()
    }
  }, [editingMessage])

  const handleComposerWheel = useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    const eventTarget = event.target
    const targetNode = eventTarget instanceof Node ? eventTarget : null
    const textarea = textareaRef.current
    const attachmentStrip = attachmentStripRef.current
    const localScrollElement =
      targetNode instanceof Element
        ? targetNode.closest<HTMLElement>('[data-composer-wheel-local-scroll]')
        : null
    const overComposerInput = Boolean(
      composerInputRef.current && targetNode && composerInputRef.current.contains(targetNode)
    )
    const overTextarea = Boolean(textarea && targetNode && textarea.contains(targetNode))
    const overAttachmentStrip = Boolean(
      attachmentStrip && targetNode && attachmentStrip.contains(targetNode)
    )

    if (
      overComposerInput &&
      textarea &&
      !localScrollElement &&
      Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
      Math.abs(event.deltaY) > 0
    ) {
      event.preventDefault()
      event.stopPropagation()
      const deltaY =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * textarea.clientHeight
            : event.deltaY
      textarea.dataset.composerUserScrollUntil = String(Date.now() + 800)
      if (overlayRef.current) {
        const overlayScrollTop = resolveWheelScrollOffset(
          {
            scrollOffset: overlayRef.current.scrollTop,
            viewportSize: overlayRef.current.clientHeight,
            contentSize: overlayRef.current.scrollHeight
          },
          deltaY
        )
        const textareaMax = Math.max(0, textarea.scrollHeight - textarea.clientHeight)
        overlayRef.current.scrollTop = overlayScrollTop
        textarea.scrollTop = Math.min(overlayScrollTop, textareaMax)
        textarea.dataset.composerOverlayScrollTop = String(overlayScrollTop)
      } else {
        textarea.scrollTop = resolveWheelScrollOffset(
          {
            scrollOffset: textarea.scrollTop,
            viewportSize: textarea.clientHeight,
            contentSize: textarea.scrollHeight
          },
          deltaY
        )
        textarea.dataset.composerOverlayScrollTop = String(textarea.scrollTop)
      }
      return
    }

    const destination = resolveComposerWheelDestination({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      localScroll: localScrollElement
        ? {
            scrollOffset: localScrollElement.scrollTop,
            viewportSize: localScrollElement.clientHeight,
            contentSize: localScrollElement.scrollHeight
          }
        : null,
      overAttachmentStrip,
      overTextarea: overTextarea || overComposerInput,
      popupOpen: anyPopupOpenRef.current,
      textarea: textarea
        ? {
            scrollOffset: textarea.scrollTop,
            viewportSize: textarea.clientHeight,
            contentSize: textarea.scrollHeight
          }
        : null,
      attachmentStrip: attachmentStrip
        ? {
            scrollOffset: attachmentStrip.scrollLeft,
            viewportSize: attachmentStrip.clientWidth,
            contentSize: attachmentStrip.scrollWidth
          }
        : null
    })

    if (destination === 'attachments') {
      event.preventDefault()
      attachmentStrip?.scrollBy({ left: event.deltaY })
      return
    }

    if (destination === 'timeline') {
      const timeline = document.querySelector<HTMLElement>('[data-timeline-scroll]')
      if (!timeline) return
      event.preventDefault()
      forwardComposerWheelToTimeline(timeline, {
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey
      })
    }
  }, [])

  // Auto-focus the composer textarea when a printable key is pressed while no
  // input-like element is focused. The listener is mounted only while Composer
  // is rendered, so it is scoped to the chat panel rather than a global window
  // listener that fires on every page.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.length !== 1) return
      if (event.key === ' ') return
      if (event.ctrlKey || event.altKey || event.metaKey) return

      const active = document.activeElement
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        active?.getAttribute('contenteditable') === 'true'
      ) {
        return
      }

      // Don't steal focus from interactive elements outside the composer
      // (buttons in modals, menus, links, sidebar items, etc.).
      if (
        active instanceof Element &&
        active !== document.body &&
        (!composerRootRef.current || !composerRootRef.current.contains(active))
      ) {
        const tag = active.tagName.toLowerCase()
        const tabIndex = active.getAttribute('tabindex')
        if (
          tag === 'button' ||
          tag === 'a' ||
          tag === 'summary' ||
          tabIndex === '0' ||
          tabIndex === '1'
        ) {
          return
        }
      }

      if (anyPopupOpenRef.current) return

      // Don't auto-focus when any non-composer overlay (modal, menu, dialog)
      // is open. These are typically rendered as fixed-position portals to
      // document.body; scanning body.children avoids coupling Composer to every
      // possible overlay component.
      let hasExternalOverlay = false
      for (const el of document.body.children) {
        if (el.id === 'root') continue
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        if (style.pointerEvents === 'none') continue
        if (style.position === 'fixed') {
          hasExternalOverlay = true
          break
        }
      }
      if (hasExternalOverlay) return

      const ta = textareaRef.current
      if (!ta) return

      // Focus synchronously so the browser routes the upcoming input event
      // into the textarea and the character is typed naturally.
      ta.focus()
      // We intentionally do NOT select-all: drafts are thread-specific and
      // usually mid-composition, so appending the keystroke feels more natural
      // than replacing the entire draft.
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  useEffect(() => {
    if (
      !modelSelectorOpen &&
      !reasoningSelectorOpen &&
      !skillsSelectorOpen &&
      !toolSelectorOpen &&
      !workspaceSelectorOpen
    ) {
      return
    }
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node
      const clickedInsideModelSelector =
        modelSelectorRef.current && modelSelectorRef.current.contains(target)
      const clickedInsideReasoningSelector =
        reasoningSelectorRef.current && reasoningSelectorRef.current.contains(target)
      const clickedInsideSkillsSelector =
        skillsSelectorRef.current && skillsSelectorRef.current.contains(target)
      const clickedInsideToolSelector =
        toolSelectorRef.current && toolSelectorRef.current.contains(target)
      const clickedInsideWorkspaceSelector =
        workspaceSelectorRef.current && workspaceSelectorRef.current.contains(target)

      if (!clickedInsideModelSelector) {
        setModelSelectorOpen(false)
      }

      if (!clickedInsideReasoningSelector) {
        setReasoningSelectorOpen(false)
      }

      if (!clickedInsideSkillsSelector) {
        setSkillsSelectorOpen(false)
      }

      if (!clickedInsideToolSelector) {
        setToolSelectorOpen(false)
      }

      if (!clickedInsideWorkspaceSelector) {
        setWorkspaceSelectorOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [
    modelSelectorOpen,
    reasoningSelectorOpen,
    skillsSelectorOpen,
    toolSelectorOpen,
    workspaceSelectorOpen
  ])

  const {
    queueImageFiles,
    queueDocumentFiles,
    handleSlashCommandSelect,
    handleTextareaScroll,
    handleInput,
    handleKeyDown,
    handlePaste,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop
  } = useComposerInputHandlers({
    activeRunEnterBehavior,
    activeThreadId,
    atSkillPrefixMatch,
    canHandoffActiveThread,
    canRunThreadOperations,
    canSend,
    cancelEditMessage,
    composerValue,
    dismissSlashPopup,
    dispatchSend,
    dragCounterRef,
    draftFiles,
    draftImages,
    editingMessage,
    fileMentionMatch,
    fileMentionQuery,
    fileMentionRawQuery,
    hasActiveRun,
    hasPayload,
    inputBuffer,
    isComposing,
    matchingSlashCommands,
    mergeBufferedPayloadIntoDraft,
    modelSelectorOpen,
    onSelectThreadOperation,
    overlayRef,
    pendingSteerEntry,
    queuedFollowUpMessageId,
    reasoningSelectorOpen,
    revertPendingSteer,
    revertQueuedFollowUp,
    removeComposerFile,
    removeComposerImage,
    runStatus,
    scrollComposerToEndAfterBreakRef,
    setComposerValue,
    setIsDragOver,
    setModelSelectorOpen,
    setReasoningSelectorOpen,
    setSkillsSelectorOpen,
    setSlashSelectedIndex,
    setAttachmentUploadNotice,
    setToolSelectorOpen,
    setWorkspaceSelectorOpen,
    showSlashCommandPopup,
    skillQuery,
    skillsSelectorOpen,
    slashQuery,
    slashSelectedIndex,
    toolSelectorOpen,
    textareaRef,
    upsertComposerFile,
    upsertComposerImage,
    userPrompts,
    workspaceSelectorOpen
  })

  const providerLabel =
    effectiveModel.providerName || (settings.provider === 'openai' ? 'OpenAI' : 'Anthropic')
  const modelLabel = effectiveModel.model || 'Configure provider'
  const reasoningProvider = config?.providers.find(
    (provider) => provider.name === effectiveModel.providerName
  )
  const reasoningSelectorState = reasoningProvider
    ? getReasoningSelectorState({
        provider: reasoningProvider,
        model: effectiveModel.model,
        selected: composerReasoningEffort
      })
    : {
        options: [composerReasoningEffort],
        selected: composerReasoningEffort
      }
  const hasModels =
    config !== null && config.providers.some((provider) => provider.modelList.enabled.length > 0)
  const hasAcpAgents =
    config !== null && (config.subagentProfiles ?? []).some((p) => p.enabled && p.showInChatPicker)
  const canOpenModelPicker = hasModels || hasAcpAgents

  useEffect(() => {
    if (reasoningSelectorState.selected !== composerReasoningEffort) {
      setComposerReasoningEffort(reasoningSelectorState.selected)
    }
  }, [composerReasoningEffort, reasoningSelectorState.selected, setComposerReasoningEffort])

  return (
    <ComposerView
      composerRootRef={composerRootRef}
      handleComposerWheel={handleComposerWheel}
      handleDragEnter={handleDragEnter}
      handleDragOver={handleDragOver}
      handleDragLeave={handleDragLeave}
      handleDrop={handleDrop}
      isDragOver={isDragOver}
      editingMessage={editingMessage}
      cancelEditMessage={cancelEditMessage}
      queuedFollowUpMessage={queuedFollowUpMessage}
      handleEditQueuedFollowUp={handleEditQueuedFollowUp}
      queuedFollowUpCanRemove={queuedFollowUpCanRemove}
      handleRemoveQueuedFollowUp={handleRemoveQueuedFollowUp}
      inputBuffer={inputBuffer}
      mergeBufferedPayloadIntoDraft={mergeBufferedPayloadIntoDraft}
      attachmentStripRef={attachmentStripRef}
      draftImages={draftImages}
      draftFiles={draftFiles}
      removeComposerImage={removeComposerImage}
      activeThreadId={activeThreadId}
      placeholderRunId={placeholderRunId}
      placeholderRunIndex={placeholderRunIndex}
      removeComposerFile={removeComposerFile}
      popupContainerRef={popupContainerRef}
      showSlashCommandPopup={showSlashCommandPopup}
      matchingSlashCommands={matchingSlashCommands}
      slashSelectedIndex={slashSelectedIndex}
      handleSlashCommandSelect={handleSlashCommandSelect}
      dismissSlashPopup={dismissSlashPopup}
      fileMentionQuery={fileMentionQuery}
      fileMentionMatchesState={fileMentionMatchesState}
      isFileMentionSearchPending={isFileMentionSearchPending}
      loadMoreFileMentionMatches={loadMoreFileMentionMatches}
      fileMentionAnchorRect={fileMentionAnchorRect}
      activeSkillTag={activeSkillTag}
      validatedFileTags={validatedFileTags}
      setComposerValue={setComposerValue}
      composerValue={composerValue}
      composerInputRef={composerInputRef}
      overlayRef={overlayRef}
      overlayLineTexts={overlayLineTexts}
      overlaySelRange={overlaySelRange}
      textareaRef={textareaRef}
      isTextareaFocused={isTextareaFocused}
      setIsTextareaFocused={setIsTextareaFocused}
      handleInput={handleInput}
      setIsComposing={setIsComposing}
      handleKeyDown={handleKeyDown}
      handlePaste={handlePaste}
      handleTextareaScroll={handleTextareaScroll}
      isConfigured={isConfigured}
      composerStatus={composerStatus}
      fileInputRef={fileInputRef}
      queueImageFiles={queueImageFiles}
      queueDocumentFiles={queueDocumentFiles}
      canAddImages={canAddImages}
      canAddFiles={canAddFiles}
      effectiveAcpBinding={effectiveAcpBinding}
      toolSelectorRef={toolSelectorRef}
      setModelSelectorOpen={setModelSelectorOpen}
      setReasoningSelectorOpen={setReasoningSelectorOpen}
      setSkillsSelectorOpen={setSkillsSelectorOpen}
      setWorkspaceSelectorOpen={setWorkspaceSelectorOpen}
      setToolSelectorOpen={setToolSelectorOpen}
      toolSelectorOpen={toolSelectorOpen}
      enabledTools={enabledTools}
      hasActiveRun={hasActiveRun}
      toggleEnabledTool={toggleEnabledTool}
      skillsSelectorRef={skillsSelectorRef}
      skillsSelectorOpen={skillsSelectorOpen}
      enabledSkillCount={enabledSkillCount}
      availableSkills={availableSkills}
      effectiveEnabledSkillNames={effectiveEnabledSkillNames}
      hasCustomSkillOverride={hasCustomSkillOverride}
      setComposerEnabledSkillNames={setComposerEnabledSkillNames}
      defaultEnabledSkillNames={defaultEnabledSkillNames}
      inputBufferDurable={inputBufferDurable}
      inputBufferSession={inputBufferSession}
      toggleInputBufferSession={toggleInputBufferSession}
      workspaceSelectorRef={workspaceSelectorRef}
      setWorkspaceHintHovered={setWorkspaceHintHovered}
      setWorkspaceHintPinned={setWorkspaceHintPinned}
      isWorkspaceLocked={isWorkspaceLocked}
      workspaceSelectorOpen={workspaceSelectorOpen}
      currentWorkspacePath={currentWorkspacePath}
      showWorkspaceHint={showWorkspaceHint}
      workspaceHint={workspaceHint}
      savedWorkspacePaths={savedWorkspacePaths}
      requestWorkspaceSelection={requestWorkspaceSelection}
      pendingWorkspaceChangeConfirmation={pendingWorkspaceChangeConfirmation}
      setPendingWorkspaceChangeConfirmation={setPendingWorkspaceChangeConfirmation}
      commitWorkspaceSelection={commitWorkspaceSelection}
      modelSelectorRef={modelSelectorRef}
      modelSelectorOpen={modelSelectorOpen}
      canOpenModelPicker={canOpenModelPicker}
      isModelSelectorLocked={isModelSelectorLocked}
      activeAcpBinding={activeAcpBinding}
      providerLabel={providerLabel}
      modelLabel={modelLabel}
      config={config}
      effectiveModel={effectiveModel}
      runBackendSwitch={runBackendSwitch}
      selectModel={selectModel}
      setPendingAcpBinding={setPendingAcpBinding}
      activeThreadMessageCount={activeThreadMessageCount}
      notifyAcpRebindBlocked={notifyAcpRebindBlocked}
      reasoningSelectorRef={reasoningSelectorRef}
      reasoningSelectorOpen={reasoningSelectorOpen}
      reasoningSelectorState={reasoningSelectorState}
      setComposerReasoningEffort={setComposerReasoningEffort}
      showRunStats={showRunStats}
      hasRunStatsText={hasRunStatsText}
      displayPromptTokens={displayPromptTokens}
      latestRun={latestRun}
      estimatedDraftTokens={estimatedDraftTokens}
      canHandoffActiveThread={canHandoffActiveThread}
      stripCompactThresholdTokens={stripCompactThresholdTokens}
      showStopButton={showStopButton}
      isCancelInFlight={isCancelInFlight}
      setIsCancelInFlight={setIsCancelInFlight}
      cancelActiveRun={cancelActiveRun}
      canSend={canSend}
      dispatchSend={dispatchSend}
      primarySendMode={primarySendMode}
      isSendInFlight={isSendInFlight}
    />
  )
}
