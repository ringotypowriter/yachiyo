import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { AlarmClock, Check, Lock, Star } from 'lucide-react'
import type { Thread, ThreadColorTag, ThreadSentinelRecord, ToolCall } from '@renderer/app/types'
import { ThreadContextMenuPopup } from '@renderer/features/threads/components/ThreadContextMenuPopup'
import { imeSafeEnter, isDismissEscapeKey } from '@renderer/lib/imeUtils'
import {
  resolveThreadContextOperations,
  resolveThreadColorOperationTag,
  type ThreadContextOperationKey
} from '@renderer/features/threads/lib/threadContextOperations'
import {
  canCompactThreadToAnotherThread,
  isExternalThread,
  isSyncedArchiveThread
} from '@renderer/features/threads/lib/threadVisibility'
import { theme } from '@renderer/theme/theme'
import { resolveThreadTitleColor } from '@renderer/features/threads/lib/threadColorPalette'
import { resolveThreadSidebarPreview } from '@renderer/features/threads/lib/threadSidebarRows'

function extractFirstEmoji(text: string): string | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const first = [...segmenter.segment(text.trim())][0]?.segment ?? ''
  return /\p{Extended_Pictographic}/u.test(first) ? first : null
}

const TITLE_DELETE_INTERVAL_MS = 18
const TITLE_TYPE_INTERVAL_MS = 32

function useTitleAnimation(title: string, skip: boolean): string {
  const [displayed, setDisplayed] = useState(title)
  const prevTitleRef = useRef(title)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (title === prevTitleRef.current) return

    const oldTitle = prevTitleRef.current
    const newTitle = title
    prevTitleRef.current = newTitle

    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (skip) {
      setDisplayed(newTitle)
      return
    }

    let deleteLen = oldTitle.length
    let typeLen = 0

    function step(): void {
      if (deleteLen > 0) {
        deleteLen--
        setDisplayed(oldTitle.slice(0, deleteLen))
        timerRef.current = setTimeout(step, TITLE_DELETE_INTERVAL_MS)
      } else if (typeLen < newTitle.length) {
        typeLen++
        setDisplayed(newTitle.slice(0, typeLen))
        timerRef.current = setTimeout(step, TITLE_TYPE_INTERVAL_MS)
      }
    }

    step()

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [title, skip])

  return displayed
}

export function ThreadListItem({
  activeRunId,
  draftText,
  isActive,
  hasActiveRun,
  hasBackgroundWork,
  hasJustDoneRun,
  isRunActive,
  isSaving,
  currentTimeMs,
  sentinel,
  pendingPlanApproval,
  isSelectMode,
  isSelected,
  isStarred,
  isInFolder,
  threadActivationEnabled,
  threadSelectionEnabled,
  onRename,
  onSelectOperation,
  onSelectThread,
  onSetIcon,
  onSetThreadColor,
  onStar,
  onToggleSelect,
  showPreview,
  thread,
  toolCalls,
  threadListMode
}: {
  activeRunId: string | null
  draftText: string | null
  isActive: boolean
  hasActiveRun: boolean
  hasBackgroundWork: boolean
  hasJustDoneRun: boolean
  isRunActive: boolean
  isSaving: boolean
  currentTimeMs: number
  sentinel?: ThreadSentinelRecord
  pendingPlanApproval: boolean
  isSelectMode: boolean
  isSelected: boolean
  isStarred: boolean
  isInFolder: boolean
  threadActivationEnabled: boolean
  threadSelectionEnabled: boolean
  onRename: (thread: Thread, nextTitle: string) => void
  onSelectOperation: (thread: Thread, operationKey: ThreadContextOperationKey) => void
  onSelectThread: (threadId: string) => void
  onSetIcon: (thread: Thread, icon: string | null) => void
  onSetThreadColor: (thread: Thread, colorTag: ThreadColorTag | null) => void
  onStar: (thread: Thread) => void
  onToggleSelect: (threadId: string) => void
  showPreview: boolean
  thread: Thread
  toolCalls: ToolCall[]
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const preview = resolveThreadSidebarPreview({
    activeRunId,
    hasBackgroundWork,
    isRunActive,
    pendingPlanApproval,
    thread,
    toolCalls
  })
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const isExternal = isExternalThread(thread)
  const isSyncedArchive = isSyncedArchiveThread(thread)
  const operations = resolveThreadContextOperations({
    canHandoff: threadActivationEnabled && canCompactThreadToAnotherThread(thread),
    colorTag: thread.colorTag ?? null,
    includeSelectMode: true,
    isArchived: Boolean(thread.archivedAt),
    isExternal,
    isInFolder: !!thread.folderId,
    isRunning: hasActiveRun,
    isSaving,
    isStarred
  })

  const displayedTitle = useTitleAnimation(thread.title, renamingTitle)

  const isHighlighted = isSelectMode ? isSelected : isActive
  const isUnreadArchived =
    threadListMode === 'archived' && Boolean(thread.archivedAt) && !thread.readAt
  const previewClassName =
    preview.state === 'thinking' || preview.state === 'working'
      ? 'mt-0.5 block truncate yachiyo-sidebar-run-preview-shimmer'
      : 'mt-0.5 block truncate'
  const sentinelRemainingMinutes = sentinel?.nextRunAt
    ? Math.max(0, Math.ceil((Date.parse(sentinel.nextRunAt) - currentTimeMs) / 60_000))
    : null

  function handleIconClick(e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    iconInputRef.current?.focus()
    void window.api.yachiyo.showEmojiPanel()
  }

  function handleIconInput(e: React.FormEvent<HTMLInputElement>): void {
    const raw = e.currentTarget.value.trim()
    const newIcon = extractFirstEmoji(raw)
    if (newIcon && newIcon !== thread.icon) {
      onSetIcon(thread, newIcon)
    }
    e.currentTarget.value = ''
  }

  function handleIconInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    e.stopPropagation()
    e.currentTarget.blur()
  }

  function handleTitleInputBlur(e: React.FocusEvent<HTMLInputElement>): void {
    setRenamingTitle(false)
    const nextTitle = e.currentTarget.value.trim()
    if (nextTitle && nextTitle !== thread.title) {
      onRename(thread, nextTitle)
    }
  }

  function handleTitleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    e.stopPropagation()
    if (isDismissEscapeKey(e.nativeEvent)) {
      setRenamingTitle(false)
      return
    }
    imeSafeEnter(() => e.currentTarget.blur())(e)
  }

  function handleClick(): void {
    if (isSelectMode) {
      onToggleSelect(thread.id)
    } else if (threadSelectionEnabled) {
      onSelectThread(thread.id)
    }
  }

  function handleSelectOperation(operationKey: ThreadContextOperationKey): void {
    if (operationKey === 'rename') {
      setRenamingTitle(true)
      return
    }
    const colorTag = resolveThreadColorOperationTag(operationKey)
    if (colorTag !== undefined) {
      onSetThreadColor(thread, colorTag)
      return
    }
    onSelectOperation(thread, operationKey)
  }

  function openContextMenu(event: React.MouseEvent): void {
    event.preventDefault()
    if (isSelectMode || isSyncedArchive) return
    setMenuPosition({
      left: event.clientX,
      top: event.clientY
    })
  }

  return (
    <>
      <div
        className="relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          onClick={handleClick}
          aria-disabled={!threadSelectionEnabled && !isSelectMode}
          className={`relative w-full text-left px-3 ${showPreview ? 'py-2.5' : 'py-2'} rounded-lg transition-colors no-drag`}
          style={{
            background: isHighlighted ? theme.background.code : 'transparent'
          }}
          onContextMenu={openContextMenu}
          onMouseEnter={(e) => {
            if (!isHighlighted)
              (e.currentTarget as HTMLElement).style.background = theme.background.hover
          }}
          onMouseLeave={(e) => {
            if (!isHighlighted) (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        >
          <div className={`flex ${showPreview ? 'items-stretch' : 'items-center'} gap-2 pr-4`}>
            {isSelectMode ? (
              <span
                className="shrink-0 flex items-center"
                style={{ width: '1.45em', fontSize: '1.45em' }}
              >
                <span
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: 18,
                    height: 18,
                    border: `1.5px solid ${isSelected ? theme.text.counterStrong : theme.border.strong}`,
                    background: isSelected ? theme.text.counterStrong : 'transparent',
                    flexShrink: 0
                  }}
                >
                  {isSelected ? (
                    <Check size={10} strokeWidth={3} color={theme.text.inverse} />
                  ) : null}
                </span>
              </span>
            ) : thread.icon ? (
              <span
                className="relative shrink-0 flex items-center select-none leading-none"
                style={{ fontSize: showPreview ? '1.45em' : '1.15em' }}
                title={isSyncedArchive ? undefined : 'Click to change icon'}
              >
                {thread.icon}
                {isSyncedArchive ? null : (
                  <input
                    ref={iconInputRef}
                    type="text"
                    tabIndex={-1}
                    defaultValue=""
                    onInput={handleIconInput}
                    onKeyDown={handleIconInputKeyDown}
                    onClick={handleIconClick}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="absolute inset-0 opacity-0 "
                    style={{ fontSize: 'inherit', width: '100%', height: '100%' }}
                  />
                )}
              </span>
            ) : !showPreview ? (
              <span
                className="shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16 }}
              >
                <span
                  className="rounded-full"
                  style={{
                    width: 5,
                    height: 5,
                    background: isHighlighted ? theme.text.secondary : theme.text.muted
                  }}
                />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <span
                className={`flex items-center gap-1.5 text-sm ${showPreview ? 'font-medium' : 'font-normal'}`}
                style={{
                  color: resolveThreadTitleColor({
                    colorTag: thread.colorTag,
                    fallback: isHighlighted
                      ? theme.text.primary
                      : showPreview
                        ? theme.text.secondary
                        : theme.text.primary,
                    isInFolder
                  })
                }}
              >
                {renamingTitle ? (
                  <input
                    ref={titleInputRef}
                    autoFocus
                    type="text"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={handleTitleInputKeyDown}
                    onBlur={handleTitleInputBlur}
                    defaultValue={thread.title}
                    className="min-w-0 flex-1 bg-transparent outline-none"
                    style={{
                      color: isHighlighted ? theme.text.primary : theme.text.secondary,
                      fontSize: 'inherit',
                      fontWeight: 'inherit'
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{displayedTitle}</span>
                )}
                {isSyncedArchive ? (
                  <Lock
                    size={11}
                    strokeWidth={1.75}
                    className="shrink-0"
                    aria-label="Read-only, synced from another device"
                    style={{ color: theme.text.muted }}
                  />
                ) : null}
                {sentinel ? (
                  <span
                    aria-label="Sentinel active"
                    title={
                      sentinelRemainingMinutes === null
                        ? 'Sentinel armed'
                        : `Sentinel in ${sentinelRemainingMinutes} minute${sentinelRemainingMinutes === 1 ? '' : 's'}`
                    }
                    className="relative inline-flex shrink-0 items-center gap-0.5 rounded px-1"
                    style={{
                      color: theme.text.inverse,
                      background: theme.text.accentStrong,
                      fontSize: '0.6rem',
                      lineHeight: '14px',
                      height: '14px',
                      top: '-1px'
                    }}
                  >
                    <AlarmClock size={9} strokeWidth={2} />
                    {sentinelRemainingMinutes === null ? null : (
                      <span>{sentinelRemainingMinutes}m</span>
                    )}
                  </span>
                ) : null}
              </span>
              {showPreview && (
                <span
                  className={previewClassName}
                  data-shimmer-text={preview.text}
                  style={{
                    fontSize: '0.68rem',
                    color: isHighlighted ? theme.text.secondary : theme.text.muted
                  }}
                >
                  {draftText !== null && preview.state === 'normal' ? (
                    <>
                      <span style={{ color: theme.text.accent }}>[Draft]</span>
                      {draftText.length > 0 ? <> {draftText}</> : null}
                    </>
                  ) : preview.state === 'plan' ? (
                    <>
                      <span style={{ color: theme.text.accent }}>[Plan]</span> {preview.text}
                    </>
                  ) : (
                    preview.text
                  )}
                </span>
              )}
            </div>
          </div>
          {sentinel ? null : isSaving ? (
            <span
              aria-label="Saving"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '7px',
                height: '7px',
                background: theme.text.muted,
                opacity: isHighlighted ? 1 : 0.8
              }}
            />
          ) : hasActiveRun ? (
            <span
              aria-label="Run active"
              className="yachiyo-sidebar-active-run-dot absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '7px',
                height: '7px',
                background: theme.text.accentStrong
              }}
            />
          ) : hasJustDoneRun ? (
            <span
              aria-label="Just Done"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '7px',
                height: '7px',
                background: theme.text.accent
              }}
            />
          ) : isUnreadArchived ? (
            <span
              aria-label="Unread"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '8px',
                height: '8px',
                background: theme.text.accent
              }}
            />
          ) : null}
        </button>
        {!isSelectMode && !isUnreadArchived && !isSyncedArchive ? (
          <button
            title={isStarred ? 'Unstar' : 'Star'}
            onClick={(e) => {
              e.stopPropagation()
              onStar(thread)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.stopPropagation()
              openContextMenu(e)
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 no-drag"
            style={{
              color: isStarred ? theme.text.warning : theme.text.muted,
              opacity:
                !hasActiveRun &&
                !hasJustDoneRun &&
                !isSaving &&
                !sentinel &&
                (isHovered || isStarred)
                  ? 1
                  : 0,
              pointerEvents:
                hasActiveRun || hasJustDoneRun || isSaving || sentinel ? 'none' : 'auto',
              transition: 'opacity 0.15s'
            }}
          >
            <Star
              size={11}
              strokeWidth={isStarred ? 0 : 1.5}
              fill={isStarred ? theme.text.warning : 'none'}
            />
          </button>
        ) : null}
      </div>
      {menuPosition ? (
        <ThreadContextMenuPopup
          position={menuPosition}
          operations={operations}
          onClose={() => setMenuPosition(null)}
          onSelect={(operationKey) => handleSelectOperation(operationKey)}
        />
      ) : null}
    </>
  )
}
