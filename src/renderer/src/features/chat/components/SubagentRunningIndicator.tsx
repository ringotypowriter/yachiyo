import { useState, useRef, useEffect } from 'react'
import type React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { buildSubagentIndicatorStream, canCancelFromIndicator } from './subagentIndicatorState'

interface SubagentRunningIndicatorProps {
  agents: Array<{ delegationId: string; agentName: string; progress: string }>
  progressEntries: Array<{ delegationId: string; agentName: string; chunk: string }>
  onCancel?: () => void
}

export function SubagentRunningIndicator({
  agents,
  progressEntries,
  onCancel
}: SubagentRunningIndicatorProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !expanded) return
    if (!userScrolledRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [agents, expanded])

  function handleScroll(): void {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    userScrolledRef.current = !atBottom
  }

  function handleCancelClick(): void {
    if (!onCancel) {
      return
    }
    setConfirming(true)
  }

  function handleConfirm(): void {
    setConfirming(false)
    onCancel?.()
  }

  function handleDismiss(): void {
    setConfirming(false)
  }

  const stream = buildSubagentIndicatorStream(progressEntries)
  const canCancel = onCancel ? canCancelFromIndicator(agents) : false

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

        {stream ? (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs"
            style={{
              color: theme.text.muted,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              fontFamily: theme.font.ui
            }}
          >
            <span>Agent is working</span>
            {expanded ? (
              <ChevronUp size={11} style={{ opacity: 0.55 }} />
            ) : (
              <ChevronDown size={11} style={{ opacity: 0.55 }} />
            )}
          </button>
        ) : (
          <span className="text-xs" style={{ color: theme.text.muted }}>
            {agents.length === 1
              ? `${agents[0]?.agentName ?? 'Agent'} is working…`
              : `${agents.length} agents are working…`}
          </span>
        )}

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
                  cursor: 'pointer'
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
                  cursor: 'pointer'
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
                cursor: 'pointer'
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

      {expanded && stream && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="mt-2 rounded-md text-xs font-mono whitespace-pre-wrap overflow-y-auto yachiyo-detail-reveal"
          style={{
            maxHeight: '180px',
            background: theme.background.codeBlock,
            border: `1px solid ${theme.border.subtle}`,
            color: theme.text.tertiary,
            padding: '8px 12px',
            lineHeight: 1.65,
            wordBreak: 'break-word'
          }}
        >
          {stream}
        </div>
      )}
    </div>
  )
}
