import type React from 'react'
import { useRef, useCallback, useState, useEffect, useMemo } from 'react'
import {
  AlertCircle,
  ChevronDown,
  CircleCheck,
  FileText,
  Folder,
  Paperclip,
  LoaderCircle,
  SendHorizonal,
  Sparkles,
  Square,
  Wrench,
  X
} from 'lucide-react'
import {
  DEFAULT_SETTINGS,
  EMPTY_COMPOSER_DRAFT,
  useAppStore,
  type ComposerFileDraft,
  type ComposerImageDraft
} from '@renderer/app/store/useAppStore'
import type { FileMentionCandidate } from '@renderer/app/types'
import { getComposerActionState } from '@renderer/features/chat/lib/composerActionState'
import { resolveComposerEnterAction } from '@renderer/features/chat/lib/composerEnterBehavior'
import { theme } from '@renderer/theme/theme'
import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  isMemoryConfigured
} from '../../../../../shared/yachiyo/protocol.ts'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { ModelSelectorPopup } from './ModelSelectorPopup'
import { SlashCommandPopup } from './SlashCommandPopup'
import type { SlashCommand } from './SlashCommandPopup'
import { SkillsSelectorPopup } from './SkillsSelectorPopup'
import { ToolSelectorPopup } from './ToolSelectorPopup'
import { WorkspaceSelectorPopup } from './WorkspaceSelectorPopup'
import { SmoothCaretOverlay } from './SmoothCaretOverlay'

const NEW_THREAD_DRAFT_KEY = '__new__'
const MAX_COMPOSER_IMAGES = 4
const MAX_COMPOSER_FILES = 10

const ACCEPTED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain',
  'text/csv',
  'text/markdown'
]

const ACCEPT_ATTRIBUTE = `image/*,${ACCEPTED_FILE_TYPES.join(',')}`

const COMPOSER_TAG_HIGHLIGHT_RE = /@skills:[a-zA-Z0-9_-]+|@!?[A-Za-z0-9._/-]+/g
const CONFIRMED_FILE_TAG_RE = /(^|\s)@(!?[A-Za-z0-9._/-]+)(?=\s|$)/g
const SKILL_TAG_PATTERN = /^@skills:([a-zA-Z0-9_-]+)(\s|$)/
const SLASH_PATTERN = /^\/([a-zA-Z0-9-]*)$/
const SKILL_PREFIX_PATTERN = /^\/skills:([a-zA-Z0-9_-]*)$/
const AT_SKILL_PREFIX_PATTERN = /^@skills:([a-zA-Z0-9_-]*)$/
const FILE_MENTION_PATTERN = /(^|\s)@(!?)([A-Za-z0-9._/-]*)$/

function renderComposerTextHighlights(
  text: string,
  primaryColor: string,
  accentColor: string
): React.ReactNode {
  const parts: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  COMPOSER_TAG_HIGHLIGHT_RE.lastIndex = 0
  while ((m = COMPOSER_TAG_HIGHLIGHT_RE.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(
        <span key={last} style={{ color: primaryColor }}>
          {text.slice(last, m.index)}
        </span>
      )
    }
    parts.push(
      <span
        key={`h${m.index}`}
        style={{ color: accentColor, textDecoration: 'underline', textUnderlineOffset: '2px' }}
      >
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) {
    parts.push(
      <span key={last} style={{ color: primaryColor }}>
        {text.slice(last)}
      </span>
    )
  }
  return parts.length > 0 ? <>{parts}</> : null
}

function collectConfirmedFileTags(text: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  CONFIRMED_FILE_TAG_RE.lastIndex = 0
  while ((match = CONFIRMED_FILE_TAG_RE.exec(text)) !== null) {
    const value = match[2]?.trim() ?? ''
    if (!value || value.startsWith('skills:') || seen.has(value)) {
      continue
    }

    seen.add(value)
    tags.push(value)
  }

  return tags
}

async function resolveValidatedFileTags(input: {
  fileTags: string[]
  threadId: string | null
  workspacePath: string | null
}): Promise<string[]> {
  const validated: string[] = []

  await Promise.all(
    input.fileTags.map(async (fileTag) => {
      const includeIgnored = fileTag.startsWith('!')
      const query = includeIgnored ? fileTag.slice(1) : fileTag
      const matches = await window.api.yachiyo.searchWorkspaceFiles({
        query,
        includeIgnored,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(!input.threadId && input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        limit: 8
      })

      if (matches.some((match) => match.path === query)) {
        validated.push(fileTag)
      }
    })
  )

  return input.fileTags.filter((fileTag) => validated.includes(fileTag))
}

function createDraftImageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `image-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image file.'))
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Image could not be converted into a preview.'))
        return
      }

      resolve(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function getImageStatusLabel(image: ComposerImageDraft): string {
  if (image.status === 'loading') {
    return 'Loading'
  }

  if (image.status === 'failed') {
    return 'Needs attention'
  }

  return 'Ready'
}

function getFileStatusLabel(file: ComposerFileDraft): string {
  if (file.status === 'loading') return 'Loading'
  if (file.status === 'failed') return 'Needs attention'
  return 'Ready'
}

function ComposerFilePreview({
  file,
  onRemove
}: {
  file: ComposerFileDraft
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="composer-file-card">
      <button
        type="button"
        className="composer-image-card__remove"
        aria-label={`Remove ${file.filename}`}
        onClick={onRemove}
      >
        <X size={12} strokeWidth={1.8} />
      </button>

      <div className="composer-file-card__icon">
        {file.status === 'loading' ? (
          <LoaderCircle size={18} strokeWidth={1.7} className="composer-image-card__spinner" />
        ) : file.status === 'failed' ? (
          <AlertCircle size={18} strokeWidth={1.7} />
        ) : (
          <FileText size={18} strokeWidth={1.5} />
        )}
      </div>

      <div className="composer-image-card__meta">
        <span className="composer-image-card__name">{file.filename}</span>
        <span className="composer-image-card__status">{getFileStatusLabel(file)}</span>
      </div>
    </div>
  )
}

function getWorkspaceLabel(workspacePath: string | null): string {
  if (!workspacePath) {
    return 'Temp workspace'
  }

  return workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
}

function getWorkspaceHint(input: { isWorkspaceLocked: boolean; workspacePath: string | null }): {
  title: string
  detail: string
} {
  if (input.isWorkspaceLocked) {
    return {
      title: 'Workspace locked',
      detail: input.workspacePath
        ? `${input.workspacePath}\nSent messages already exist, so this thread can no longer switch workspaces.`
        : 'This thread is already using the temp workspace. Sent messages already exist, so it can no longer switch workspaces.'
    }
  }

  return input.workspacePath
    ? {
        title: getWorkspaceLabel(input.workspacePath),
        detail: input.workspacePath
      }
    : {
        title: 'Temp workspace',
        detail: 'No specific workspace selected for this thread.'
      }
}

function ComposerImagePreview({
  image,
  onRemove
}: {
  image: ComposerImageDraft
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="composer-image-card">
      <button
        type="button"
        className="composer-image-card__remove"
        aria-label={`Remove ${image.filename ?? 'image'}`}
        onClick={onRemove}
      >
        <X size={12} strokeWidth={1.8} />
      </button>

      <div className="composer-image-card__frame">
        {image.status === 'ready' && image.dataUrl ? (
          <img
            className="composer-image-card__media"
            src={image.dataUrl}
            alt={image.filename ?? 'Selected image'}
          />
        ) : (
          <div className="composer-image-card__placeholder">
            {image.status === 'loading' ? (
              <LoaderCircle size={16} strokeWidth={1.7} className="composer-image-card__spinner" />
            ) : (
              <AlertCircle size={16} strokeWidth={1.7} />
            )}
          </div>
        )}
      </div>

      <div className="composer-image-card__meta">
        <span className="composer-image-card__name">{image.filename ?? 'Image'}</span>
        <span className="composer-image-card__status">{getImageStatusLabel(image)}</span>
      </div>
    </div>
  )
}

export function Composer({
  onSelectThreadOperation
}: {
  onSelectThreadOperation?: (key: ThreadContextOperationKey) => void
}): React.JSX.Element {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const composerDraft = useAppStore(
    (s) => s.composerDrafts[s.activeThreadId ?? NEW_THREAD_DRAFT_KEY] ?? EMPTY_COMPOSER_DRAFT
  )
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const availableSkills = useAppStore((s) => s.availableSkills)
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)
  const activeRunId = useAppStore((s) =>
    s.activeThreadId ? (s.activeRunIdsByThread[s.activeThreadId] ?? null) : null
  )
  const config = useAppStore((s) => s.config)
  const messages = useAppStore((s) => s.messages)
  const pendingWorkspacePath = useAppStore((s) => s.pendingWorkspacePath)
  const runPhase = useAppStore((s) =>
    s.activeThreadId ? (s.runPhasesByThread[s.activeThreadId] ?? 'idle') : 'idle'
  )
  const cancelActiveRun = useAppStore((s) => s.cancelActiveRun)
  const enabledTools = useAppStore((s) => s.enabledTools)
  const removeComposerImage = useAppStore((s) => s.removeComposerImage)
  const removeComposerFile = useAppStore((s) => s.removeComposerFile)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const selectModel = useAppStore((s) => s.selectModel)
  const setComposerEnabledSkillNames = useAppStore((s) => s.setComposerEnabledSkillNames)
  const setComposerValue = useAppStore((s) => s.setComposerValue)
  const setThreadWorkspace = useAppStore((s) => s.setThreadWorkspace)
  const toggleEnabledTool = useAppStore((s) => s.toggleEnabledTool)
  const threads = useAppStore((s) => s.threads)
  const upsertComposerImage = useAppStore((s) => s.upsertComposerImage)
  const upsertComposerFile = useAppStore((s) => s.upsertComposerFile)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLDivElement>(null)
  const modelSelectorRef = useRef<HTMLDivElement>(null)
  const skillsSelectorRef = useRef<HTMLDivElement>(null)
  const toolSelectorRef = useRef<HTMLDivElement>(null)
  const workspaceSelectorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [skillsSelectorOpen, setSkillsSelectorOpen] = useState(false)
  const [toolSelectorOpen, setToolSelectorOpen] = useState(false)
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(false)
  const [workspaceHintHovered, setWorkspaceHintHovered] = useState(false)
  const [workspaceHintPinned, setWorkspaceHintPinned] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  const [isTextareaFocused, setIsTextareaFocused] = useState(false)
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [fileMentionMatchesState, setFileMentionMatchesState] = useState<{
    key: string | null
    matches: FileMentionCandidate[]
  }>({
    key: null,
    matches: []
  })

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
  const isModelSelectorLocked = runPhase === 'preparing' || runPhase === 'streaming'
  const isConfigured = settings.apiKey.trim().length > 0 && settings.model.trim().length > 0

  const defaultEnabledSkillNames = useMemo(
    () => config?.skills?.enabled ?? [],
    [config?.skills?.enabled]
  )
  const effectiveEnabledSkillNames = composerDraft.enabledSkillNames ?? defaultEnabledSkillNames
  const hasCustomSkillOverride =
    composerDraft.enabledSkillNames !== null && composerDraft.enabledSkillNames !== undefined
  const enabledSkillCount = effectiveEnabledSkillNames.length
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null
  const currentWorkspacePath = activeThread?.workspacePath ?? pendingWorkspacePath
  const isWorkspaceLocked = activeThreadId !== null && (messages[activeThreadId]?.length ?? 0) > 0
  const savedWorkspacePaths = config?.workspace?.savedPaths ?? []
  const workspaceHint = getWorkspaceHint({
    isWorkspaceLocked,
    workspacePath: currentWorkspacePath
  })
  const showWorkspaceHint = !workspaceSelectorOpen && (workspaceHintHovered || workspaceHintPinned)

  const slashMatch = SLASH_PATTERN.exec(composerValue)
  const skillPrefixMatch = SKILL_PREFIX_PATTERN.exec(composerValue)
  const atSkillPrefixMatch = AT_SKILL_PREFIX_PATTERN.exec(composerValue)
  const slashQuery = slashMatch ? slashMatch[1] : null
  const skillQuery = skillPrefixMatch
    ? skillPrefixMatch[1]
    : atSkillPrefixMatch
      ? atSkillPrefixMatch[1]
      : null
  const fileMentionMatch =
    skillQuery === null && atSkillPrefixMatch === null
      ? FILE_MENTION_PATTERN.exec(composerValue)
      : null
  const fileMentionQuery =
    fileMentionMatch && !fileMentionMatch[3].startsWith('skills:') ? fileMentionMatch[3] : null
  const fileMentionIncludeIgnored = fileMentionMatch?.[2] === '!'
  const fileMentionRequestKey =
    fileMentionQuery === null ? null : `${fileMentionIncludeIgnored ? '!' : ''}${fileMentionQuery}`
  // Only show chip when skill tag is confirmed (has trailing space/content) and popup is not active
  const skillTagMatch = skillQuery === null ? SKILL_TAG_PATTERN.exec(composerValue) : null
  const activeSkillTag = skillTagMatch ? skillTagMatch[1] : null
  const confirmedFileTags = useMemo(() => collectConfirmedFileTags(composerValue), [composerValue])
  const [validatedFileTagsState, setValidatedFileTagsState] = useState<{
    key: string | null
    tags: string[]
  }>({
    key: null,
    tags: []
  })
  const fileMentionMatches = useMemo(
    () =>
      fileMentionRequestKey !== null && fileMentionMatchesState.key === fileMentionRequestKey
        ? fileMentionMatchesState.matches
        : [],
    [fileMentionMatchesState, fileMentionRequestKey]
  )
  const confirmedFileTagsKey = confirmedFileTags.join('\n')
  const validatedFileTags = useMemo(
    () =>
      confirmedFileTags.length > 0 && validatedFileTagsState.key === confirmedFileTagsKey
        ? validatedFileTagsState.tags
        : [],
    [confirmedFileTags.length, confirmedFileTagsKey, validatedFileTagsState]
  )

  const userPrompts = useMemo(() => config?.prompts ?? [], [config?.prompts])
  const memoryEnabled = isMemoryConfigured(config)
  const canRunThreadOperations = activeThreadId !== null
  const allSlashCommands = useMemo<SlashCommand[]>(
    () => [
      ...(canRunThreadOperations
        ? [
            {
              key: 'handoff',
              label: 'Handoff',
              description: 'Compact into a new thread',
              type: 'action' as const
            }
          ]
        : []),
      ...(canRunThreadOperations && memoryEnabled
        ? [
            {
              key: 'save',
              label: 'Save Thread',
              description: 'Save to long-term memory',
              type: 'action' as const
            }
          ]
        : []),
      ...userPrompts.map((p) => ({
        key: p.keycode,
        label: `/${p.keycode}`,
        description: p.text.length > 60 ? `${p.text.slice(0, 60)}\u2026` : p.text,
        type: 'prompt' as const
      })),
      ...(availableSkills.length > 0
        ? [
            {
              key: 'skills',
              label: 'Skills',
              description: `Browse ${availableSkills.length} available skill${availableSkills.length !== 1 ? 's' : ''}`,
              type: 'skill-prefix' as const
            }
          ]
        : [])
    ],
    [canRunThreadOperations, memoryEnabled, userPrompts, availableSkills]
  )
  const matchingSlashCommands = useMemo<SlashCommand[]>(() => {
    if (skillQuery !== null) {
      const q = skillQuery.toLowerCase()
      return availableSkills
        .filter((s) => s.name.toLowerCase().startsWith(q))
        .map((s) => ({
          key: `skills:${s.name}`,
          label: s.name,
          description: s.description ?? 'No description available',
          type: 'skill' as const
        }))
    }
    if (fileMentionQuery !== null) {
      return fileMentionMatches.map((match) => ({
        key: `file:${match.path}`,
        label: match.path,
        description: 'Workspace file',
        type: 'file' as const
      }))
    }
    if (slashQuery !== null) {
      return allSlashCommands.filter((cmd) => cmd.key.startsWith(slashQuery))
    }
    return []
  }, [
    skillQuery,
    fileMentionQuery,
    fileMentionMatches,
    slashQuery,
    allSlashCommands,
    availableSkills
  ])
  const activeQuery = skillQuery ?? fileMentionQuery ?? slashQuery
  const showSlashCommandPopup =
    (fileMentionQuery !== null || matchingSlashCommands.length > 0) &&
    dismissedSlashQuery !== activeQuery

  useEffect(() => {
    if (fileMentionQuery === null) {
      return
    }

    let cancelled = false
    const requestKey = `${fileMentionIncludeIgnored ? '!' : ''}${fileMentionQuery}`
    void window.api.yachiyo
      .searchWorkspaceFiles({
        query: fileMentionQuery,
        includeIgnored: fileMentionIncludeIgnored,
        ...(activeThreadId ? { threadId: activeThreadId } : {}),
        ...(!activeThreadId && currentWorkspacePath ? { workspacePath: currentWorkspacePath } : {})
      })
      .then((matches) => {
        if (!cancelled) {
          setFileMentionMatchesState({
            key: requestKey,
            matches
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileMentionMatchesState({
            key: requestKey,
            matches: []
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeThreadId, currentWorkspacePath, fileMentionIncludeIgnored, fileMentionQuery])

  useEffect(() => {
    if (confirmedFileTags.length === 0) {
      return
    }

    let cancelled = false
    const requestKey = confirmedFileTags.join('\n')
    void resolveValidatedFileTags({
      fileTags: confirmedFileTags,
      threadId: activeThreadId,
      workspacePath: currentWorkspacePath
    })
      .then((fileTags) => {
        if (!cancelled) {
          setValidatedFileTagsState({
            key: requestKey,
            tags: fileTags
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setValidatedFileTagsState({
            key: requestKey,
            tags: []
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeThreadId, confirmedFileTags, currentWorkspacePath])

  useEffect(() => {
    if (!workspaceHintPinned) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setWorkspaceHintPinned(false)
    }, 1800)

    return () => window.clearTimeout(timeoutId)
  }, [workspaceHintPinned])
  const prevActiveQueryRef = useRef(activeQuery)
  if (prevActiveQueryRef.current !== activeQuery) {
    prevActiveQueryRef.current = activeQuery
    setSlashSelectedIndex(0)
    setDismissedSlashQuery(null)
  }

  const dismissSlashPopup = useCallback(() => {
    setDismissedSlashQuery(activeQuery)
  }, [activeQuery])

  const { canSend, showStopButton } = getComposerActionState({
    connectionStatus,
    hasActiveRun,
    hasFailedImages: hasFailedImages || hasFailedFiles,
    hasLoadingImages: hasLoadingImages || hasLoadingFiles,
    hasPayload,
    isConfigured
  })
  const activeRunEnterBehavior =
    config?.chat?.activeRunEnterBehavior ?? DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR
  const primarySendMode = hasActiveRun
    ? activeRunEnterBehavior === 'enter-steers'
      ? 'steer'
      : 'follow-up'
    : 'normal'
  const activeRunHint =
    activeRunEnterBehavior === 'enter-steers'
      ? 'Enter to steer, Option+Enter to queue follow-up.'
      : 'Option+Enter to steer, Enter to queue follow-up.'

  const composerStatus = (() => {
    if (connectionStatus !== 'connected') {
      return {
        tone: 'error' as const,
        text: 'Local server is unavailable. Reconnect before sending.'
      }
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

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current
    if (!element) {
      return
    }

    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
    element.style.overflowY = element.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [])

  useEffect(() => {
    resizeTextarea()
  }, [composerValue, resizeTextarea])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [activeThreadId])

  useEffect(() => {
    if (!modelSelectorOpen && !skillsSelectorOpen && !toolSelectorOpen && !workspaceSelectorOpen) {
      return
    }
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node
      const clickedInsideModelSelector =
        modelSelectorRef.current && modelSelectorRef.current.contains(target)
      const clickedInsideSkillsSelector =
        skillsSelectorRef.current && skillsSelectorRef.current.contains(target)
      const clickedInsideToolSelector =
        toolSelectorRef.current && toolSelectorRef.current.contains(target)
      const clickedInsideWorkspaceSelector =
        workspaceSelectorRef.current && workspaceSelectorRef.current.contains(target)

      if (!clickedInsideModelSelector) {
        setModelSelectorOpen(false)
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
  }, [modelSelectorOpen, skillsSelectorOpen, toolSelectorOpen, workspaceSelectorOpen])

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

        setComposerValue('')
        const opKey = command.key === 'save' ? 'save-thread' : 'compact-to-another-thread'
        onSelectThreadOperation?.(opKey as ThreadContextOperationKey)
      } else if (command.type === 'skill-prefix') {
        setComposerValue('/skills:')
      } else if (command.type === 'skill') {
        const skillName = command.key.slice('skills:'.length)
        setComposerValue(`@skills:${skillName} `)
      } else if (command.type === 'file') {
        const filePath = command.key.slice('file:'.length)
        setComposerValue(
          composerValue.replace(
            FILE_MENTION_PATTERN,
            (_match, prefix: string, ignoreMarker: string) =>
              `${prefix}@${ignoreMarker}${filePath} `
          )
        )
      } else {
        const prompt = userPrompts.find((p) => p.keycode === command.key)
        if (prompt) setComposerValue(prompt.text)
      }
    },
    [canRunThreadOperations, composerValue, onSelectThreadOperation, userPrompts, setComposerValue]
  )

  const handleTextareaScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
    if (overlayRef.current) overlayRef.current.scrollTop = event.currentTarget.scrollTop
  }, [])

  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setComposerValue(event.target.value)
    },
    [setComposerValue]
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
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
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
        void sendMessage(action === 'send' ? 'normal' : action)
      }
    },
    [
      activeRunEnterBehavior,
      canSend,
      handleSlashCommandSelect,
      hasActiveRun,
      isComposing,
      matchingSlashCommands,
      dismissSlashPopup,
      sendMessage,
      showSlashCommandPopup,
      slashSelectedIndex
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

  const providerLabel =
    settings.providerName || (settings.provider === 'openai' ? 'OpenAI' : 'Anthropic')
  const modelLabel = settings.model || 'Configure provider'
  const hasModels =
    config !== null && config.providers.some((provider) => provider.modelList.enabled.length > 0)

  return (
    <div className="flex flex-col" style={{ borderTop: `1px solid ${theme.border.panel}` }}>
      {draftImages.length > 0 || draftFiles.length > 0 ? (
        <div className="composer-image-strip">
          {draftImages.map((image) => (
            <ComposerImagePreview
              key={image.id}
              image={image}
              onRemove={() => removeComposerImage(image.id, activeThreadId)}
            />
          ))}
          {draftFiles.map((file) => (
            <ComposerFilePreview
              key={file.id}
              file={file}
              onRemove={() => removeComposerFile(file.id, activeThreadId)}
            />
          ))}
        </div>
      ) : null}

      <div style={{ position: 'relative' }}>
        {showSlashCommandPopup ? (
          <SlashCommandPopup
            commands={matchingSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={handleSlashCommandSelect}
            onClose={dismissSlashPopup}
            emptyState={
              fileMentionQuery !== null ? 'No files found in the current workspace.' : undefined
            }
          />
        ) : null}
        {activeSkillTag || validatedFileTags.length > 0 ? (
          <div className="px-4 pt-2 flex flex-wrap items-center gap-2">
            {activeSkillTag ? (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{
                  maxWidth: '100%',
                  background: theme.background.accentPanel,
                  border: `1px solid ${theme.border.accent}`,
                  color: theme.text.accent
                }}
              >
                <Sparkles size={11} strokeWidth={1.7} />
                <span
                  className="font-mono"
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {activeSkillTag}
                </span>
                <button
                  type="button"
                  aria-label={`Remove skill ${activeSkillTag}`}
                  onClick={() =>
                    setComposerValue(composerValue.replace(SKILL_TAG_PATTERN, '').trimStart())
                  }
                  className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ) : null}
            {validatedFileTags.map((fileTag, index) => (
              <div
                key={`${fileTag}-${index}`}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
                style={{
                  maxWidth: '100%',
                  background: theme.background.accentPanel,
                  border: `1px solid ${theme.border.accent}`,
                  color: theme.text.accent
                }}
              >
                <Folder size={11} strokeWidth={1.7} />
                <span
                  className="font-mono"
                  style={{
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {fileTag}
                </span>
                <button
                  type="button"
                  aria-label={`Remove file ${fileTag}`}
                  onClick={() =>
                    setComposerValue(
                      composerValue
                        .replace(`@${fileTag}`, '')
                        .replace(/\s{2,}/g, ' ')
                        .trimStart()
                    )
                  }
                  className="ml-0.5 opacity-60 hover:opacity-100 transition-opacity"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div
          ref={composerInputRef}
          className="px-4 pt-3 pb-1"
          style={{ display: 'grid', position: 'relative' }}
        >
          <div
            aria-hidden
            ref={overlayRef}
            style={{
              gridArea: '1 / 1',
              fontSize: '0.875rem',
              lineHeight: '1.625',
              fontFamily: 'inherit',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              overflowY: 'hidden',
              pointerEvents: 'none',
              minHeight: '22px'
            }}
          >
            {renderComposerTextHighlights(composerValue, theme.text.primary, theme.text.accent)}
          </div>
          <textarea
            ref={textareaRef}
            value={composerValue}
            onChange={handleInput}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={handleTextareaScroll}
            onFocus={() => setIsTextareaFocused(true)}
            onBlur={() => setIsTextareaFocused(false)}
            placeholder={
              isConfigured
                ? 'Message Yachiyo...'
                : 'Open Settings and configure a provider before chatting.'
            }
            rows={1}
            className="w-full resize-none bg-transparent outline-none text-sm leading-relaxed placeholder:text-gray-400 message-selectable"
            style={{
              gridArea: '1 / 1',
              color: 'transparent',
              caretColor: 'transparent',
              padding: 0,
              minHeight: '22px',
              maxHeight: '160px'
            }}
          />
          <SmoothCaretOverlay
            textareaRef={textareaRef}
            hostRef={composerInputRef}
            enabled={true}
            trailStrength="high"
            isFocused={isTextareaFocused}
            color={theme.text.accent}
            trailColor={`rgb(75 175 201 / 0.38)`}
          />
        </div>
      </div>

      {composerStatus ? (
        <div className="px-4 pb-2">
          <div className={`composer-status composer-status--${composerStatus.tone}`}>
            {composerStatus.tone === 'error' ? (
              <AlertCircle size={12} strokeWidth={1.8} />
            ) : (
              <span className="composer-status__dot" />
            )}
            <span>{composerStatus.text}</span>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 pb-3 no-drag">
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            const images = files.filter((f) => f.type.startsWith('image/'))
            const docs = files.filter((f) => !f.type.startsWith('image/'))
            if (images.length > 0) void queueImageFiles(images)
            if (docs.length > 0) void queueDocumentFiles(docs)
            event.currentTarget.value = ''
          }}
        />

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canAddImages && !canAddFiles}
          className="p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity disabled:opacity-30"
          aria-label="Attach"
        >
          <Paperclip size={16} strokeWidth={1.5} color={theme.icon.muted} />
        </button>

        <div ref={toolSelectorRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => {
              setModelSelectorOpen(false)
              setSkillsSelectorOpen(false)
              setWorkspaceSelectorOpen(false)
              setToolSelectorOpen((open) => !open)
            }}
            className="relative p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity"
            aria-label="Tools"
            aria-expanded={toolSelectorOpen}
            aria-haspopup="menu"
          >
            <Wrench
              size={16}
              strokeWidth={1.5}
              color={enabledTools.length > 0 ? theme.icon.accent : theme.icon.muted}
            />
            {enabledTools.length > 0 ? (
              <span
                className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full text-white flex items-center justify-center"
                style={{ fontSize: '8px', background: theme.text.accent }}
              >
                {enabledTools.length}
              </span>
            ) : null}
          </button>

          {toolSelectorOpen ? (
            <ToolSelectorPopup
              enabledTools={enabledTools}
              hasActiveRun={hasActiveRun}
              onToggle={(toolName) => void toggleEnabledTool(toolName)}
              onClose={() => setToolSelectorOpen(false)}
            />
          ) : null}
        </div>

        <div ref={skillsSelectorRef} style={{ position: 'relative' }}>
          <button
            type="button"
            onClick={() => {
              setModelSelectorOpen(false)
              setToolSelectorOpen(false)
              setWorkspaceSelectorOpen(false)
              setSkillsSelectorOpen((open) => !open)
            }}
            className="relative p-1.5 rounded-lg opacity-60 hover:opacity-85 transition-opacity"
            aria-label="Skills"
            aria-expanded={skillsSelectorOpen}
            aria-haspopup="menu"
          >
            <Sparkles
              size={16}
              strokeWidth={1.5}
              color={enabledSkillCount > 0 ? theme.icon.accent : theme.icon.muted}
            />
            {enabledSkillCount > 0 ? (
              <span
                className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full text-white flex items-center justify-center"
                style={{ fontSize: '8px', background: theme.text.accent }}
              >
                {enabledSkillCount}
              </span>
            ) : null}
          </button>

          {skillsSelectorOpen ? (
            <SkillsSelectorPopup
              availableSkills={availableSkills}
              effectiveEnabledSkillNames={effectiveEnabledSkillNames}
              hasCustomOverride={hasCustomSkillOverride}
              onReset={() => setComposerEnabledSkillNames(null)}
              onToggle={(skillName) => {
                const current = hasCustomSkillOverride
                  ? effectiveEnabledSkillNames
                  : defaultEnabledSkillNames
                const next = current.includes(skillName)
                  ? current.filter((name) => name !== skillName)
                  : [...current, skillName]
                setComposerEnabledSkillNames(next)
              }}
              onClose={() => setSkillsSelectorOpen(false)}
            />
          ) : null}
        </div>

        <div
          ref={workspaceSelectorRef}
          style={{ position: 'relative' }}
          onMouseEnter={() => setWorkspaceHintHovered(true)}
          onMouseLeave={() => setWorkspaceHintHovered(false)}
        >
          <button
            type="button"
            onClick={() => {
              if (isWorkspaceLocked) {
                setWorkspaceHintPinned(true)
                return
              }

              setModelSelectorOpen(false)
              setSkillsSelectorOpen(false)
              setToolSelectorOpen(false)
              setWorkspaceSelectorOpen((open) => !open)
            }}
            className="flex items-center gap-0.5 px-1 py-1 rounded-lg text-xs font-medium transition-opacity"
            style={{
              color: theme.text.primary,
              opacity: workspaceSelectorOpen ? 1 : 0.6,
              cursor: isWorkspaceLocked ? 'default' : 'pointer'
            }}
            aria-label="Workspace selection"
            aria-expanded={workspaceSelectorOpen}
            aria-haspopup="menu"
            disabled={isWorkspaceLocked}
          >
            <Folder
              size={12}
              strokeWidth={1.5}
              color={currentWorkspacePath ? theme.icon.accent : theme.icon.muted}
            />
            <ChevronDown
              size={10}
              strokeWidth={1.5}
              color={theme.icon.muted}
              style={{
                transform: workspaceSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.15s ease'
              }}
            />
          </button>

          {showWorkspaceHint ? (
            <div
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 8px)',
                left: 0,
                width: 260,
                padding: '10px 11px',
                borderRadius: 12,
                background: theme.background.surfaceFrosted,
                backdropFilter: 'blur(18px)',
                WebkitBackdropFilter: 'blur(18px)',
                border: `1px solid ${theme.border.strong}`,
                boxShadow: theme.shadow.overlay,
                zIndex: 45
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: theme.text.primary,
                  lineHeight: 1.35
                }}
              >
                {workspaceHint.title}
              </div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: 12,
                  color: theme.text.muted,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word'
                }}
              >
                {workspaceHint.detail}
              </div>
            </div>
          ) : null}

          {workspaceSelectorOpen && !isWorkspaceLocked ? (
            <WorkspaceSelectorPopup
              currentWorkspacePath={currentWorkspacePath}
              savedPaths={savedWorkspacePaths}
              onSelectWorkspace={(workspacePath) => {
                void setThreadWorkspace(workspacePath)
              }}
              onChooseDirectory={() => {
                void (async () => {
                  const pickedPath = await window.api.yachiyo.pickWorkspaceDirectory()
                  if (!pickedPath) {
                    return
                  }

                  if (config) {
                    const nextSavedPaths = [...new Set([...savedWorkspacePaths, pickedPath])]
                    await window.api.yachiyo.saveConfig({
                      ...config,
                      workspace: {
                        ...config.workspace,
                        savedPaths: nextSavedPaths
                      }
                    })
                  }

                  await setThreadWorkspace(pickedPath)
                })()
              }}
              onClose={() => setWorkspaceSelectorOpen(false)}
            />
          ) : null}
        </div>

        <div ref={modelSelectorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (!hasModels || isModelSelectorLocked) {
                return
              }

              setSkillsSelectorOpen(false)
              setToolSelectorOpen(false)
              setWorkspaceSelectorOpen(false)
              setModelSelectorOpen((open) => !open)
            }}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-opacity ml-0.5"
            style={{
              color: theme.text.primary,
              opacity: modelSelectorOpen ? 1 : 0.6,
              cursor: hasModels && !isModelSelectorLocked ? 'pointer' : 'default'
            }}
            aria-label="Model selection"
            type="button"
          >
            <CircleCheck
              size={12}
              strokeWidth={1.5}
              color={isConfigured ? theme.icon.success : theme.icon.muted}
            />
            {providerLabel} - {modelLabel}
            {hasModels ? (
              <ChevronDown
                size={10}
                strokeWidth={1.5}
                color={theme.icon.muted}
                style={{
                  transform: modelSelectorOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease'
                }}
              />
            ) : null}
          </button>

          {modelSelectorOpen && config && !isModelSelectorLocked ? (
            <ModelSelectorPopup
              config={config}
              currentProviderName={settings.providerName}
              currentModel={settings.model}
              onSelect={(providerName, model) => void selectModel(providerName, model)}
              onClose={() => setModelSelectorOpen(false)}
            />
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {showStopButton ? (
            <button
              type="button"
              onClick={() => void cancelActiveRun()}
              className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
              style={{
                background: theme.background.accentPanel,
                border: `1px solid ${theme.border.accent}`
              }}
              aria-label="Stop generation"
              title="Stop generation"
            >
              <Square size={10} fill={theme.text.accent} strokeWidth={0} />
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              if (!canSend) return
              setModelSelectorOpen(false)
              setSkillsSelectorOpen(false)
              setToolSelectorOpen(false)
              setWorkspaceSelectorOpen(false)
              void sendMessage(primarySendMode)
            }}
            disabled={!canSend}
            className="w-8 h-8 rounded-lg flex items-center justify-center transition-all"
            style={{
              background: canSend ? theme.text.accent : theme.border.panel,
              cursor: canSend ? 'pointer' : 'default'
            }}
            aria-label={
              primarySendMode === 'steer'
                ? 'Steer reply'
                : primarySendMode === 'follow-up'
                  ? 'Queue follow-up'
                  : 'Send'
            }
            title={
              primarySendMode === 'steer'
                ? 'Steer reply'
                : primarySendMode === 'follow-up'
                  ? 'Queue follow-up'
                  : 'Send'
            }
          >
            <SendHorizonal
              size={14}
              strokeWidth={1.8}
              color={canSend ? theme.text.inverse : theme.icon.placeholder}
            />
          </button>
        </div>
      </div>
    </div>
  )
}
