import { useState, useRef, useEffect, useMemo } from 'react'
import type React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp, Clock, Wrench } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import {
  buildAgentIdentities,
  canCancelFromIndicator,
  type AgentIdentity
} from './subagentIndicatorState'

interface SubagentAgent {
  delegationId: string
  agentName: string
  agentType?: string
  progress: string
  startedAt?: string
  recentToolCalls?: Array<{ toolName: string; inputSummary: string; outputSummary?: string }>
}

interface SubagentProgressEntry {
  delegationId: string
  agentName: string
  agentType?: string
  chunk: string
}

interface SubagentRunningIndicatorProps {
  agents: SubagentAgent[]
  progressEntries: SubagentProgressEntry[]
  onCancel?: () => void
}

function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

function useElapsed(startedAt?: string): number {
  const [now, setNow] = useState(0)
  useEffect(() => {
    if (!startedAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (!startedAt || now === 0) return 0
  return Math.max(0, now - new Date(startedAt).getTime())
}

/** Group consecutive chunks per delegationId, preserving order. */
function buildAgentProgressChunks(entries: SubagentProgressEntry[]): Record<string, string> {
  const chunks: Record<string, string[]> = {}
  let currentId: string | null = null
  let currentBuf: string[] = []

  function flush(): void {
    if (currentId !== null && currentBuf.length > 0) {
      chunks[currentId] = chunks[currentId] ?? []
      chunks[currentId].push(currentBuf.join(''))
      currentBuf = []
    }
  }

  for (const entry of entries) {
    if (entry.delegationId !== currentId) {
      flush()
      currentId = entry.delegationId
    }
    currentBuf.push(entry.chunk)
  }
  flush()

  return Object.fromEntries(Object.entries(chunks).map(([k, v]) => [k, v.join('')]))
}

function AgentProgressBlock({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [text])

  if (!text) return <></>

  return (
    <div
      ref={ref}
      className="mt-2 rounded-sm text-[11px] font-mono overflow-y-auto"
      style={{
        maxHeight: '120px',
        background: theme.background.codeBlock,
        border: `1px solid ${theme.border.subtle}`,
        color: theme.text.tertiary,
        padding: '6px 10px',
        lineHeight: 1.6,
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap'
      }}
    >
      {text}
    </div>
  )
}

function AgentCard({
  agent,
  identity,
  progressText
}: {
  agent: SubagentAgent
  identity: AgentIdentity
  progressText: string
}): React.JSX.Element {
  const elapsed = useElapsed(agent.startedAt)
  const recent = (agent.recentToolCalls ?? []).slice(-3)
  return (
    <div
      className="rounded-md px-3 py-2 mb-2"
      style={{
        background: theme.background.surface,
        border: `1px solid ${theme.border.subtle}`
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-semibold rounded px-1 py-0.5"
            style={{
              background: identity.color + '18',
              color: identity.color
            }}
          >
            #{identity.index}
          </span>
          <span className="text-xs font-medium" style={{ color: theme.text.secondary }}>
            {agent.agentName}
          </span>
        </div>
        <div className="flex items-center gap-1" style={{ color: theme.text.muted }}>
          <Clock size={10} />
          <span className="text-[10px]">{formatDurationMs(elapsed)}</span>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {recent.map((tc, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Wrench size={9} style={{ color: theme.text.muted, opacity: 0.6 }} />
              <span className="text-[10px] truncate" style={{ color: theme.text.muted }}>
                {tc.toolName}
                {tc.inputSummary ? ` · ${tc.inputSummary.slice(0, 60)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <AgentProgressBlock text={progressText} />
    </div>
  )
}

export function SubagentRunningIndicator({
  agents,
  progressEntries,
  onCancel
}: SubagentRunningIndicatorProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const identities = useMemo(() => buildAgentIdentities(agents), [agents])
  const identityMap = useMemo(() => {
    const map: Record<string, AgentIdentity> = {}
    for (const id of identities) {
      map[id.delegationId] = id
    }
    return map
  }, [identities])

  const agentProgress = useMemo(() => buildAgentProgressChunks(progressEntries), [progressEntries])
  const canCancel = onCancel ? canCancelFromIndicator(agents) : false

  function handleCancelClick(): void {
    if (!onCancel) return
    setConfirming(true)
  }

  function handleConfirm(): void {
    setConfirming(false)
    onCancel?.()
  }

  function handleDismiss(): void {
    setConfirming(false)
  }

  const headerText = useMemo(() => {
    if (agents.length === 0) return 'No active agents'
    if (agents.length === 1) {
      const type = agents[0]?.agentType ?? 'Agent'
      return `${type} is working`
    }
    return `${agents.length} agents are working`
  }, [agents])

  return (
    <div className="px-6 py-1">
      <div className="flex items-center gap-2 mt-1">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            background: theme.text.accent,
            display: 'inline-block',
            animation: 'yachiyo-generating-pulse 1s ease-in-out infinite'
          }}
        />

        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-xs"
          style={{
            color: theme.text.muted,
            background: 'none',
            border: 'none',
            cursor: 'default',
            padding: 0,
            fontFamily: theme.font.ui
          }}
        >
          <span>{headerText}</span>
          {expanded ? (
            <ChevronUp size={11} style={{ opacity: 0.55 }} />
          ) : (
            <ChevronDown size={11} style={{ opacity: 0.55 }} />
          )}
        </button>

        <AnimatePresence mode="wait" initial={false}>
          {canCancel && confirming ? (
            <motion.span
              key="confirm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex items-center gap-1.5 ml-1"
            >
              <span className="text-xs" style={{ color: theme.text.muted }}>
                Interrupt?
              </span>
              <button
                onClick={handleConfirm}
                className="text-xs px-2 py-0.5 rounded"
                style={{
                  background: theme.background.dangerSurface,
                  color: theme.text.danger,
                  border: `1px solid ${theme.border.danger}`,
                  cursor: 'default'
                }}
              >
                Stop
              </button>
              <button
                onClick={handleDismiss}
                className="text-xs px-2 py-0.5 rounded"
                style={{
                  background: theme.background.surface,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.contrast}`,
                  cursor: 'default'
                }}
              >
                Continue
              </button>
            </motion.span>
          ) : canCancel ? (
            <motion.button
              key="cancel"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={handleCancelClick}
              className="text-xs px-2 py-0.5 rounded ml-1"
              style={{
                background: theme.background.surface,
                color: theme.text.muted,
                border: `1px solid ${theme.border.default}`,
                cursor: 'default'
              }}
            >
              Cancel
            </motion.button>
          ) : (
            <motion.span
              key="info"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="text-xs ml-1"
              style={{ color: theme.text.muted }}
            >
              Stop the run to cancel all
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {expanded && (
        <div className="mt-2">
          {agents.map((agent) => (
            <AgentCard
              key={agent.delegationId}
              agent={agent}
              identity={identityMap[agent.delegationId]!}
              progressText={agentProgress[agent.delegationId] ?? ''}
            />
          ))}
        </div>
      )}
    </div>
  )
}
