import type React from 'react'
import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  AlertCircle,
  ChevronDown,
  CircleCheck,
  Cpu,
  FileText,
  Folder,
  Paperclip,
  LoaderCircle,
  SendHorizonal,
  Sparkles,
  Square,
  TriangleAlert,
  Wrench,
  X
} from 'lucide-react'
import {
  DEFAULT_SETTINGS,
  EMPTY_COMPOSER_DRAFT,
  getEffectiveModel,
  useAppStore,
  type ComposerFileDraft,
  type ComposerImageDraft
} from '@renderer/app/store/useAppStore'
import type { FileMentionCandidate, Message } from '@renderer/app/types'
import { getComposerActionState } from '@renderer/features/chat/lib/composerActionState'
import { resolveComposerEnterAction } from '@renderer/features/chat/lib/composerEnterBehavior'
import {
  computePretextLines,
  buildFontString,
  getMeasureContext,
  navigatePretextLine,
  clearGoalX,
  resolveLineHeightPx
} from '@renderer/features/chat/lib/pretextSync'
import { theme } from '@renderer/theme/theme'
import {
  DEFAULT_ACTIVE_RUN_ENTER_BEHAVIOR,
  normalizeSkillNames
} from '../../../../../shared/yachiyo/protocol.ts'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { ModelSelectorPopup } from './ModelSelectorPopup'
import type { AcpAgentEntry } from '../lib/modelSelectorState'
import { SlashCommandPopup } from './SlashCommandPopup'
import type { SlashCommand } from './SlashCommandPopup'
import { scoreCandidates } from '../lib/completionMatch'
import { longestCommonPrefix } from '../lib/longestCommonPrefix'
import { SkillsSelectorPopup } from './SkillsSelectorPopup'
import { ToolSelectorPopup } from './ToolSelectorPopup'
import { WorkspaceSelectorPopup } from './WorkspaceSelectorPopup'
import { SmoothCaretOverlay } from './SmoothCaretOverlay'
import { formatTokenCount } from '@renderer/lib/formatTokenCount'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { Tooltip } from '@renderer/components/Tooltip'
import {
  canChangeThreadWorkspace,
  isFreshHandoffWorkspaceThread
} from '../../../../../shared/yachiyo/threadWorkspaceRules.ts'

const NEW_THREAD_DRAFT_KEY = '__new__'
const EMPTY_MESSAGES: Message[] = []
const MAX_COMPOSER_IMAGES = 4
const MAX_COMPOSER_FILES = 10
/** Text stack cap; inner wrapper uses hard clip so grid min-content cannot paint into the toolbar. */
const COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX = 160

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

const COMPOSER_TAG_HIGHLIGHT_RE = /@skills:[a-zA-Z0-9_-]+|@!?"[^"]+"|@!?[\p{L}\p{N}\p{M}._/-]+/gu
const CONFIRMED_FILE_TAG_RE = /(^|\s)@(!?"[^"]+"|!?[\p{L}\p{N}\p{M}._/-]+)(?=\s|$)/gu
const SKILL_TAG_PATTERN = /^@skills:([a-zA-Z0-9_-]+)(\s|$)/
const SLASH_PATTERN = /^\/([a-zA-Z0-9-]*)$/
const SKILL_PREFIX_PATTERN = /^\/skills:([a-zA-Z0-9_-]*)$/
const AT_SKILL_PREFIX_PATTERN = /^@skills:([a-zA-Z0-9_-]*)$/
const FILE_MENTION_PATTERN = /(^|\s)@(!?)(?:"([^"]*)"?|([\p{L}\p{N}\p{M}._/-]*))$/u

interface PendingWorkspaceChangeConfirmation {
  threadId: string | null
  currentWorkspacePath: string | null
  nextWorkspacePath: string | null
  saveWorkspacePath?: string
}

function renderComposerTextHighlights(
  text: string,
  primaryColor: string,
  accentColor: string,
  validatedFileTags: string[]
): React.ReactNode {
  const validatedSet = new Set(validatedFileTags)
  const parts: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  COMPOSER_TAG_HIGHLIGHT_RE.lastIndex = 0
  while ((m = COMPOSER_TAG_HIGHLIGHT_RE.exec(text)) !== null) {
    const matched = m[0]
    const isSkillTag = matched.startsWith('@skills:')
    // For file tags, strip the leading @ (and optional !) and surrounding quotes to check against validated set
    let fileTagKey = isSkillTag ? null : matched.slice(matched.startsWith('@!') ? 2 : 1)
    if (fileTagKey?.startsWith('"') && fileTagKey.endsWith('"'))
      fileTagKey = fileTagKey.slice(1, -1)
    const isHighlighted = isSkillTag || (fileTagKey !== null && validatedSet.has(fileTagKey))

    if (m.index > last) {
      parts.push(
        <span key={last} style={{ color: primaryColor }}>
          {text.slice(last, m.index)}
        </span>
      )
    }
    if (isHighlighted) {
      parts.push(
        <span
          key={`h${m.index}`}
          style={{ color: accentColor, textDecoration: 'underline', textUnderlineOffset: '2px' }}
        >
          {matched}
        </span>
      )
    } else {
      parts.push(
        <span key={`h${m.index}`} style={{ color: primaryColor }}>
          {matched}
        </span>
      )
    }
    last = m.index + matched.length
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

const SELECTION_BG = 'rgb(75 175 201 / 0.25)'

/**
 * Render a single pretext line with optional selection highlight.
 * `lineCharStart` is the character offset of this line in the full text.
 */
function renderPretextLine(
  lineText: string,
  lineCharStart: number,
  selRange: [number, number] | null,
  primaryColor: string,
  accentColor: string,
  validatedFileTags: string[]
): React.ReactNode {
  if (!lineText) return '\u200b'

  const lineEnd = lineCharStart + lineText.length

  // No selection or no intersection → plain highlights
  if (!selRange || selRange[0] >= lineEnd || selRange[1] <= lineCharStart) {
    return (
      renderComposerTextHighlights(lineText, primaryColor, accentColor, validatedFileTags) ||
      '\u200b'
    )
  }

  const localStart = Math.max(0, selRange[0] - lineCharStart)
  const localEnd = Math.min(lineText.length, selRange[1] - lineCharStart)

  // Full line selected
  if (localStart === 0 && localEnd === lineText.length) {
    return (
      <span style={{ backgroundColor: SELECTION_BG }}>
        {renderComposerTextHighlights(lineText, primaryColor, accentColor, validatedFileTags) ||
          lineText}
      </span>
    )
  }

  // Partial selection — split into before / selected / after
  const before = lineText.slice(0, localStart)
  const selected = lineText.slice(localStart, localEnd)
  const after = lineText.slice(localEnd)

  return (
    <>
      {before && renderComposerTextHighlights(before, primaryColor, accentColor, validatedFileTags)}
      <span style={{ backgroundColor: SELECTION_BG }}>
        {renderComposerTextHighlights(selected, primaryColor, accentColor, validatedFileTags) ||
          selected}
      </span>
      {after && renderComposerTextHighlights(after, primaryColor, accentColor, validatedFileTags)}
    </>
  )
}

function collectConfirmedFileTags(text: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  CONFIRMED_FILE_TAG_RE.lastIndex = 0
  while ((match = CONFIRMED_FILE_TAG_RE.exec(text)) !== null) {
    let value = match[2]?.trim() ?? ''
    // Strip leading ! and surrounding quotes for the tag key
    if (value.startsWith('!')) value = value.slice(1)
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
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
        limit: 1
      })

      if (
        matches.some(
          (match) => match.path === query && Boolean(match.includeIgnored) === includeIgnored
        )
      ) {
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
  const effectiveModel = useAppStore(useShallow(getEffectiveModel))
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
  const activeThreadMessages = useAppStore((s) =>
    s.activeThreadId ? (s.messages[s.activeThreadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
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
  const enabledTools = useAppStore((s) => s.enabledTools)
  const editingMessage = useAppStore((s) => (s.activeThreadId ? s.editingMessage : null))
  const cancelEditMessage = useAppStore((s) => s.cancelEditMessage)
  const removeComposerImage = useAppStore((s) => s.removeComposerImage)
  const removeComposerFile = useAppStore((s) => s.removeComposerFile)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const selectModel = useAppStore((s) => s.selectModel)
  const pushToast = useAppStore((s) => s.pushToast)
  const setComposerEnabledSkillNames = useAppStore((s) => s.setComposerEnabledSkillNames)
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
  const overlayRef = useRef<HTMLDivElement>(null)
  const composerInputRef = useRef<HTMLDivElement>(null)
  const popupContainerRef = useRef<HTMLDivElement>(null)
  const modelSelectorRef = useRef<HTMLDivElement>(null)
  const skillsSelectorRef = useRef<HTMLDivElement>(null)
  const toolSelectorRef = useRef<HTMLDivElement>(null)
  const workspaceSelectorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** Set when the user inserts a hard/soft line break so we scroll after layout (hidden native caret). */
  const scrollComposerToEndAfterBreakRef = useRef(false)
  /** True when any composer popup is open; used by the auto-focus keydown listener. */
  const anyPopupOpenRef = useRef(false)
  const composerRootRef = useRef<HTMLDivElement>(null)

  const [modelSelectorOpen, setModelSelectorOpen] = useState(false)
  const [skillsSelectorOpen, setSkillsSelectorOpen] = useState(false)
  const [toolSelectorOpen, setToolSelectorOpen] = useState(false)
  const [workspaceSelectorOpen, setWorkspaceSelectorOpen] = useState(false)
  const [workspaceHintHovered, setWorkspaceHintHovered] = useState(false)
  const [workspaceHintPinned, setWorkspaceHintPinned] = useState(false)
  const [isBackendSwitchPending, setIsBackendSwitchPending] = useState(false)
  const [pendingWorkspaceChangeConfirmation, setPendingWorkspaceChangeConfirmation] =
    useState<PendingWorkspaceChangeConfirmation | null>(null)
  const [isComposing, setIsComposing] = useState(false)
  const [isTextareaFocused, setIsTextareaFocused] = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  // Pretext-driven overlay lines — overlay renders these instead of letting CSS wrap.
  // Guarantees the visible text breaks at the same positions pretext uses for the caret.
  const [overlayLineTexts, setOverlayLineTexts] = useState<string[] | null>(null)
  // Custom selection range for the pretext-driven overlay (native ::selection is hidden).
  const [overlaySelRange, setOverlaySelRange] = useState<[number, number] | null>(null)
  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [fileMentionMatchesState, setFileMentionMatchesState] = useState<{
    status: 'idle' | 'ready' | 'error'
    key: string | null
    matches: FileMentionCandidate[]
  }>({
    status: 'idle',
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
  const externalThreads = useAppStore((s) => s.externalThreads)
  const activeThread =
    threads.find((thread) => thread.id === activeThreadId) ??
    externalThreads.find((thread) => thread.id === activeThreadId) ??
    null
  const activeThreadMessageCount = activeThreadMessages.length
  const currentWorkspacePath = activeThread?.workspacePath ?? pendingWorkspacePath
  const activeAcpBinding =
    activeThread?.runtimeBinding?.kind === 'acp' ? activeThread.runtimeBinding : null
  // For a brand-new thread (no activeThreadId yet) the user may have picked an ACP agent
  // from the model selector. Show it in the toolbar and allow send until a thread exists.
  const effectiveAcpBinding =
    activeAcpBinding ?? (activeThreadId === null ? pendingAcpBinding : null)
  const isModelSelectorLocked =
    isBackendSwitchPending || runPhase === 'preparing' || runPhase === 'streaming'
  const needsApiKey = settings.provider !== 'vertex'
  const isConfigured =
    ((!needsApiKey || settings.apiKey.trim().length > 0) &&
      effectiveModel.model.trim().length > 0) ||
    effectiveAcpBinding !== null
  const isFreshHandoffWorkspace =
    activeThreadId !== null &&
    isFreshHandoffWorkspaceThread({
      messages: activeThreadMessages,
      threadCreatedAt: null
    })
  const isWorkspaceLocked =
    activeThreadId !== null &&
    !canChangeThreadWorkspace({
      messages: activeThreadMessages,
      threadCreatedAt: null
    })
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

  const slashMatch = useMemo(() => SLASH_PATTERN.exec(composerValue), [composerValue])
  const skillPrefixMatch = useMemo(() => SKILL_PREFIX_PATTERN.exec(composerValue), [composerValue])
  const atSkillPrefixMatch = useMemo(
    () => AT_SKILL_PREFIX_PATTERN.exec(composerValue),
    [composerValue]
  )
  const slashQuery = slashMatch ? slashMatch[1] : null
  const skillQuery = skillPrefixMatch
    ? skillPrefixMatch[1]
    : atSkillPrefixMatch
      ? atSkillPrefixMatch[1]
      : null
  const fileMentionMatch = useMemo(() => {
    if (skillQuery !== null || atSkillPrefixMatch !== null) return null
    return FILE_MENTION_PATTERN.exec(composerValue)
  }, [composerValue, skillQuery, atSkillPrefixMatch])
  const fileMentionRawQuery = fileMentionMatch
    ? (fileMentionMatch[3] ?? fileMentionMatch[4] ?? '')
    : ''
  const fileMentionQuery =
    fileMentionMatch && !fileMentionRawQuery.startsWith('skills:') ? fileMentionRawQuery : null
  const fileMentionIncludeIgnored = fileMentionMatch?.[2] === '!'
  const fileMentionQueryKey =
    fileMentionQuery === null ? null : `${fileMentionIncludeIgnored ? '!' : ''}${fileMentionQuery}`
  const fileMentionSearchScopeKey =
    activeThreadId !== null ? `thread:${activeThreadId}` : `workspace:${currentWorkspacePath ?? ''}`
  const fileMentionRequestKey =
    fileMentionQueryKey === null ? null : `${fileMentionSearchScopeKey}\n${fileMentionQueryKey}`
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
  const isFileMentionSearchPending =
    fileMentionRequestKey !== null && fileMentionMatchesState.key !== fileMentionRequestKey
  const confirmedFileTagsKey = confirmedFileTags.join('\n')
  const validatedFileTags = useMemo(
    () =>
      confirmedFileTags.length > 0 && validatedFileTagsState.key === confirmedFileTagsKey
        ? validatedFileTagsState.tags
        : [],
    [confirmedFileTags.length, confirmedFileTagsKey, validatedFileTagsState]
  )

  const userPrompts = useMemo(() => config?.prompts ?? [], [config?.prompts])
  const canRunThreadOperations = activeThreadId !== null

  const commitWorkspaceSelection = useCallback(
    async (selection: PendingWorkspaceChangeConfirmation): Promise<void> => {
      if (selection.saveWorkspacePath && config) {
        const nextSavedPaths = [...new Set([...savedWorkspacePaths, selection.saveWorkspacePath])]
        await window.api.yachiyo.saveConfig({
          ...config,
          workspace: {
            ...config.workspace,
            savedPaths: nextSavedPaths
          }
        })
      }

      if (selection.currentWorkspacePath === selection.nextWorkspacePath) {
        return
      }

      await setThreadWorkspace(selection.nextWorkspacePath, selection.threadId)
    },
    [config, savedWorkspacePaths, setThreadWorkspace]
  )

  const requestWorkspaceSelection = useCallback(
    (selection: PendingWorkspaceChangeConfirmation): void => {
      const workspaceChanged = selection.currentWorkspacePath !== selection.nextWorkspacePath

      if (isFreshHandoffWorkspace && workspaceChanged) {
        setPendingWorkspaceChangeConfirmation(selection)
        return
      }

      void commitWorkspaceSelection(selection)
    },
    [commitWorkspaceSelection, isFreshHandoffWorkspace]
  )
  const allSlashCommands = useMemo<SlashCommand[]>(
    () => [
      ...(canRunThreadOperations && runStatus !== 'running'
        ? [
            {
              key: 'handoff',
              label: 'Handoff',
              description: 'Compact into a new thread',
              type: 'action' as const
            }
          ]
        : []),
      ...(canRunThreadOperations
        ? [
            {
              key: 'archive',
              label: 'Archive',
              description: 'Archive this thread',
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
    [canRunThreadOperations, runStatus, userPrompts, availableSkills]
  )
  const matchingSlashCommands = useMemo<SlashCommand[]>(() => {
    if (skillQuery !== null) {
      return scoreCandidates(availableSkills, skillQuery, (s) => [s.name, s.description ?? '']).map(
        ({ item: s }) => ({
          key: `skills:${s.name}`,
          label: s.name,
          description: s.description ?? 'No description available',
          type: 'skill' as const
        })
      )
    }
    if (fileMentionQuery !== null) {
      // Rank backend results by basename-first match on the raw query.
      return scoreCandidates(fileMentionMatches, fileMentionQuery, (match) => {
        const base = match.path.slice(match.path.lastIndexOf('/') + 1)
        return [base, match.path]
      }).map(({ item: match }) => ({
        key: `file:${match.includeIgnored ? '!' : ''}${match.path}`,
        label: `${match.includeIgnored ? '!' : ''}${match.path}`,
        description:
          match.kind === 'jotdown'
            ? 'Latest jot down'
            : match.includeIgnored
              ? 'Ignored workspace path'
              : 'Workspace path',
        type: match.kind === 'jotdown' ? ('jotdown' as const) : ('file' as const)
      }))
    }
    if (slashQuery !== null) {
      return scoreCandidates(allSlashCommands, slashQuery, (cmd) => [cmd.key, cmd.label]).map(
        ({ item }) => item
      )
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

  anyPopupOpenRef.current =
    modelSelectorOpen ||
    skillsSelectorOpen ||
    toolSelectorOpen ||
    workspaceSelectorOpen ||
    showSlashCommandPopup ||
    pendingWorkspaceChangeConfirmation !== null

  const [fileMentionAnchorRect, setFileMentionAnchorRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (!fileMentionMatch || !textareaRef.current) {
      setFileMentionAnchorRect(null)
      return
    }
    const textarea = textareaRef.current
    const textareaRect = textarea.getBoundingClientRect()
    const lines = computePretextLines(textarea.value, textarea)
    if (!lines) {
      setFileMentionAnchorRect(null)
      return
    }

    const atIndex = fileMentionMatch.index + fileMentionMatch[1].length
    const value = textarea.value

    // Find which line contains atIndex and the offset within that line
    let charOffset = 0
    let lineText = ''
    let offsetInLine = 0
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].text.length
      if (atIndex < charOffset + lineLen) {
        lineText = lines[i].text
        offsetInLine = atIndex - charOffset
        break
      }
      let nextOffset = charOffset + lineLen
      if (nextOffset < value.length && value[nextOffset] === '\r') nextOffset++
      if (nextOffset < value.length && value[nextOffset] === '\n') nextOffset++
      charOffset = nextOffset > charOffset + lineLen ? nextOffset : charOffset + lineLen
    }

    const cs = getComputedStyle(textarea)
    const paddingLeft = parseFloat(cs.paddingLeft)
    const borderLeftWidth = parseFloat(cs.borderLeftWidth)
    const ctx = getMeasureContext() as CanvasRenderingContext2D
    ctx.font = buildFontString(cs)
    const textWidth = ctx.measureText(lineText.slice(0, offsetInLine)).width
    const atX = textareaRect.left + borderLeftWidth + paddingLeft + textWidth
    const atY = textareaRect.top
    const lineHeightPx = resolveLineHeightPx(cs)
    setFileMentionAnchorRect(new DOMRect(atX, atY, 0, lineHeightPx))
  }, [composerValue, fileMentionMatch])

  useEffect(() => {
    if (fileMentionQuery === null) {
      return
    }

    let cancelled = false
    const timeoutId = window.setTimeout(() => {
      void window.api.yachiyo
        .searchWorkspaceFiles({
          query: fileMentionQuery,
          includeIgnored: fileMentionIncludeIgnored,
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          ...(!activeThreadId && currentWorkspacePath
            ? { workspacePath: currentWorkspacePath }
            : {})
        })
        .then((matches) => {
          if (!cancelled) {
            setFileMentionMatchesState({
              status: 'ready',
              key: fileMentionRequestKey,
              matches
            })
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFileMentionMatchesState({
              status: 'error',
              key: fileMentionRequestKey,
              matches: []
            })
          }
        })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timeoutId)
    }
  }, [
    activeThreadId,
    currentWorkspacePath,
    fileMentionIncludeIgnored,
    fileMentionQuery,
    fileMentionRequestKey
  ])

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
  const canSend = canSendBase && !isSendInFlight

  const dispatchSend = useCallback(
    (mode: 'normal' | 'steer' | 'follow-up') => {
      if (inFlightSendIdRef.current !== null) return
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
    [sendMessage]
  )
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

        if (command.key === 'handoff' && runStatus === 'running') {
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
      runStatus,
      composerValue,
      onSelectThreadOperation,
      userPrompts,
      setComposerValue
    ]
  )

  const handleTextareaScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
    if (!overlayRef.current) return
    const ta = event.currentTarget
    const o = overlayRef.current
    // Don't pull overlay back when textarea is at max scroll but overlay can scroll further
    // (trailing-newline sentinel gives overlay more scroll range)
    const taMax = ta.scrollHeight - ta.clientHeight
    if (ta.scrollTop >= taMax - 1 && o.scrollTop > ta.scrollTop) return
    o.scrollTop = ta.scrollTop
  }, [])

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

      if (event.key === 'Escape') {
        if (isComposing || event.nativeEvent.isComposing) return
        if (modelSelectorOpen || skillsSelectorOpen || toolSelectorOpen || workspaceSelectorOpen) {
          event.preventDefault()
          setModelSelectorOpen(false)
          setSkillsSelectorOpen(false)
          setToolSelectorOpen(false)
          setWorkspaceSelectorOpen(false)
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
      matchingSlashCommands,
      dismissSlashPopup,
      dispatchSend,
      modelSelectorOpen,
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
      skillsSelectorOpen,
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

  const handleDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current++
    if (event.dataTransfer.types.includes('Files')) {
      setIsDragOver(true)
    }
  }, [])

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragOver(false)
    }
  }, [])

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
    [queueImageFiles, queueDocumentFiles]
  )

  const providerLabel =
    effectiveModel.providerName || (settings.provider === 'openai' ? 'OpenAI' : 'Anthropic')
  const modelLabel = effectiveModel.model || 'Configure provider'
  const hasModels =
    config !== null && config.providers.some((provider) => provider.modelList.enabled.length > 0)
  const hasAcpAgents =
    config !== null && (config.subagentProfiles ?? []).some((p) => p.enabled && p.showInChatPicker)
  const canOpenModelPicker = hasModels || hasAcpAgents

  return (
    <div
      ref={composerRootRef}
      className="flex flex-col"
      style={{ borderTop: `1px solid ${theme.border.panel}`, position: 'relative' }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `color-mix(in srgb, ${theme.background.accentPanel} 85%, transparent)`,
            border: `2px dashed ${theme.text.accent}`,
            borderRadius: 8,
            pointerEvents: 'none'
          }}
        >
          <span
            style={{
              fontSize: '0.8125rem',
              fontWeight: 500,
              color: theme.text.accent
            }}
          >
            Drop files to attach
          </span>
        </div>
      ) : null}
      {editingMessage !== null ? (
        <div
          className="flex items-center justify-between px-4 py-1.5"
          style={{
            background: theme.background.accentPanel,
            borderBottom: `1px solid ${theme.border.accent}`
          }}
        >
          <span className="text-xs font-medium" style={{ color: theme.text.accent }}>
            Editing message
          </span>
          <button
            type="button"
            className="text-xs px-2 py-0.5 rounded transition-opacity opacity-70 hover:opacity-100"
            style={{ color: theme.text.accent }}
            onClick={cancelEditMessage}
            aria-label="Cancel editing"
          >
            Cancel
          </button>
        </div>
      ) : null}
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

      <div ref={popupContainerRef} style={{ position: 'relative' }}>
        {showSlashCommandPopup ? (
          <SlashCommandPopup
            commands={matchingSlashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={handleSlashCommandSelect}
            onClose={dismissSlashPopup}
            leftOffset={0}
            anchorRect={fileMentionQuery !== null ? fileMentionAnchorRect : null}
            portal={fileMentionQuery !== null}
            emptyState={
              fileMentionQuery !== null
                ? isFileMentionSearchPending
                  ? 'Searching workspace...'
                  : 'No files found in the current workspace.'
                : undefined
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
        <div ref={composerInputRef} className="px-4 pt-3 pb-1">
          {/*
            Input stack (same grid cell):
            - Highlight div: real text paint for @mentions etc. pointer-events:none; scrollTop synced
              from textarea in onScroll.
            - textarea: value controlled by composerValue; transparent text + hidden native caret;
              overflowY auto when content taller than COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX.
            - SmoothCaretOverlay: mirror+span measures caret in content Y; maps with textarea.scrollTop.
            resizeTextarea() preserves scroll when toggling height:auto→fixed. When already at
            max height and overflowing, it avoids height:auto so scrollHeight stays tied to the
            new value (trailing newline can scroll into view) without content padding tricks.
          */}
          <div
            style={{
              display: 'grid',
              position: 'relative',
              maxHeight: `${COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX}px`,
              minHeight: 0,
              overflow: 'hidden'
            }}
          >
            <div
              aria-hidden
              ref={overlayRef}
              className="composer-text-overlay"
              style={{
                gridArea: '1 / 1',
                position: 'relative',
                fontSize: '0.875rem',
                lineHeight: '1.625',
                fontFamily: 'inherit',
                whiteSpace: 'pre',
                overflowY: 'auto',
                pointerEvents: 'none',
                minHeight: 0,
                maxHeight: `${COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX}px`,
                letterSpacing: '0.04em'
              }}
            >
              {overlayLineTexts
                ? (() => {
                    const elements: React.ReactNode[] = []
                    let charOffset = 0
                    for (let i = 0; i < overlayLineTexts.length; i++) {
                      const lineText = overlayLineTexts[i]
                      elements.push(
                        <div key={i}>
                          {renderPretextLine(
                            lineText,
                            charOffset,
                            overlaySelRange,
                            theme.text.primary,
                            theme.text.accent,
                            validatedFileTags
                          )}
                        </div>
                      )
                      charOffset += lineText.length
                      // Skip consumed hard-break chars (\r\n or \n) between lines
                      if (charOffset < composerValue.length && composerValue[charOffset] === '\r')
                        charOffset++
                      if (charOffset < composerValue.length && composerValue[charOffset] === '\n')
                        charOffset++
                    }
                    if (composerValue.endsWith('\n')) {
                      elements.push(
                        <div key="trailing-nl">
                          {overlaySelRange && overlaySelRange[1] > charOffset ? (
                            <span style={{ backgroundColor: SELECTION_BG }}>{'\u200b'}</span>
                          ) : (
                            '\u200b'
                          )}
                        </div>
                      )
                    }
                    return elements
                  })()
                : renderComposerTextHighlights(
                    composerValue,
                    theme.text.primary,
                    theme.text.accent,
                    validatedFileTags
                  )}
            </div>
            <SmoothCaretOverlay
              textareaRef={textareaRef}
              hostRef={composerInputRef}
              highlightRef={overlayRef}
              enabled={true}
              trailStrength="high"
              isFocused={isTextareaFocused}
              color={theme.text.accent}
              trailColor={`rgb(75 175 201 / 0.38)`}
              text={composerValue}
            />
            <textarea
              ref={textareaRef}
              value={composerValue}
              onChange={handleInput}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleKeyDown}
              onPointerUp={clearGoalX}
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
              className="w-full resize-none bg-transparent outline-none text-sm leading-relaxed placeholder:text-gray-400 message-selectable composer-textarea-pretext"
              style={{
                gridArea: '1 / 1',
                color: 'transparent',
                caretColor: 'transparent',
                padding: 0,
                minHeight: '22px',
                maxHeight: `${COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX}px`,
                letterSpacing: '0.04em',
                wordBreak: 'break-word',
                overflowWrap: 'break-word'
              }}
            />
          </div>
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

        {!effectiveAcpBinding && (
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
        )}

        {!effectiveAcpBinding && (
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
        )}

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
                requestWorkspaceSelection({
                  threadId: activeThreadId,
                  currentWorkspacePath,
                  nextWorkspacePath: workspacePath
                })
              }}
              onChooseDirectory={() => {
                void (async () => {
                  const pickedPath = await window.api.yachiyo.pickWorkspaceDirectory()
                  if (!pickedPath) {
                    return
                  }

                  requestWorkspaceSelection({
                    threadId: activeThreadId,
                    currentWorkspacePath,
                    nextWorkspacePath: pickedPath,
                    saveWorkspacePath: pickedPath
                  })
                })()
              }}
              onClose={() => setWorkspaceSelectorOpen(false)}
            />
          ) : null}
        </div>

        {pendingWorkspaceChangeConfirmation ? (
          <ConfirmDialog
            title="Switch this handoff thread to a different workspace?"
            description="This thread started from a handoff and inherited the previous workspace. Changing it now will detach the handoff from that inherited folder."
            actions={[
              { key: 'keep', label: 'Keep inherited workspace' },
              { key: 'switch', label: 'Switch workspace', tone: 'accent' }
            ]}
            onClose={() => setPendingWorkspaceChangeConfirmation(null)}
            onSelect={(key) => {
              if (key !== 'switch') {
                setPendingWorkspaceChangeConfirmation(null)
                return
              }

              const selection = pendingWorkspaceChangeConfirmation
              setPendingWorkspaceChangeConfirmation(null)
              void commitWorkspaceSelection(selection)
            }}
          />
        ) : null}

        <div ref={modelSelectorRef} style={{ position: 'relative' }}>
          <button
            onClick={() => {
              if (!canOpenModelPicker || isModelSelectorLocked) {
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
              cursor: canOpenModelPicker && !isModelSelectorLocked ? 'pointer' : 'default'
            }}
            aria-label="Model selection"
            type="button"
          >
            {activeAcpBinding ? (
              <Cpu size={12} strokeWidth={1.5} color={theme.icon.accent} />
            ) : (
              <CircleCheck
                size={12}
                strokeWidth={1.5}
                color={isConfigured ? theme.icon.success : theme.icon.muted}
              />
            )}
            {effectiveAcpBinding
              ? (effectiveAcpBinding.profileName ?? effectiveAcpBinding.profileId ?? 'ACP Agent')
              : `${providerLabel} - ${modelLabel}`}
            {canOpenModelPicker ? (
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
              currentProviderName={effectiveModel.providerName}
              currentModel={effectiveModel.model}
              currentAcpProfileId={effectiveAcpBinding?.profileId ?? null}
              onSelect={async (providerName, model) => {
                await runBackendSwitch(async () => {
                  await selectModel(providerName, model)
                  if (activeAcpBinding && activeThreadId) {
                    await window.api.yachiyo.setThreadRuntimeBinding({
                      threadId: activeThreadId,
                      runtimeBinding: null
                    })
                  }
                })
                setPendingAcpBinding(null)
              }}
              onSelectAcpAgent={async (agent: AcpAgentEntry) => {
                if (activeThreadId && activeThreadMessageCount > 0) {
                  if (activeAcpBinding?.profileId !== agent.id) {
                    notifyAcpRebindBlocked()
                  }
                  return
                }

                if (activeThreadId) {
                  await runBackendSwitch(async () => {
                    await window.api.yachiyo.setThreadRuntimeBinding({
                      threadId: activeThreadId,
                      runtimeBinding: {
                        kind: 'acp',
                        profileId: agent.id,
                        profileName: agent.name,
                        sessionStatus: 'new'
                      }
                    })
                  })
                } else {
                  setPendingAcpBinding({
                    kind: 'acp',
                    profileId: agent.id,
                    profileName: agent.name,
                    sessionStatus: 'new'
                  })
                }
              }}
              onClose={() => setModelSelectorOpen(false)}
            />
          ) : null}
        </div>

        {latestRun?.promptTokens != null ? (
          <Tooltip
            content={
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>Last run token usage</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                  <span style={{ color: theme.text.secondary }}>Prompt</span>
                  <span>{latestRun.promptTokens.toLocaleString()}</span>
                </div>
                {latestRun.completionTokens != null ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                    <span style={{ color: theme.text.secondary }}>Completion</span>
                    <span>{latestRun.completionTokens.toLocaleString()}</span>
                  </div>
                ) : null}
                {latestRun.totalPromptTokens != null &&
                latestRun.totalPromptTokens !== latestRun.promptTokens ? (
                  <>
                    <div
                      style={{
                        height: 1,
                        background: theme.border.default,
                        margin: '2px 0'
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                      <span style={{ color: theme.text.secondary }}>Total prompt</span>
                      <span>{latestRun.totalPromptTokens.toLocaleString()}</span>
                    </div>
                    {latestRun.totalCompletionTokens != null ? (
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
                        <span style={{ color: theme.text.secondary }}>Total completion</span>
                        <span>{latestRun.totalCompletionTokens.toLocaleString()}</span>
                      </div>
                    ) : null}
                  </>
                ) : null}
                {(latestRun.promptTokens ?? 0) > 200_000 ? (
                  <div
                    style={{
                      marginTop: 4,
                      paddingTop: 6,
                      borderTop: `1px solid ${theme.border.default}`,
                      color: '#f59e0b',
                      fontSize: 11,
                      lineHeight: 1.4
                    }}
                  >
                    Context is over 200K. Consider using{' '}
                    <span style={{ fontFamily: 'monospace' }}>/handoff</span> to compact and
                    continue in a new thread.
                  </div>
                ) : null}
              </div>
            }
          >
            <span
              className="text-xs px-1.5 flex items-center gap-1"
              style={{ color: theme.text.secondary, opacity: 0.7, userSelect: 'none' }}
            >
              {(latestRun.promptTokens ?? 0) > 200_000 ? (
                <TriangleAlert
                  size={11}
                  style={{ color: '#f59e0b', flexShrink: 0, opacity: 1, display: 'block' }}
                />
              ) : null}
              {formatTokenCount(latestRun.promptTokens)}
            </span>
          </Tooltip>
        ) : null}

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
              dispatchSend(primarySendMode)
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
                  : editingMessage !== null
                    ? 'Update message'
                    : 'Send'
            }
            title={
              primarySendMode === 'steer'
                ? 'Steer reply'
                : primarySendMode === 'follow-up'
                  ? 'Queue follow-up'
                  : editingMessage !== null
                    ? 'Update message'
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
