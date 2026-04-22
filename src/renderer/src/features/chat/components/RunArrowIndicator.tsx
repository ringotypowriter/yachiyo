import { Cog } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { theme } from '@renderer/theme/theme'

export type ArrowPhase = 'idle' | 'uploading' | 'downloading' | 'toolcall'

function useArrowPhase(): ArrowPhase {
  return useAppStore((s) => {
    const threadId = s.activeThreadId
    if (!threadId) return 'idle'

    const runPhase = s.runPhasesByThread[threadId] ?? 'idle'
    if (runPhase === 'idle') return 'idle'

    if (runPhase === 'preparing') {
      const activeRunId = s.activeRunIdsByThread[threadId]
      const pending = activeRunId ? s.pendingAssistantMessages[activeRunId] : undefined
      if (pending) {
        const msg = (s.messages[threadId] ?? []).find((m) => m.id === pending.messageId)
        if (msg?.reasoning) return 'downloading'
      }
      return 'uploading'
    }

    const toolCalls = s.toolCalls[threadId] ?? []
    if (toolCalls.some((tc) => tc.status === 'preparing' || tc.status === 'running')) {
      return 'toolcall'
    }

    if (toolCalls.length > 0 && !s.receivingModelOutputByThread[threadId]) {
      return 'uploading'
    }

    return 'downloading'
  })
}

const arrowTransition = {
  type: 'spring' as const,
  stiffness: 200,
  damping: 18,
  mass: 0.8
}

const shimmerTransition = {
  duration: 1.8,
  repeat: Infinity,
  ease: 'easeInOut' as const
}

const bounceTransition = {
  duration: 1.2,
  repeat: Infinity,
  ease: 'easeInOut' as const
}

function ArrowSvg(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ display: 'block' }}>
      <path
        d="M5 1.5v7M5 1.5L2.5 4M5 1.5l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SingleArrow({ phase }: { phase: 'uploading' | 'downloading' }): React.ReactElement {
  const rotation = phase === 'uploading' ? 0 : 180
  const bounceY = phase === 'uploading' ? [0, -2, 0] : [0, 2, 0]

  return (
    <motion.span
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      animate={{ rotate: rotation }}
      transition={arrowTransition}
    >
      <motion.span
        style={{ display: 'inline-flex' }}
        animate={{
          y: bounceY,
          opacity: [0.5, 1, 0.5]
        }}
        transition={{
          y: bounceTransition,
          opacity: shimmerTransition
        }}
      >
        <ArrowSvg />
      </motion.span>
    </motion.span>
  )
}

function ToolCallGear(): React.ReactElement {
  return (
    <motion.span
      style={{ display: 'inline-flex' }}
      animate={{
        rotate: 360,
        opacity: [0.5, 1, 0.5]
      }}
      transition={{
        rotate: { duration: 2.4, repeat: Infinity, ease: 'linear' },
        opacity: shimmerTransition
      }}
    >
      <Cog size={10} strokeWidth={1.8} />
    </motion.span>
  )
}

export function RunArrowIndicator(): React.ReactElement | null {
  const phase = useArrowPhase()

  if (phase === 'idle') return null

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        color: theme.text.secondary
      }}
    >
      <AnimatePresence mode="wait">
        {phase === 'toolcall' ? (
          <motion.span
            key="toolcall"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <ToolCallGear />
          </motion.span>
        ) : (
          <motion.span
            key="single"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            transition={{ duration: 0.2 }}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <SingleArrow phase={phase} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}
