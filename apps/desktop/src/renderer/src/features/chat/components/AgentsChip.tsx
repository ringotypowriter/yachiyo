import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Bot, ChevronDown, ChevronUp, Square, X } from 'lucide-react'
import type { SubagentSnapshot, SubagentState } from '@yachiyo/shared/protocol'
import { useAppStore, type ActiveSubagentState } from '@renderer/app/store/useAppStore'
import { selectSubagentSnapshotIds } from '@renderer/app/store/useAppStore/helpers'

import { theme } from '@renderer/theme/theme'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'

interface AgentsChipProps {
  threadId: string | null
}

const RUNNING_STATES: Record<SubagentState, boolean> = {
  starting: true,
  running: true,
  idle: false,
  failed: false,
  cancelled: false,
  closed: false,
  interrupted: false
}

function isRunning(snapshot: SubagentSnapshot): boolean {
  return RUNNING_STATES[snapshot.state]
}

function formatElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return ''
  const elapsedSec = Math.max(0, Math.floor((now - start) / 1000))
  if (elapsedSec < 60) return `${elapsedSec}s`
  const minutes = Math.floor(elapsedSec / 60)
  const seconds = elapsedSec % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function formatState(state: SubagentState): string {
  switch (state) {
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'idle':
      return 'Idle'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'closed':
      return 'Closed'
    case 'interrupted':
      return 'Interrupted'
  }
}

function useNowTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [enabled])
  return now
}

export function AgentsChip({ threadId }: AgentsChipProps): React.JSX.Element | null {
  const snapshotIds = useAppStore((state) => selectSubagentSnapshotIds(state, threadId))
  const snapshotsById = useAppStore((state) => state.subagentSnapshotsById)
  const subagentStateById = useAppStore((state) => state.subagentStateById)
  const cancelSubagent = useAppStore((state) => state.cancelSubagent)
  const closeSubagent = useAppStore((state) => state.closeSubagent)
  const [openRequested, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const snapshots = useMemo(
    () =>
      snapshotIds
        .map((agentId) => snapshotsById[agentId])
        .filter((snapshot): snapshot is SubagentSnapshot => Boolean(snapshot))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [snapshotIds, snapshotsById]
  )
  const runningCount = snapshots.filter(isRunning).length
  const idleCount = snapshots.filter((snapshot) => snapshot.state === 'idle').length
  const latest = snapshots[0] ?? null
  const hasRunning = runningCount > 0
  const tick = useNowTick(hasRunning)
  if (snapshots.length === 0) return null

  const open = openRequested && snapshots.length > 0
  const recentChange = latest ? formatState(latest.state) : ''
  const countLabel = `${runningCount} running · ${idleCount} idle`
  return (
    <div ref={wrapperRef} className="composer-task-chip-host">
      {createPortal(
        <AnimatePresence>
          {open ? (
            <AgentsPanel
              key="agents-panel"
              snapshots={snapshots}
              activityById={subagentStateById}
              now={tick}
              onCancel={(agentId) => {
                void cancelSubagent(agentId).catch(() => {})
              }}
              onCloseAgent={(agentId) => {
                void closeSubagent(agentId).catch(() => {})
              }}
              onClose={() => setOpen(false)}
              anchorRef={wrapperRef}
            />
          ) : null}
        </AnimatePresence>,
        document.body
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="composer-task-chip-button"
          data-open={open ? 'true' : undefined}
          data-running={hasRunning ? 'true' : undefined}
          aria-expanded={open}
          aria-label="Thread agents"
        >
          {hasRunning ? (
            <span
              className="composer-task-chip-button__dot"
              style={{ background: theme.text.accent }}
            />
          ) : (
            <Bot size={12} strokeWidth={1.75} />
          )}
          <span>{countLabel}</span>
          <span style={{ color: theme.text.placeholder }}>· {recentChange}</span>
          {open ? (
            <ChevronDown size={12} strokeWidth={1.75} />
          ) : (
            <ChevronUp size={12} strokeWidth={1.75} />
          )}
        </button>
      </div>
    </div>
  )
}
interface AgentsPanelProps {
  snapshots: SubagentSnapshot[]
  activityById: Record<string, ActiveSubagentState>
  now: number
  onCancel: (agentId: string) => void
  onCloseAgent: (agentId: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLDivElement | null>
}

function AgentsPanel({
  snapshots,
  activityById,
  now,
  onCancel,
  onCloseAgent,
  onClose,
  anchorRef
}: AgentsPanelProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const { style: panelPositionStyle } = useFloatingPanelLayout({
    open: true,
    referenceRef: anchorRef,
    floatingRef: ref,
    width: 760,
    maxHeight: 680,
    preferredPlacement: 'top',
    alignment: 'end'
  })
  useRestoreFocusOnUnmount()

  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handler)
    }
  }, [anchorRef, onClose])

  return (
    <motion.div
      ref={ref}
      data-composer-floating-menu
      data-composer-wheel-local-scroll
      initial={{ opacity: 0, scale: 0.95, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 4 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        ...panelPositionStyle,
        background: theme.background.surfaceFrosted,
        border: `1px solid ${theme.border.default}`,
        boxShadow: theme.shadow.card,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        pointerEvents: 'auto',
        zIndex: 120
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: `1px solid ${theme.border.default}` }}
      >
        <div className="text-xs font-semibold" style={{ color: theme.text.primary }}>
          Thread agents
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Collapse agents"
          aria-label="Collapse agents"
          className="p-1 rounded hover:opacity-70"
          style={{ color: theme.icon.default }}
        >
          <ChevronDown size={12} strokeWidth={1.75} />
        </button>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-composer-wheel-local-scroll
        style={{ overscrollBehavior: 'contain' }}
      >
        {snapshots.map((snapshot) => (
          <AgentRow
            key={snapshot.agentId}
            snapshot={snapshot}
            activity={activityById[snapshot.agentId]}
            now={now}
            onCancel={() => onCancel(snapshot.agentId)}
            onClose={() => onCloseAgent(snapshot.agentId)}
          />
        ))}
      </div>
    </motion.div>
  )
}
function AgentRow({
  snapshot,
  activity,
  now,
  onCancel,
  onClose
}: {
  snapshot: SubagentSnapshot
  activity?: ActiveSubagentState
  now: number
  onCancel: () => void
  onClose: () => void
}): React.JSX.Element {
  const running = isRunning(snapshot)
  const elapsed = formatElapsed(snapshot.startedAt, now)
  const profile = `${snapshot.agentName} · ${snapshot.agentType}`
  const latestTool = activity?.recentToolCalls?.[activity.recentToolCalls.length - 1]
  const progress = activity?.progress.trim()
  const recentMessage = activity?.lastMessage?.trim()
  return (
    <div className="px-3 py-2" style={{ borderBottom: `1px solid ${theme.border.subtle}` }}>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{
                background: running ? theme.text.accent : theme.text.muted,
                animation: running ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
              }}
            />
            <span className="truncate text-xs" style={{ color: theme.text.primary }}>
              {snapshot.codeName}
            </span>
            <span className="truncate text-[10px]" style={{ color: theme.text.muted }}>
              {profile}
            </span>
          </div>
          <div
            className="mt-1 flex items-center gap-2 text-[10px]"
            style={{ color: theme.text.muted }}
          >
            <span>{formatState(snapshot.state)}</span>
            {elapsed ? <span className="tabular-nums">{elapsed}</span> : null}
          </div>
          {snapshot.lastOutput ? (
            <div
              className="mt-1 text-[11px] leading-snug line-clamp-2"
              style={{ color: theme.text.secondary }}
              title={snapshot.lastOutput}
            >
              {snapshot.lastOutput}
            </div>
          ) : null}
          {latestTool ? (
            <div className="mt-1 text-[10px] truncate" style={{ color: theme.text.muted }}>
              Tool: {latestTool.toolName}
              {latestTool.outputSummary ? ` · ${latestTool.outputSummary}` : ''}
            </div>
          ) : null}
          {progress ? (
            <div
              className="mt-1 text-[10px] leading-snug line-clamp-2"
              style={{ color: theme.text.secondary }}
              title={progress}
            >
              {progress}
            </div>
          ) : null}
          {recentMessage ? (
            <div
              className="mt-1 text-[10px] leading-snug line-clamp-2"
              style={{ color: theme.text.secondary }}
              title={recentMessage}
            >
              Message: {recentMessage}
            </div>
          ) : null}
        </div>
        {running ? (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel agent"
            aria-label={`Cancel ${snapshot.codeName}`}
            className="p-1 rounded hover:opacity-70 shrink-0"
            style={{ color: theme.text.danger }}
          >
            <Square size={10} strokeWidth={2} fill="currentColor" />
          </button>
        ) : snapshot.state === 'idle' ? (
          <button
            type="button"
            onClick={onClose}
            title="Close agent"
            aria-label={`Close ${snapshot.codeName}`}
            className="p-1 rounded hover:opacity-70 shrink-0"
            style={{ color: theme.icon.default }}
          >
            <X size={11} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
