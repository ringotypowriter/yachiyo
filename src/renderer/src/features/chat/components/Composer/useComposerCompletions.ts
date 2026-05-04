import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SlashCommand } from '../SlashCommandPopup'
import type {
  FileMentionCandidate,
  RunStatus,
  SettingsConfig,
  SkillCatalogEntry,
  Thread
} from '@renderer/app/types'
import { canCompactThreadToAnotherThread } from '@renderer/features/threads/lib/threadVisibility'
import { scoreCandidates } from '../../lib/completionMatch'
import {
  buildFileMentionCompletionCommands,
  paginateFileMentionMatches
} from '../../lib/fileMentionCompletion'
import {
  buildFontString,
  computePretextLines,
  getMeasureContext,
  resolveLineHeightPx
} from '@renderer/features/chat/lib/pretextSync'
import {
  AT_SKILL_PREFIX_PATTERN,
  FILE_MENTION_MAX_RESULTS,
  FILE_MENTION_PAGE_SIZE,
  FILE_MENTION_PATTERN,
  SKILL_PREFIX_PATTERN,
  SKILL_TAG_PATTERN,
  SLASH_PATTERN,
  collectConfirmedFileTags,
  resolveValidatedFileTags,
  type PendingWorkspaceChangeConfirmation
} from './support.tsx'

interface FileMentionMatchesState {
  status: 'idle' | 'ready' | 'error'
  key: string | null
  limit: number
  matches: FileMentionCandidate[]
  hasMore: boolean
}

interface UseComposerCompletionsInput {
  activeThreadId: string | null
  activeThread: Thread | null
  availableSkills: SkillCatalogEntry[]
  anyPopupOpenRef: React.MutableRefObject<boolean>
  composerValue: string
  config: SettingsConfig | null
  currentWorkspacePath: string | null
  isFreshHandoffWorkspace: boolean
  modelSelectorOpen: boolean
  pendingWorkspaceChangeConfirmation: PendingWorkspaceChangeConfirmation | null
  reasoningSelectorOpen: boolean
  runStatus: RunStatus
  savedWorkspacePaths: string[]
  setPendingWorkspaceChangeConfirmation: React.Dispatch<
    React.SetStateAction<PendingWorkspaceChangeConfirmation | null>
  >
  setThreadWorkspace: (workspacePath: string | null, threadId?: string | null) => Promise<void>
  setWorkspaceHintPinned: React.Dispatch<React.SetStateAction<boolean>>
  skillsSelectorOpen: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  toolSelectorOpen: boolean
  workspaceHintPinned: boolean
  workspaceSelectorOpen: boolean
}

interface UseComposerCompletionsResult {
  activeQuery: string | null
  activeSkillTag: string | null
  atSkillPrefixMatch: RegExpExecArray | null
  confirmedFileTags: string[]
  dismissSlashPopup: () => void
  fileMentionAnchorRect: DOMRect | null
  fileMentionIncludeIgnored: boolean
  fileMentionMatch: RegExpExecArray | null
  fileMentionMatches: FileMentionCandidate[]
  fileMentionMatchesState: FileMentionMatchesState
  fileMentionQuery: string | null
  fileMentionRawQuery: string
  fileMentionRequestKey: string | null
  isFileMentionSearchPending: boolean
  loadMoreFileMentionMatches: () => void
  matchingSlashCommands: SlashCommand[]
  showSlashCommandPopup: boolean
  skillQuery: string | null
  slashQuery: string | null
  slashSelectedIndex: number
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  validatedFileTags: string[]
  canRunThreadOperations: boolean
  canHandoffActiveThread: boolean
  commitWorkspaceSelection: (selection: PendingWorkspaceChangeConfirmation) => Promise<void>
  requestWorkspaceSelection: (selection: PendingWorkspaceChangeConfirmation) => void
  userPrompts: NonNullable<SettingsConfig['prompts']>
}

export function useComposerCompletions(
  input: UseComposerCompletionsInput
): UseComposerCompletionsResult {
  const {
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
  } = input

  const [dismissedSlashQuery, setDismissedSlashQuery] = useState<string | null>(null)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [fileMentionMatchesState, setFileMentionMatchesState] = useState<FileMentionMatchesState>({
    status: 'idle',
    key: null,
    limit: 0,
    hasMore: false,
    matches: []
  })
  const [fileMentionResultLimitState, setFileMentionResultLimitState] = useState<{
    key: string | null
    limit: number
  }>({
    key: null,
    limit: FILE_MENTION_PAGE_SIZE
  })

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
  const fileMentionResultLimit =
    fileMentionRequestKey !== null && fileMentionResultLimitState.key === fileMentionRequestKey
      ? fileMentionResultLimitState.limit
      : FILE_MENTION_PAGE_SIZE
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
    fileMentionRequestKey !== null &&
    (fileMentionMatchesState.key !== fileMentionRequestKey ||
      fileMentionMatchesState.limit < fileMentionResultLimit)
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
  const canHandoffActiveThread =
    canRunThreadOperations && activeThread ? canCompactThreadToAnotherThread(activeThread) : false

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
    [commitWorkspaceSelection, isFreshHandoffWorkspace, setPendingWorkspaceChangeConfirmation]
  )
  const allSlashCommands = useMemo<SlashCommand[]>(
    () => [
      ...(canHandoffActiveThread && runStatus !== 'running'
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
    [canHandoffActiveThread, canRunThreadOperations, runStatus, userPrompts, availableSkills]
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
      return buildFileMentionCompletionCommands({
        matches: fileMentionMatches
      })
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

  useEffect(() => {
    anyPopupOpenRef.current =
      modelSelectorOpen ||
      reasoningSelectorOpen ||
      skillsSelectorOpen ||
      toolSelectorOpen ||
      workspaceSelectorOpen ||
      showSlashCommandPopup ||
      pendingWorkspaceChangeConfirmation !== null
  }, [
    anyPopupOpenRef,
    modelSelectorOpen,
    pendingWorkspaceChangeConfirmation,
    reasoningSelectorOpen,
    showSlashCommandPopup,
    skillsSelectorOpen,
    toolSelectorOpen,
    workspaceSelectorOpen
  ])

  const [fileMentionAnchorRect, setFileMentionAnchorRect] = useState<DOMRect | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
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
  }, [composerValue, fileMentionMatch, textareaRef])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (fileMentionQuery === null) {
      return
    }

    let cancelled = false
    const requestedLimit = fileMentionResultLimit
    const requestLimit =
      requestedLimit < FILE_MENTION_MAX_RESULTS ? requestedLimit + 1 : requestedLimit
    const timeoutId = window.setTimeout(() => {
      void window.api.yachiyo
        .searchWorkspaceFiles({
          query: fileMentionQuery,
          includeIgnored: fileMentionIncludeIgnored,
          ...(activeThreadId ? { threadId: activeThreadId } : {}),
          ...(!activeThreadId && currentWorkspacePath
            ? { workspacePath: currentWorkspacePath }
            : {}),
          limit: requestLimit
        })
        .then((matches) => {
          if (!cancelled) {
            const page = paginateFileMentionMatches({
              matches,
              visibleLimit: requestedLimit
            })
            setFileMentionMatchesState({
              status: 'ready',
              key: fileMentionRequestKey,
              limit: requestedLimit,
              matches: page.matches,
              hasMore: page.hasMore
            })
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFileMentionMatchesState({
              status: 'error',
              key: fileMentionRequestKey,
              limit: requestedLimit,
              hasMore: false,
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
    fileMentionResultLimit,
    fileMentionQuery,
    fileMentionRequestKey
  ])

  const loadMoreFileMentionMatches = useCallback((): void => {
    if (
      fileMentionRequestKey === null ||
      isFileMentionSearchPending ||
      !fileMentionMatchesState.hasMore
    ) {
      return
    }

    setFileMentionResultLimitState((previous) => {
      const currentLimit =
        previous.key === fileMentionRequestKey ? previous.limit : FILE_MENTION_PAGE_SIZE
      const nextLimit = Math.min(FILE_MENTION_MAX_RESULTS, currentLimit + FILE_MENTION_PAGE_SIZE)
      if (nextLimit === currentLimit) {
        return previous
      }

      return {
        key: fileMentionRequestKey,
        limit: nextLimit
      }
    })
  }, [fileMentionMatchesState.hasMore, fileMentionRequestKey, isFileMentionSearchPending])

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
  }, [setWorkspaceHintPinned, workspaceHintPinned])
  const prevActiveQueryRef = useRef(activeQuery)
  if (prevActiveQueryRef.current !== activeQuery) {
    prevActiveQueryRef.current = activeQuery
    setSlashSelectedIndex(0)
    setDismissedSlashQuery(null)
  }

  const dismissSlashPopup = useCallback(() => {
    setDismissedSlashQuery(activeQuery)
  }, [activeQuery])

  return {
    activeQuery,
    activeSkillTag,
    atSkillPrefixMatch,
    confirmedFileTags,
    dismissSlashPopup,
    fileMentionAnchorRect,
    fileMentionIncludeIgnored,
    fileMentionMatch,
    fileMentionMatches,
    fileMentionMatchesState,
    fileMentionQuery,
    fileMentionRawQuery,
    fileMentionRequestKey,
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
  }
}
