import { useState, useEffect, useMemo } from 'react'
import type React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import type { ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { canCancelFromIndicator } from './subagentIndicatorState'
import { ToolCallRow } from './ToolCallRow'

interface SubagentToolCallPreview {
  toolCallId?: string
  toolName: string
  inputSummary: string
  outputSummary?: string
  status?: 'running' | 'completed' | 'failed'
}

interface SubagentAgent {
  delegationId: string
  agentName: string
  agentType?: string
  codeName?: string
  prompt?: string
  progress: string
  startedAt?: string
  recentToolCalls?: SubagentToolCallPreview[]
}

interface SubagentProgressEntry {
  delegationId: string
  agentName: string
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

function toNestedToolCall(toolCall: SubagentToolCallPreview, index: number): ToolCall {
  return {
    id: toolCall.toolCallId ?? `${toolCall.toolName}:${index}`,
    threadId: 'subagent-preview',
    toolName: toolCall.toolName,
    status: toolCall.status ?? 'running',
    inputSummary: toolCall.inputSummary,
    ...(toolCall.outputSummary ? { outputSummary: toolCall.outputSummary } : {}),
    startedAt: new Date(0).toISOString()
  }
}

function AgentCard({ agent }: { agent: SubagentAgent }): React.JSX.Element {
  const elapsed = useElapsed(agent.startedAt)
  const recent = agent.recentToolCalls ?? []
  const codeName = agent.codeName ?? agent.agentName

  return (
    <div
      className="rounded-lg px-3 py-2 mb-2"
      style={{
        background: theme.background.surface,
        border: `1px solid ${theme.border.subtle}`,
        boxShadow: '0 1px 2px rgba(0,0,0,0.02)'
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[11px] font-semibold" style={{ color: theme.text.accent }}>
            {codeName}
          </span>
          <span className="text-[11px] truncate" style={{ color: theme.text.muted }}>
            {agent.agentName}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1" style={{ color: theme.text.muted }}>
          <Clock size={10} />
          <span className="text-[10px]">{formatDurationMs(elapsed)}</span>
        </div>
      </div>

      {agent.prompt ? (
        <div className="mt-2">
          <div
            className="mb-1 text-[10px] uppercase tracking-[0.04em]"
            style={{ color: theme.text.placeholder }}
          >
            Prompt
          </div>
          <div
            className="message-selectable overflow-auto rounded-md px-2.5 py-2 text-[11px]"
            style={{
              background: theme.background.hover,
              color: theme.text.secondary,
              lineHeight: 1.55,
              maxHeight: '112px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word'
            }}
          >
            {agent.prompt}
          </div>
        </div>
      ) : null}

      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span
            className="text-[10px] uppercase tracking-[0.04em]"
            style={{ color: theme.text.placeholder }}
          >
            Recent tool calls
          </span>
          <span className="text-[10px]" style={{ color: theme.text.placeholder }}>
            latest {Math.min(recent.length, 5)}/5
          </span>
        </div>
        <div
          className="overflow-auto rounded-md px-2.5 py-1.5"
          style={{
            background: theme.background.hover,
            maxHeight: '132px'
          }}
        >
          {recent.length > 0 ? (
            recent.map((toolCall, index) => (
              <ToolCallRow
                key={toolCall.toolCallId ?? `${toolCall.toolName}:${index}`}
                toolCall={toNestedToolCall(toolCall, index)}
                nested
              />
            ))
          ) : (
            <div className="py-0.5 text-[11px]" style={{ color: theme.text.placeholder }}>
              Waiting for tool calls
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SubagentRunningIndicator({
  agents,
  onCancel
}: SubagentRunningIndicatorProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(true)
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
      const name = agents[0]?.codeName ?? agents[0]?.agentName ?? 'Agent'
      return `${name} is working`
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
            <AgentCard key={agent.delegationId} agent={agent} />
          ))}
        </div>
      )}
    </div>
  )
}
