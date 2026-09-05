import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BrainCircuit,
  ChevronRight,
  Clock,
  Database,
  FilePenLine,
  Gauge,
  GitBranchPlus,
  GitCompareArrows,
  MessageSquareText,
  Wrench
} from 'lucide-react'
import { Streamdown } from 'streamdown'
import type { RunRecord, ToolCall } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { useHeavyMarkdownPlugins } from '@renderer/lib/markdown/heavyMarkdownPlugins'
import { theme, alpha } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import { tPlural } from '@yachiyo/i18n/index'

type Translate = ReturnType<typeof useT>
import type { WorkTrajectoryItem } from '../lib/timeline/messageTimelineRows.ts'
import { canBranchFromAskUserToolCall } from '../lib/branching/askUserBranchAction.ts'
import { formatToolFilePathList } from '../lib/tool-calls/toolCallPresentation.ts'
import {
  countToolCallsForRun,
  findLatestRunForRequests,
  formatWorkSummaryPerformance,
  normalizeRunModelLabel
} from '../lib/run-memory/runMemoryPresentation.ts'
import { ToolCallGroupRow } from './ToolCallGroupRow.tsx'
import { ToolCallRow } from './ToolCallRow.tsx'
import { useContentReader } from '@renderer/features/chat/hooks/useContentReader'

interface AgentWorkSummaryRowProps {
  items: WorkTrajectoryItem[]
  requestMessageIds: readonly string[]
  runs: RunRecord[]
  toolCalls: ToolCall[]
  modelLabel?: string | null
  workspacePath?: string | null
  /** When absent (read-only viewers), askUser steps render without a branch action. */
  onBranchFromAskUser?: (toolCall: ToolCall) => void
}

const animatedWorkSummaryRunIds = new Set<string>()
const WORK_SUMMARY_PACK_ANIMATION_WINDOW_MS = 2_500

function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 100) / 10}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function getMutationPath(toolCall: ToolCall): string | null {
  if (toolCall.toolName !== 'edit' && toolCall.toolName !== 'write') return null

  const details = toolCall.details
  if (
    details &&
    typeof details === 'object' &&
    'path' in details &&
    typeof details.path === 'string'
  ) {
    return details.path
  }

  return toolCall.inputSummary.trim() || null
}

function getItemLabel(item: WorkTrajectoryItem, t: Translate): string {
  switch (item.kind) {
    case 'memory':
      return t('chat.workSummary.labelContext')
    case 'thought':
      return t('chat.timeline.thought')
    case 'note':
      return t('chat.workSummary.labelNote')
    case 'user-steer':
      return t('chat.workSummary.labelUserSteer')
    case 'tool-call':
    case 'tool-call-group':
      return t('chat.workSummary.labelAction')
  }
}

function getItemIcon(item: WorkTrajectoryItem): React.ReactNode {
  switch (item.kind) {
    case 'memory':
      return <Database size={12} strokeWidth={1.7} />
    case 'thought':
      return <BrainCircuit size={12} strokeWidth={1.7} />
    case 'note':
    case 'user-steer':
      return <MessageSquareText size={12} strokeWidth={1.7} />
    case 'tool-call':
    case 'tool-call-group':
      return <Wrench size={12} strokeWidth={1.7} />
  }
}

function getItemDotColor(item: WorkTrajectoryItem): string {
  if (item.kind === 'tool-call') {
    return item.toolCall.status === 'failed' ? theme.status.danger : theme.status.success
  }

  if (item.kind === 'tool-call-group') {
    const failed = item.toolCalls.some((toolCall) => toolCall.status === 'failed')
    return failed ? theme.status.danger : theme.status.success
  }

  if (item.kind === 'user-steer') return theme.text.muted

  return theme.text.accent
}

export function AgentWorkSummaryRow({
  items,
  requestMessageIds,
  runs,
  toolCalls,
  modelLabel,
  workspacePath,
  onBranchFromAskUser
}: AgentWorkSummaryRowProps): React.JSX.Element {
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const reader = useContentReader()
  const packRef = useRef<HTMLDivElement>(null)
  const snapshotReviewByRun = useAppStore((s) => s.snapshotReviewByRun)

  const runInfo = useMemo(() => {
    const run = findLatestRunForRequests(runs, requestMessageIds, (candidate) => {
      return candidate.completedAt != null
    })
    if (!run || !run.completedAt) return null

    const elapsedMs = new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()
    const fileCount = run.snapshotFileCount ?? snapshotReviewByRun[run.id]?.fileCount ?? 0

    return {
      completedAt: run.completedAt,
      elapsedMs,
      fileCount,
      modelLabel: modelLabel ?? normalizeRunModelLabel(run.modelId),
      runId: run.id,
      threadId: run.threadId,
      performanceLabel: formatWorkSummaryPerformance(
        run.totalCompletionTokens,
        run.modelGenerationDurationMs,
        run.timeToFirstTokenMs
      ),
      toolCallCount: countToolCallsForRun(toolCalls, run.id) || toolCalls.length,
      workspacePath:
        run.workspacePath ?? snapshotReviewByRun[run.id]?.workspacePath ?? workspacePath ?? ''
    }
  }, [modelLabel, runs, requestMessageIds, snapshotReviewByRun, toolCalls, workspacePath])

  const changedPaths = useMemo(() => {
    const paths = new Set<string>()
    for (const toolCall of toolCalls) {
      const path = getMutationPath(toolCall)
      if (path) paths.add(path)
    }
    return formatToolFilePathList([...paths].slice(0, 3), workspacePath)
  }, [toolCalls, workspacePath])

  const toolCallCount = runInfo?.toolCallCount ?? toolCalls.length
  const fileCount = runInfo?.fileCount ?? changedPaths.length
  const canReviewDiff = runInfo != null && runInfo.fileCount > 0 && runInfo.workspacePath.length > 0
  const failedToolCalls = toolCalls.filter((toolCall) => toolCall.status === 'failed').length
  const displayedModelLabel = runInfo?.modelLabel ?? modelLabel ?? null

  useEffect(() => {
    if (!runInfo || animatedWorkSummaryRunIds.has(runInfo.runId)) return

    const packElement = packRef.current
    if (!packElement) return

    const completedAtMs = new Date(runInfo.completedAt).getTime()
    if (
      Number.isFinite(completedAtMs) &&
      Date.now() - completedAtMs <= WORK_SUMMARY_PACK_ANIMATION_WINDOW_MS
    ) {
      animatedWorkSummaryRunIds.add(runInfo.runId)
      packElement.classList.add('yachiyo-work-summary-pack--animate')
    }
  }, [runInfo])

  return (
    <div className="px-6 py-1.5">
      <div
        ref={packRef}
        className="yachiyo-work-summary-pack overflow-hidden rounded-md border"
        style={{
          background: theme.background.surface,
          borderColor: theme.border.default,
          color: theme.text.secondary
        }}
      >
        <div
          role="button"
          tabIndex={items.length > 0 ? 0 : -1}
          className="group flex w-full items-center gap-3 px-3 py-2.5 text-left"
          aria-expanded={isExpanded}
          onClick={() => {
            if (items.length > 0) setIsExpanded((current) => !current)
          }}
          onKeyDown={(event) => {
            if (items.length === 0) return
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setIsExpanded((current) => !current)
            }
          }}
          style={{
            background: 'transparent',
            border: 0,
            color: 'inherit',
            cursor: items.length > 0 ? 'default' : 'initial',
            fontSize: '11px',
            margin: 0
          }}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              background: failedToolCalls > 0 ? theme.status.danger : theme.status.success
            }}
          />
          <span className="min-w-0 flex-1">
            <span
              className="block truncate text-[11px]"
              style={{ color: theme.text.secondary, fontWeight: 650 }}
            >
              {t('chat.workSummary.title')}
            </span>
            <span
              className="mt-0.5 block truncate text-[10.5px]"
              style={{ color: theme.text.muted }}
            >
              {changedPaths.length > 0
                ? changedPaths.join(', ')
                : failedToolCalls > 0
                  ? tPlural('chat.workSummary.needReview', failedToolCalls, {
                      count: failedToolCalls
                    })
                  : t('chat.workSummary.activityAndNotes')}
            </span>
          </span>
          <Metric
            icon={<Clock size={11} strokeWidth={1.7} />}
            value={runInfo ? formatElapsed(runInfo.elapsedMs) : null}
          />
          <Metric
            className="hidden lg:inline-flex"
            icon={<Gauge size={11} strokeWidth={1.7} />}
            value={runInfo?.performanceLabel ?? null}
          />
          <WorkloadMetric toolCallCount={toolCallCount} fileCount={fileCount} />
          {canReviewDiff ? (
            <button
              type="button"
              className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[10.5px] transition-colors"
              onClick={(event) => {
                event.stopPropagation()
                runInfo && reader?.openDiff(runInfo)
              }}
              onKeyDown={(event) => {
                event.stopPropagation()
              }}
              style={{
                background: alpha('accent', 0.08),
                border: 'none',
                color: theme.text.accent,
                cursor: 'default',
                fontWeight: 650
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = alpha('accent', 0.14)
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = alpha('accent', 0.08)
              }}
            >
              <GitCompareArrows size={11} strokeWidth={1.7} />
              {t('chat.workSummary.review')}
            </button>
          ) : null}
          {displayedModelLabel ? (
            <span
              className="hidden min-w-0 max-w-40 truncate text-right text-[10.5px] xl:inline"
              style={{ color: theme.text.muted }}
            >
              {displayedModelLabel}
            </span>
          ) : null}
          <ChevronRight
            size={13}
            strokeWidth={1.8}
            style={{
              color: theme.text.placeholder,
              transform: isExpanded ? 'rotate(90deg)' : undefined,
              transition: 'transform 0.15s ease'
            }}
          />
        </div>

        {isExpanded ? (
          <div
            className="yachiyo-detail-reveal border-t px-3 py-2.5"
            style={{ borderColor: theme.border.subtle }}
          >
            <div className="flex flex-col gap-2">
              {items.map((item, index) => (
                <TrajectoryItemRow
                  key={item.key}
                  item={item}
                  isLast={index === items.length - 1 && !canReviewDiff}
                  workspacePath={workspacePath}
                  t={t}
                  onBranchFromAskUser={onBranchFromAskUser}
                />
              ))}
              {canReviewDiff ? (
                <OutcomeRow
                  changedPaths={changedPaths}
                  fileCount={runInfo.fileCount}
                  onReview={() => runInfo && reader?.openDiff(runInfo)}
                  t={t}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Metric({
  className = 'hidden sm:inline-flex',
  icon,
  value
}: {
  className?: string
  icon: React.ReactNode
  value: string | null
}): React.JSX.Element | null {
  if (!value) return null
  return (
    <span
      className={`${className} shrink-0 items-center gap-1`}
      style={{ color: theme.text.muted, fontSize: '10.5px' }}
    >
      {icon}
      {value}
    </span>
  )
}

function WorkloadMetric({
  toolCallCount,
  fileCount
}: {
  toolCallCount: number
  fileCount: number
}): React.JSX.Element | null {
  if (toolCallCount <= 0 && fileCount <= 0) return null

  return (
    <span
      className="hidden shrink-0 items-center gap-1.5 sm:inline-flex"
      style={{ color: theme.text.muted, fontSize: '10.5px' }}
    >
      {toolCallCount > 0 ? (
        <span className="inline-flex items-center gap-1">
          <Wrench size={11} strokeWidth={1.7} />
          {toolCallCount}
        </span>
      ) : null}
      {toolCallCount > 0 && fileCount > 0 ? <span>·</span> : null}
      {fileCount > 0 ? (
        <span className="inline-flex items-center gap-1">
          <FilePenLine size={11} strokeWidth={1.7} />
          {fileCount}
        </span>
      ) : null}
    </span>
  )
}

function TrajectoryItemRow({
  item,
  isLast,
  workspacePath,
  t,
  onBranchFromAskUser
}: {
  item: WorkTrajectoryItem
  isLast: boolean
  workspacePath?: string | null
  t: Translate
  onBranchFromAskUser?: (toolCall: ToolCall) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: '18px minmax(0, 1fr)' }}>
      <div className="flex flex-col items-center pt-1">
        <span
          className="flex h-4 w-4 items-center justify-center"
          style={{
            color: getItemDotColor(item)
          }}
        >
          {getItemIcon(item)}
        </span>
        {!isLast ? (
          <span className="mt-1 w-px flex-1 rounded" style={{ background: theme.border.subtle }} />
        ) : null}
      </div>
      <div className="min-w-0 pb-1">
        <div
          className="mb-1 text-[10.5px]"
          style={{ color: theme.text.placeholder, fontWeight: 650 }}
        >
          {getItemLabel(item, t)}
        </div>
        <TrajectoryItemContent
          item={item}
          workspacePath={workspacePath}
          t={t}
          onBranchFromAskUser={onBranchFromAskUser}
        />
      </div>
    </div>
  )
}

function TrajectoryItemContent({
  item,
  workspacePath,
  t,
  onBranchFromAskUser
}: {
  item: WorkTrajectoryItem
  workspacePath?: string | null
  t: Translate
  onBranchFromAskUser?: (toolCall: ToolCall) => void
}): React.JSX.Element {
  switch (item.kind) {
    case 'memory':
      return (
        <div className="flex flex-col gap-1">
          {item.entries.map((entry, index) => (
            <div
              key={`${item.key}:${index}`}
              className="text-[11px] leading-relaxed"
              style={{ color: theme.text.muted }}
            >
              {entry}
            </div>
          ))}
        </div>
      )
    case 'thought':
      return <ScrollableMarkdown value={item.reasoning} tone="thought" />
    case 'note':
      return <ScrollableMarkdown value={item.textBlock.content} tone="note" />
    case 'user-steer':
      return <ScrollableMarkdown value={item.message.content} tone="steer" />
    case 'tool-call':
      return (
        <div className="-mx-6">
          <ToolCallRow toolCall={item.toolCall} workspacePath={workspacePath} />
          {onBranchFromAskUser && canBranchFromAskUserToolCall(item.toolCall) ? (
            <div className="mx-6 mt-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[10.5px] transition-colors"
                onClick={(event) => {
                  event.stopPropagation()
                  onBranchFromAskUser(item.toolCall)
                }}
                style={{
                  background: alpha('accent', 0.08),
                  border: 'none',
                  color: theme.text.accent,
                  cursor: 'default',
                  fontWeight: 650
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = alpha('accent', 0.14)
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = alpha('accent', 0.08)
                }}
              >
                <GitBranchPlus size={11} strokeWidth={1.7} />
                {t('chat.workSummary.branchFromHere')}
              </button>
            </div>
          ) : null}
        </div>
      )
    case 'tool-call-group':
      return (
        <div className="-mx-6">
          <ToolCallGroupRow
            group={item.toolGroup}
            toolCalls={item.toolCalls}
            workspacePath={workspacePath}
          />
        </div>
      )
  }
}

function ScrollableMarkdown({
  value,
  tone
}: {
  value: string
  tone: 'thought' | 'note' | 'steer'
}): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement>(null)
  const heavyPlugins = useHeavyMarkdownPlugins(value)
  const plugins = useMemo(
    () => (heavyPlugins ? { math: heavyPlugins.math, code: heavyPlugins.code } : {}),
    [heavyPlugins]
  )

  useEffect(() => {
    if (tone === 'thought' && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [tone, value])

  return (
    <div
      ref={contentRef}
      className="overflow-y-auto message-selectable"
      style={{
        color: tone === 'thought' ? theme.text.tertiary : theme.text.muted,
        maxHeight: tone === 'thought' ? '240px' : tone === 'steer' ? '120px' : '180px',
        padding: 0
      }}
    >
      <div className="streamdown-content message-selectable text-[11px] leading-relaxed">
        <Streamdown mode="static" controls={true} plugins={plugins}>
          {value}
        </Streamdown>
      </div>
    </div>
  )
}

function OutcomeRow({
  changedPaths,
  fileCount,
  onReview,
  t
}: {
  changedPaths: string[]
  fileCount: number
  onReview: () => void
  t: Translate
}): React.JSX.Element {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: '18px minmax(0, 1fr)' }}>
      <div className="flex flex-col items-center pt-1">
        <span
          className="flex h-4 w-4 items-center justify-center"
          style={{
            color: theme.text.accent
          }}
        >
          <FilePenLine size={12} strokeWidth={1.7} />
        </span>
      </div>
      <div className="min-w-0">
        <div
          className="mb-1 text-[10.5px]"
          style={{ color: theme.text.placeholder, fontWeight: 650 }}
        >
          {t('chat.workSummary.fileChanges')}
        </div>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors"
          onClick={onReview}
          style={{
            background: alpha('accent', 0.08),
            border: 'none',
            color: theme.text.accent,
            cursor: 'default',
            fontWeight: 650
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = alpha('accent', 0.14)
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = alpha('accent', 0.08)
          }}
        >
          <GitCompareArrows size={11} strokeWidth={1.7} />
          <span className="truncate">
            {tPlural('chat.workSummary.reviewFileChanges', fileCount, { count: fileCount })}
            {changedPaths.length > 0 ? ` · ${changedPaths.join(', ')}` : ''}
          </span>
        </button>
      </div>
    </div>
  )
}
