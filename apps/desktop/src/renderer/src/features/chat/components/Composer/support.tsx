/* eslint-disable react-refresh/only-export-components */
import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  Brain,
  ChevronDown,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  ListChecks,
  LoaderCircle,
  Timer,
  X
} from 'lucide-react'
import type { ComposerFileDraft, ComposerImageDraft } from '@renderer/app/store/useAppStore'
import type { Message, RunRecord, TodoItemRecord } from '@renderer/app/types'
import type { ChatInputBufferPayload } from '@renderer/features/chat/lib/composer/chatInputBuffer'
import { getTodoProgressCount } from '@renderer/features/chat/lib/todo-progress/todoProgressPresentation'
import { theme } from '@renderer/theme/theme'
import {
  ACCEPTED_ATTACHMENT_FILE_EXTENSIONS,
  ACCEPTED_ATTACHMENT_MEDIA_TYPES
} from '@yachiyo/shared/attachmentFileTypes'

export const NEW_THREAD_DRAFT_KEY = '__new__'
export const EMPTY_MESSAGES: Message[] = []
export const EMPTY_RUNS: RunRecord[] = []
export const MAX_COMPOSER_IMAGES = 4
export const MAX_COMPOSER_FILES = 10
export const FILE_MENTION_PAGE_SIZE = 24
export const FILE_MENTION_MAX_RESULTS = 120
/** Text stack cap; inner wrapper uses hard clip so grid min-content cannot paint into the toolbar. */
export const COMPOSER_TEXT_FIELD_MAX_HEIGHT_PX = 220

export const ACCEPTED_FILE_TYPES = [...ACCEPTED_ATTACHMENT_MEDIA_TYPES]

export const ACCEPT_ATTRIBUTE = [
  'image/*',
  'text/*',
  ...ACCEPTED_FILE_TYPES,
  ...ACCEPTED_ATTACHMENT_FILE_EXTENSIONS
].join(',')

export const COMPOSER_TAG_HIGHLIGHT_RE =
  /@skills:[a-zA-Z0-9_-]+|@!?"[^"]+"|@!?[\p{L}\p{N}\p{M}._/-]+|#[a-zA-Z][a-zA-Z0-9_-]+/gu
export const CONFIRMED_FILE_TAG_RE = /(^|\s)@(!?"[^"]+"|!?[\p{L}\p{N}\p{M}._/-]+)(?=\s|$)/gu
export const SKILL_TAG_PATTERN = /^@skills:([a-zA-Z0-9_-]+)(\s|$)/
export const SLASH_PATTERN = /^\/([a-zA-Z0-9-]*)$/
export const SKILL_PREFIX_PATTERN = /^\/skills:([a-zA-Z0-9_-]*)$/
export const AT_SKILL_PREFIX_PATTERN = /^@skills:([a-zA-Z0-9_-]*)$/
export const FILE_MENTION_PATTERN = /(^|\s)@(!?)(?:"([^"]*)"?|([\p{L}\p{N}\p{M}._/-]*))$/u

export interface PendingWorkspaceChangeConfirmation {
  threadId: string | null
  currentWorkspacePath: string | null
  nextWorkspacePath: string | null
  saveWorkspacePath?: string
  title?: string
  description?: string
}

export interface AttachmentUploadNotice {
  tone: 'muted' | 'error'
  text: string
}

export function renderComposerTextHighlights(
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
    const isThingTag = matched.startsWith('#')
    // For file tags, strip the leading @ (and optional !) and surrounding quotes to check against validated set
    let fileTagKey =
      isSkillTag || isThingTag ? null : matched.slice(matched.startsWith('@!') ? 2 : 1)
    if (fileTagKey?.startsWith('"') && fileTagKey.endsWith('"'))
      fileTagKey = fileTagKey.slice(1, -1)
    const isHighlighted =
      isSkillTag || isThingTag || (fileTagKey !== null && validatedSet.has(fileTagKey))

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

export const SELECTION_BG = 'rgb(var(--yachiyo-rgb-accent) / 0.25)'

/**
 * Render a single pretext line with optional selection highlight.
 * `lineCharStart` is the character offset of this line in the full text.
 */
export function renderPretextLine(
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

export function collectConfirmedFileTags(text: string): string[] {
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

export async function resolveValidatedFileTags(input: {
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

export function createDraftImageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `image-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
}

export function readFileAsDataUrl(file: File): Promise<string> {
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

export function getImageStatusLabel(image: ComposerImageDraft): string {
  if (image.status === 'loading') {
    return 'Loading'
  }

  if (image.status === 'failed') {
    return 'Needs attention'
  }

  return 'Ready'
}

export function getFileStatusLabel(file: ComposerFileDraft): string {
  if (file.status === 'loading') return 'Loading'
  if (file.status === 'failed') return 'Needs attention'
  return 'Ready'
}

export function ComposerFilePreview({
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

export function getWorkspaceLabel(workspacePath: string | null): string {
  if (!workspacePath) {
    return 'Temp workspace'
  }

  return workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
}

export type WorkspaceSwitchLockReason = 'active-run' | 'pending-plan'

export function getWorkspaceHint(input: {
  workspacePath: string | null
  lockReason?: WorkspaceSwitchLockReason | null
}): {
  title: string
  detail: string
} {
  if (input.lockReason === 'active-run') {
    return {
      title: 'Workspace locked while running',
      detail: 'Wait for the current run to finish before switching workspace.'
    }
  }

  if (input.lockReason === 'pending-plan') {
    return {
      title: 'Workspace locked by pending plan',
      detail: 'Accept or reject the pending plan before switching workspace.'
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

export function ComposerImagePreview({
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

export const STAGED_RING_SIZE_PX = 30
export const STAGED_RING_RADIUS = 12
export const STAGED_RING_CIRCUMFERENCE = 2 * Math.PI * STAGED_RING_RADIUS

export function StagedInputBufferBubble({
  staged,
  progress,
  remainingMs,
  onSendNow,
  onCancel
}: {
  staged: ChatInputBufferPayload
  progress: number
  remainingMs: number
  onSendNow: () => void
  onCancel: () => void
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [staged.content])

  const clampedProgress = Math.max(0, Math.min(1, progress))
  const dashOffset = STAGED_RING_CIRCUMFERENCE * clampedProgress
  const secondsRemaining = Math.max(0, Math.ceil(remainingMs / 1000))
  const attachmentSummary: string[] = []
  if (staged.images.length > 0) {
    attachmentSummary.push(`${staged.images.length} image${staged.images.length === 1 ? '' : 's'}`)
  }
  if (staged.attachments.length > 0) {
    attachmentSummary.push(
      `${staged.attachments.length} file${staged.attachments.length === 1 ? '' : 's'}`
    )
  }

  return (
    <div
      className="group flex items-start gap-3 px-4 py-2.5"
      style={{
        background: theme.background.accentSoft,
        borderBottom: `1px solid ${theme.border.accent}`
      }}
    >
      <div
        className="relative flex items-center justify-center shrink-0"
        style={{ width: STAGED_RING_SIZE_PX, height: STAGED_RING_SIZE_PX }}
        aria-label={`Merging next message in ${secondsRemaining}s`}
      >
        <svg
          width={STAGED_RING_SIZE_PX}
          height={STAGED_RING_SIZE_PX}
          viewBox={`0 0 ${STAGED_RING_SIZE_PX} ${STAGED_RING_SIZE_PX}`}
        >
          <circle
            cx={STAGED_RING_SIZE_PX / 2}
            cy={STAGED_RING_SIZE_PX / 2}
            r={STAGED_RING_RADIUS}
            fill="none"
            stroke={theme.border.panel}
            strokeWidth={2}
          />
          <circle
            cx={STAGED_RING_SIZE_PX / 2}
            cy={STAGED_RING_SIZE_PX / 2}
            r={STAGED_RING_RADIUS}
            fill="none"
            stroke={theme.text.accent}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={STAGED_RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            transform={`rotate(-90 ${STAGED_RING_SIZE_PX / 2} ${STAGED_RING_SIZE_PX / 2})`}
          />
        </svg>
        <Brain
          size={14}
          strokeWidth={1.8}
          className="absolute animate-spin"
          style={{
            color: theme.text.accent,
            animationDuration: '2.2s',
            animationDirection: 'reverse'
          }}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] font-medium uppercase tracking-wide mb-0.5"
          style={{ color: theme.text.accent }}
        >
          Merging next message · {secondsRemaining}s
        </div>
        {staged.content.length > 0 ? (
          <div
            ref={contentRef}
            data-composer-wheel-local-scroll
            className="text-sm whitespace-pre-wrap wrap-break-word"
            style={{
              color: theme.text.primary,
              maxHeight: 80,
              overflowY: 'auto',
              overscrollBehavior: 'contain'
            }}
          >
            {staged.content}
          </div>
        ) : (
          <div className="text-sm italic" style={{ color: theme.text.muted }}>
            (attachments only)
          </div>
        )}
        {attachmentSummary.length > 0 ? (
          <div className="text-xs mt-1" style={{ color: theme.text.secondary }}>
            {attachmentSummary.join(' · ')}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onSendNow}
          className="text-xs px-2 py-1 rounded transition-colors"
          style={{ color: theme.text.accent }}
          aria-label="Send buffered message now"
        >
          Send now
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2 py-1 rounded transition-colors"
          style={{ color: theme.text.muted }}
          aria-label="Cancel buffered message"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function TodoProgressWidget({
  items
}: {
  items: TodoItemRecord[]
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const [panelOffsetX, setPanelOffsetX] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!expanded) {
      return undefined
    }

    const handler = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) {
        return
      }
      if (wrapperRef.current?.contains(target)) {
        return
      }
      setPanelOffsetX(0)
      setExpanded(false)
    }

    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handler)
    }
  }, [expanded])

  useLayoutEffect(() => {
    if (!expanded) {
      return undefined
    }

    const updateOffset = (): void => {
      const panel = panelRef.current
      if (!panel) {
        return
      }

      const shell = wrapperRef.current?.closest('.composer-shell')
      const boundary =
        shell instanceof HTMLElement
          ? shell.getBoundingClientRect()
          : {
              left: 16,
              right: window.innerWidth - 16
            }
      const rect = panel.getBoundingClientRect()
      const baseLeft = rect.left - panelOffsetX
      const baseRight = rect.right - panelOffsetX
      const padding = 8
      let nextOffset = 0
      if (baseLeft < boundary.left + padding) {
        nextOffset = boundary.left + padding - baseLeft
      } else if (baseRight > boundary.right - padding) {
        nextOffset = boundary.right - padding - baseRight
      }
      setPanelOffsetX((current) => (current === nextOffset ? current : nextOffset))
    }

    updateOffset()
    window.addEventListener('resize', updateOffset)
    return () => window.removeEventListener('resize', updateOffset)
  }, [expanded, items.length, panelOffsetX])

  if (items.length === 0) {
    return null
  }

  const progress = getTodoProgressCount(items)
  const allCompleted = progress.completed === progress.total

  return (
    <div ref={wrapperRef} className="relative" style={{ pointerEvents: 'auto' }}>
      <button
        type="button"
        className="composer-task-chip-button"
        onClick={() =>
          setExpanded((value) => {
            if (!value) {
              setPanelOffsetX(0)
            }
            return !value
          })
        }
        data-open={expanded ? 'true' : undefined}
        data-running={!allCompleted ? 'true' : undefined}
        aria-expanded={expanded}
        aria-label="Toggle task progress details"
      >
        <ListChecks
          size={13}
          strokeWidth={1.8}
          className={allCompleted ? 'shrink-0' : 'shrink-0 animate-pulse'}
          color={allCompleted ? theme.icon.muted : theme.icon.accent}
        />
        <span style={{ color: allCompleted ? theme.text.secondary : theme.text.accent }}>
          Task progress
        </span>
        <span style={{ color: theme.text.muted }}>
          {progress.completed}/{progress.total} Step
        </span>
        <ChevronDown
          size={12}
          strokeWidth={1.7}
          className="shrink-0"
          color={theme.icon.muted}
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease'
          }}
        />
      </button>
      {expanded ? (
        <div
          ref={panelRef}
          className="absolute left-0"
          style={{
            bottom: 'calc(100% + 8px)',
            width: 320,
            maxWidth: 'calc(100vw - 32px)',
            padding: '10px 11px',
            borderRadius: 12,
            background: theme.background.surfaceFrosted,
            backdropFilter: 'blur(18px)',
            WebkitBackdropFilter: 'blur(18px)',
            border: `1px solid ${theme.border.strong}`,
            boxShadow: theme.shadow.overlay,
            transform: `translateX(${panelOffsetX}px)`,
            zIndex: 55
          }}
        >
          <div className="text-[11px] font-medium mb-2" style={{ color: theme.text.accent }}>
            Task progress
          </div>
          <div className="flex flex-col gap-1.5">
            {items.map((item) => {
              const active = item.status === 'in_progress'
              const completed = item.status === 'completed'
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-2 min-w-0"
                  style={{ opacity: completed ? 0.55 : 1 }}
                >
                  <TodoStatusIcon status={item.status} />
                  <div
                    className="text-xs leading-5 wrap-break-word min-w-0"
                    style={{
                      color: active ? theme.text.primary : theme.text.secondary,
                      fontWeight: active ? 600 : 400,
                      textDecoration: completed ? 'line-through' : 'none'
                    }}
                  >
                    {item.content}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function TodoStatusIcon({ status }: { status: TodoItemRecord['status'] }): React.JSX.Element {
  if (status === 'completed') {
    return (
      <CheckCircle2
        size={14}
        strokeWidth={1.8}
        className="mt-0.5 shrink-0"
        color={theme.icon.muted}
      />
    )
  }

  if (status === 'in_progress') {
    return (
      <CircleDot
        size={14}
        strokeWidth={1.9}
        className="mt-0.5 shrink-0 animate-pulse"
        color={theme.icon.accent}
      />
    )
  }

  return <Circle size={14} strokeWidth={1.7} className="mt-0.5 shrink-0" color={theme.icon.muted} />
}

export function QueuedFollowUpBufferBubble({
  message,
  onEdit,
  onRemove
}: {
  message: Message
  onEdit: () => void
  onRemove?: () => void
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [message.content])

  const attachmentSummary: string[] = []
  const imageCount = message.images?.length ?? 0
  const fileCount = message.attachments?.length ?? 0
  if (imageCount > 0) {
    attachmentSummary.push(`${imageCount} image${imageCount === 1 ? '' : 's'}`)
  }
  if (fileCount > 0) {
    attachmentSummary.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`)
  }

  return (
    <div
      className="group flex items-start gap-3 px-4 py-2.5"
      style={{
        background: theme.background.accentSoft,
        borderBottom: `1px solid ${theme.border.accent}`
      }}
    >
      <div
        className="relative flex items-center justify-center shrink-0 rounded-full"
        style={{
          width: STAGED_RING_SIZE_PX,
          height: STAGED_RING_SIZE_PX,
          border: `1px solid ${theme.border.accent}`,
          color: theme.text.accent
        }}
        aria-label="Queued follow-up"
      >
        <Timer size={14} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[11px] font-medium uppercase tracking-wide mb-0.5"
          style={{ color: theme.text.accent }}
        >
          Queued follow-up
        </div>
        {message.content.length > 0 ? (
          <div
            ref={contentRef}
            data-composer-wheel-local-scroll
            className="text-sm whitespace-pre-wrap wrap-break-word"
            style={{
              color: theme.text.primary,
              maxHeight: 80,
              overflowY: 'auto',
              overscrollBehavior: 'contain'
            }}
          >
            {message.content}
          </div>
        ) : (
          <div className="text-sm italic" style={{ color: theme.text.muted }}>
            (attachments only)
          </div>
        )}
        {attachmentSummary.length > 0 ? (
          <div className="text-xs mt-1" style={{ color: theme.text.secondary }}>
            {attachmentSummary.join(' · ')}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={onEdit}
          className="text-xs px-2 py-1 rounded transition-colors"
          style={{ color: theme.text.accent }}
          aria-label="Edit queued follow-up"
        >
          Edit
        </button>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs px-2 py-1 rounded transition-colors"
            style={{ color: theme.text.muted }}
            aria-label="Remove queued follow-up"
          >
            Remove
          </button>
        ) : null}
      </div>
    </div>
  )
}
