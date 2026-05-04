import type React from 'react'
import { useCallback } from 'react'
import {
  useAppStore,
  type AppState,
  type EditingMessageState
} from '@renderer/app/store/useAppStore'
import type { ActiveRunEnterBehavior, RunStatus, SettingsConfig } from '@renderer/app/types'
import {
  resolveComposerEnterAction,
  shouldSelectCompletionCandidate
} from '@renderer/features/chat/lib/composerEnterBehavior'
import { shouldRevertPendingComposerMessagesOnArrowUp } from '@renderer/features/chat/lib/composerArrowUpRevert'
import type { UseChatInputBufferResult } from '@renderer/features/chat/hooks/useChatInputBuffer'
import { clearGoalX, navigatePretextLine } from '@renderer/features/chat/lib/pretextSync'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { longestCommonPrefix } from '../../lib/longestCommonPrefix'
import type { SlashCommand } from '../SlashCommandPopup'
import {
  ACCEPTED_FILE_TYPES,
  FILE_MENTION_PATTERN,
  MAX_COMPOSER_FILES,
  MAX_COMPOSER_IMAGES,
  NEW_THREAD_DRAFT_KEY,
  createDraftImageId,
  readFileAsDataUrl
} from './support.tsx'

type ComposerSendMode = 'normal' | 'steer' | 'follow-up'

interface UseComposerInputHandlersInput {
  activeRunEnterBehavior: ActiveRunEnterBehavior
  activeThreadId: string | null
  atSkillPrefixMatch: RegExpExecArray | null
  canHandoffActiveThread: boolean
  canRunThreadOperations: boolean
  canSend: boolean
  cancelEditMessage: () => void
  composerValue: string
  dismissSlashPopup: () => void
  dispatchSend: (mode: ComposerSendMode) => void
  dragCounterRef: React.MutableRefObject<number>
  editingMessage: EditingMessageState | null
  fileMentionMatch: RegExpExecArray | null
  fileMentionQuery: string | null
  fileMentionRawQuery: string
  hasActiveRun: boolean
  hasPayload: boolean
  inputBuffer: UseChatInputBufferResult
  isComposing: boolean
  matchingSlashCommands: SlashCommand[]
  mergeBufferedPayloadIntoDraft: AppState['mergeBufferedPayloadIntoDraft']
  modelSelectorOpen: boolean
  onSelectThreadOperation?: (key: ThreadContextOperationKey) => void
  overlayRef: React.RefObject<HTMLDivElement | null>
  pendingSteerEntry: unknown | null
  queuedFollowUpMessageId: string | null
  reasoningSelectorOpen: boolean
  revertPendingSteer: AppState['revertPendingSteer']
  revertQueuedFollowUp: AppState['revertQueuedFollowUp']
  runStatus: RunStatus
  scrollComposerToEndAfterBreakRef: React.MutableRefObject<boolean>
  setComposerValue: AppState['setComposerValue']
  setIsDragOver: React.Dispatch<React.SetStateAction<boolean>>
  setModelSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>
  setReasoningSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSkillsSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  setToolSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>
  setWorkspaceSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>
  showSlashCommandPopup: boolean
  skillQuery: string | null
  skillsSelectorOpen: boolean
  slashQuery: string | null
  slashSelectedIndex: number
  toolSelectorOpen: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  upsertComposerFile: AppState['upsertComposerFile']
  upsertComposerImage: AppState['upsertComposerImage']
  userPrompts: NonNullable<SettingsConfig['prompts']>
  workspaceSelectorOpen: boolean
}

interface UseComposerInputHandlersResult {
  queueImageFiles: (files: File[]) => Promise<void>
  queueDocumentFiles: (files: File[]) => Promise<void>
  handleSlashCommandSelect: (command: SlashCommand) => void
  handleTextareaScroll: (event: React.UIEvent<HTMLTextAreaElement>) => void
  handleInput: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handlePaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  handleDragEnter: (event: React.DragEvent) => void
  handleDragOver: (event: React.DragEvent) => void
  handleDragLeave: (event: React.DragEvent) => void
  handleDrop: (event: React.DragEvent) => void
}

export function useComposerInputHandlers(
  input: UseComposerInputHandlersInput
): UseComposerInputHandlersResult {
  const {
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
    runStatus,
    scrollComposerToEndAfterBreakRef,
    setComposerValue,
    setIsDragOver,
    setModelSelectorOpen,
    setReasoningSelectorOpen,
    setSkillsSelectorOpen,
    setSlashSelectedIndex,
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
  } = input

  const queueImageFiles = useCallback(
    async (files: File[]) => {
      const remainingSlots = Math.max(
        0,
        MAX_COMPOSER_IMAGES -
          (useAppStore.getState().composerDrafts[activeThreadId ?? NEW_THREAD_DRAFT_KEY]?.images
            .length ?? 0)
      )
      const imageFiles = files
        .filter((file) => file.type.startsWith('image/'))
        .slice(0, remainingSlots)

      for (const file of imageFiles) {
        const imageId = createDraftImageId()
        upsertComposerImage(
          {
            id: imageId,
            status: 'loading',
            dataUrl: '',
            mediaType: file.type || 'image/*',
            filename: file.name
          },
          activeThreadId
        )

        try {
          const dataUrl = await readFileAsDataUrl(file)
          upsertComposerImage(
            {
              id: imageId,
              status: 'ready',
              dataUrl,
              mediaType: file.type || 'image/*',
              filename: file.name
            },
            activeThreadId
          )
        } catch (error) {
          upsertComposerImage(
            {
              id: imageId,
              status: 'failed',
              dataUrl: '',
              mediaType: file.type || 'image/*',
              filename: file.name,
              error: error instanceof Error ? error.message : 'Unable to prepare this image.'
            },
            activeThreadId
          )
        }
      }
    },
    [activeThreadId, upsertComposerImage]
  )

  const queueDocumentFiles = useCallback(
    async (files: File[]) => {
      const remainingSlots = Math.max(
        0,
        MAX_COMPOSER_FILES -
          (useAppStore.getState().composerDrafts[activeThreadId ?? NEW_THREAD_DRAFT_KEY]?.files
            .length ?? 0)
      )
      const docFiles = files
        .filter((file) => !file.type.startsWith('image/'))
        .slice(0, remainingSlots)

      for (const file of docFiles) {
        const fileId = createDraftImageId()
        upsertComposerFile(
          { id: fileId, filename: file.name, mediaType: file.type, dataUrl: '', status: 'loading' },
          activeThreadId
        )

        try {
          const dataUrl = await readFileAsDataUrl(file)
          upsertComposerFile(
            { id: fileId, filename: file.name, mediaType: file.type, dataUrl, status: 'ready' },
            activeThreadId
          )
        } catch (error) {
          upsertComposerFile(
            {
              id: fileId,
              filename: file.name,
              mediaType: file.type,
              dataUrl: '',
              status: 'failed',
              error: error instanceof Error ? error.message : 'Unable to prepare this file.'
            },
            activeThreadId
          )
        }
      }
    },
    [activeThreadId, upsertComposerFile]
  )

  const handleSlashCommandSelect = useCallback(
    (command: SlashCommand) => {
      if (command.type === 'action') {
        if (!canRunThreadOperations) {
          return
        }

        if (command.key === 'handoff' && (!canHandoffActiveThread || runStatus === 'running')) {
          return
        }

        setComposerValue('')
        const opKey = command.key === 'archive' ? 'archive' : 'compact-to-another-thread'
        onSelectThreadOperation?.(opKey as ThreadContextOperationKey)
      } else if (command.type === 'skill-prefix') {
        setComposerValue('/skills:')
      } else if (command.type === 'skill') {
        const skillName = command.key.slice('skills:'.length)
        setComposerValue(`@skills:${skillName} `)
      } else if (command.type === 'file' || command.type === 'jotdown') {
        const encodedPath = command.key.slice('file:'.length)
        const filePath = encodedPath.startsWith('!') ? encodedPath.slice(1) : encodedPath
        const needsQuotes = filePath.includes(' ')
        setComposerValue(
          composerValue.replace(
            FILE_MENTION_PATTERN,
            (_match, prefix: string, ignoreMarker: string) => {
              const bang = encodedPath.startsWith('!') || ignoreMarker === '!' ? '!' : ''
              return needsQuotes
                ? `${prefix}@${bang}"${filePath}" `
                : `${prefix}@${bang}${filePath} `
            }
          )
        )
      } else {
        const prompt = userPrompts.find((p) => p.keycode === command.key)
        if (prompt) setComposerValue(prompt.text)
      }
    },
    [
      canRunThreadOperations,
      canHandoffActiveThread,
      runStatus,
      composerValue,
      onSelectThreadOperation,
      userPrompts,
      setComposerValue
    ]
  )

  const handleTextareaScroll = useCallback(
    (event: React.UIEvent<HTMLTextAreaElement>) => {
      if (!overlayRef.current) return
      const ta = event.currentTarget
      const o = overlayRef.current
      // Don't pull overlay back when textarea is at max scroll but overlay can scroll further
      // (trailing-newline sentinel gives overlay more scroll range)
      const taMax = ta.scrollHeight - ta.clientHeight
      if (ta.scrollTop >= taMax - 1 && o.scrollTop > ta.scrollTop) return
      o.scrollTop = ta.scrollTop
    },
    [overlayRef]
  )

  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent as InputEvent
      const it = native.inputType ?? ''
      if (it === 'insertLineBreak' || it === 'insertParagraph') {
        scrollComposerToEndAfterBreakRef.current = true
      } else if (it === 'insertText' && native.data != null && /[\n\r]/.test(native.data)) {
        scrollComposerToEndAfterBreakRef.current = true
      }
      setComposerValue(event.target.value)
    },
    [scrollComposerToEndAfterBreakRef, setComposerValue]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashCommandPopup) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSlashSelectedIndex((i) => Math.min(i + 1, matchingSlashCommands.length - 1))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSlashSelectedIndex((i) => Math.max(i - 1, 0))
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          if (event.shiftKey) {
            setSlashSelectedIndex((i) => Math.max(i - 1, 0))
            return
          }
          // Shell-style completion. First try to extend the typed token to
          // the longest common prefix across candidates; if nothing to
          // extend, fall through to committing the highlighted entry as
          // text only. Tab must NEVER fire side-effectful actions like
          // /archive or /handoff — only Enter does that.
          let extended = false
          if (matchingSlashCommands.length > 1) {
            if (skillQuery !== null) {
              const pool = matchingSlashCommands.map((c) => c.label)
              const lcp = longestCommonPrefix(pool, true)
              if (lcp.length > skillQuery.length) {
                const usingAt = atSkillPrefixMatch !== null
                setComposerValue(`${usingAt ? '@' : '/'}skills:${lcp}`)
                extended = true
              }
            } else if (slashQuery !== null) {
              const pool = matchingSlashCommands.map((c) => c.key)
              const lcp = longestCommonPrefix(pool, true)
              if (lcp.length > slashQuery.length) {
                setComposerValue(`/${lcp}`)
                extended = true
              }
            } else if (fileMentionQuery !== null && fileMentionMatch) {
              // Use full paths when the user has already typed a directory
              // prefix, otherwise fall back to basename-only extension so
              // typing `comp` still extends to `Composer`.
              const rawQuery = fileMentionRawQuery
              const hasSlash = rawQuery.includes('/')
              const lowered = rawQuery.toLowerCase()
              const stripBang = (p: string): string => (p.startsWith('!') ? p.slice(1) : p)
              const candidates = matchingSlashCommands
                .map((c) => {
                  const path = stripBang(c.label)
                  return hasSlash ? path : path.slice(path.lastIndexOf('/') + 1)
                })
                .filter((s) => s.toLowerCase().startsWith(lowered))
              if (candidates.length > 1) {
                const lcp = longestCommonPrefix(candidates, true)
                if (lcp.length > rawQuery.length) {
                  // Preserve the user's quote state; group 3 of the pattern
                  // only matches when an opening `"` is present.
                  const isQuoted = fileMentionMatch[3] !== undefined
                  setComposerValue(
                    composerValue.replace(
                      FILE_MENTION_PATTERN,
                      (_m, prefix: string, ignoreMarker: string) =>
                        isQuoted
                          ? `${prefix}@${ignoreMarker}"${lcp}`
                          : `${prefix}@${ignoreMarker}${lcp}`
                    )
                  )
                  extended = true
                }
              }
            }
          }
          if (extended) return
          const selected = matchingSlashCommands[slashSelectedIndex]
          if (!selected) return
          // Text-only commit: avoid triggering action side effects. Pure
          // text-insertion types (prompt, skill, file, jotdown, skill-prefix)
          // are still safe to delegate to the normal selector.
          if (selected.type === 'action') {
            setComposerValue(`/${selected.key}`)
            return
          }
          handleSlashCommandSelect(selected)
          return
        }
        if (
          shouldSelectCompletionCandidate({
            key: event.key,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            isComposing: isComposing || event.nativeEvent.isComposing,
            keyCode: event.nativeEvent.keyCode
          })
        ) {
          event.preventDefault()
          const selected = matchingSlashCommands[slashSelectedIndex]
          if (selected) handleSlashCommandSelect(selected)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          dismissSlashPopup()
          return
        }
      }

      if (event.key === 'Escape') {
        if (isComposing || event.nativeEvent.isComposing) return
        if (
          modelSelectorOpen ||
          reasoningSelectorOpen ||
          skillsSelectorOpen ||
          toolSelectorOpen ||
          workspaceSelectorOpen
        ) {
          event.preventDefault()
          setModelSelectorOpen(false)
          setReasoningSelectorOpen(false)
          setSkillsSelectorOpen(false)
          setToolSelectorOpen(false)
          setWorkspaceSelectorOpen(false)
          return
        }
        if (inputBuffer.staged) {
          event.preventDefault()
          const payload = inputBuffer.staged
          inputBuffer.cancel()
          mergeBufferedPayloadIntoDraft(payload, payload.sourceThreadId)
          return
        }
        if (editingMessage !== null) {
          event.preventDefault()
          cancelEditMessage()
          return
        }
        event.preventDefault()
        textareaRef.current?.blur()
        return
      }

      // Empty-composer ArrowUp: revert all pending messages (steer + queued follow-up)
      // back into the composer for editing. Only fires when the composer is fully
      // empty — no text, no images, no files — to avoid surprising merges.
      if (
        shouldRevertPendingComposerMessagesOnArrowUp({
          key: event.key,
          metaKey: event.metaKey,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          hasPayload,
          hasPendingSteer: Boolean(pendingSteerEntry),
          hasQueuedFollowUp: Boolean(queuedFollowUpMessageId)
        })
      ) {
        event.preventDefault()
        void (async () => {
          if (pendingSteerEntry) await revertPendingSteer()
          if (queuedFollowUpMessageId) await revertQueuedFollowUp(queuedFollowUpMessageId)
        })()
        return
      }

      // Pretext-driven up/down navigation — override native arrow keys so cursor
      // movement follows pretext's visual lines, not the textarea's CSS wrapping.
      if (
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        !event.metaKey &&
        !event.altKey &&
        !event.ctrlKey
      ) {
        if (
          navigatePretextLine(
            event.currentTarget,
            event.key === 'ArrowUp' ? 'up' : 'down',
            event.shiftKey
          )
        ) {
          event.preventDefault()
          return
        }
      }
      // Any other key resets the sticky goal column for up/down navigation.
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        clearGoalX()
      }

      // Cmd/Ctrl+Enter forces an immediate flush of any staged buffer so the
      // user can bypass the merge window without disabling buffering.
      if (
        event.key === 'Enter' &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        inputBuffer.staged
      ) {
        event.preventDefault()
        inputBuffer.flushNow()
        return
      }

      // Plain Enter on an empty composer while a payload is staged = send now.
      // Natural finger-memory shortcut: the user has stopped typing, looks at
      // the staged bubble, and hits Enter again to commit it immediately.
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !isComposing &&
        !event.nativeEvent.isComposing &&
        inputBuffer.staged &&
        !hasPayload
      ) {
        event.preventDefault()
        inputBuffer.flushNow()
        return
      }

      const action = resolveComposerEnterAction({
        activeRunEnterBehavior,
        event: {
          key: event.key,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: isComposing || event.nativeEvent.isComposing,
          keyCode: event.nativeEvent.keyCode
        },
        hasActiveRun
      })

      if (!action) {
        return
      }

      event.preventDefault()
      if (canSend) {
        setModelSelectorOpen(false)
        setSkillsSelectorOpen(false)
        setToolSelectorOpen(false)
        setWorkspaceSelectorOpen(false)
        dispatchSend(action === 'send' ? 'normal' : action)
      }
    },
    [
      activeRunEnterBehavior,
      cancelEditMessage,
      canSend,
      editingMessage,
      handleSlashCommandSelect,
      hasActiveRun,
      isComposing,
      inputBuffer,
      mergeBufferedPayloadIntoDraft,
      matchingSlashCommands,
      dismissSlashPopup,
      dispatchSend,
      modelSelectorOpen,
      reasoningSelectorOpen,
      showSlashCommandPopup,
      slashSelectedIndex,
      skillQuery,
      slashQuery,
      fileMentionQuery,
      fileMentionMatch,
      fileMentionRawQuery,
      atSkillPrefixMatch,
      composerValue,
      setComposerValue,
      hasPayload,
      pendingSteerEntry,
      queuedFollowUpMessageId,
      revertPendingSteer,
      revertQueuedFollowUp,
      setModelSelectorOpen,
      setReasoningSelectorOpen,
      setSkillsSelectorOpen,
      setSlashSelectedIndex,
      setToolSelectorOpen,
      setWorkspaceSelectorOpen,
      skillsSelectorOpen,
      textareaRef,
      toolSelectorOpen,
      workspaceSelectorOpen
    ]
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Web clipboard items — works for screenshots and images copied from browser
      const allFiles = Array.from(event.clipboardData.items)
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)

      const images = allFiles.filter((f) => f.type.startsWith('image/'))
      const docs = allFiles.filter((f) => ACCEPTED_FILE_TYPES.includes(f.type))

      if (images.length > 0 || docs.length > 0) {
        event.preventDefault()
        if (images.length > 0) void queueImageFiles(images)
        if (docs.length > 0) void queueDocumentFiles(docs)
        return
      }

      // Finder-copied files: web clipboard won't carry their data, ask main process
      void (async () => {
        const finderFiles = await window.api.yachiyo.readClipboardFilePaths()
        if (finderFiles.length === 0) return

        const finderImages = finderFiles.filter((f) => f.mediaType.startsWith('image/'))
        const finderDocs = finderFiles.filter((f) => !f.mediaType.startsWith('image/'))

        for (const f of finderImages) {
          const id = createDraftImageId()
          upsertComposerImage(
            { id, dataUrl: f.dataUrl, mediaType: f.mediaType, status: 'ready' },
            activeThreadId
          )
        }
        for (const f of finderDocs) {
          const id = createDraftImageId()
          upsertComposerFile(
            {
              id,
              filename: f.filename,
              mediaType: f.mediaType,
              dataUrl: f.dataUrl,
              status: 'ready'
            },
            activeThreadId
          )
        }
      })()
    },
    [queueImageFiles, queueDocumentFiles, upsertComposerImage, upsertComposerFile, activeThreadId]
  )

  const handleDragEnter = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      dragCounterRef.current++
      if (event.dataTransfer.types.includes('Files')) {
        setIsDragOver(true)
      }
    },
    [dragCounterRef, setIsDragOver]
  )

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleDragLeave = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      dragCounterRef.current--
      if (dragCounterRef.current === 0) {
        setIsDragOver(false)
      }
    },
    [dragCounterRef, setIsDragOver]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      dragCounterRef.current = 0
      setIsDragOver(false)

      const files = Array.from(event.dataTransfer.files)
      if (files.length === 0) return

      const images = files.filter((f) => f.type.startsWith('image/'))
      const docs = files.filter(
        (f) => !f.type.startsWith('image/') && ACCEPTED_FILE_TYPES.includes(f.type)
      )

      if (images.length > 0) void queueImageFiles(images)
      if (docs.length > 0) void queueDocumentFiles(docs)
    },
    [dragCounterRef, queueDocumentFiles, queueImageFiles, setIsDragOver]
  )

  return {
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
  }
}
