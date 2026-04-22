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

    const activeRunId = s.activeRunIdsByThread[threadId]
    const pending = activeRunId ? s.pendingAssistantMessages[activeRunId] : undefined

    if (runPhase === 'preparing') {
      if (pending) {
        const messages = s.messages[threadId] ?? []
        const streamingMsg = messages.find((m) => m.id === pending.messageId)
        if (streamingMsg?.reasoning) return 'downloading'
      }
      return 'uploading'
    }

    const toolCalls = s.toolCalls[threadId] ?? []
    const hasActiveToolCall = toolCalls.some(
      (tc) => tc.status === 'preparing' || tc.status === 'running'
    )
    if (hasActiveToolCall) return 'toolcall'

    if (pending?.shouldStartNewTextBlock && toolCalls.length > 0) {
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

function ToolCallArrows(): React.ReactElement {
  return (
    <motion.span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        width: 14,
        height: 10
      }}
    >
      <motion.span
        style={{ position: 'absolute', display: 'inline-flex' }}
        initial={{ x: 0, rotate: -90, opacity: 0 }}
        animate={{
          x: [-3, -4.5, -3],
          rotate: -90,
          opacity: [0.5, 1, 0.5]
        }}
        transition={{
          x: { ...bounceTransition, duration: 1.4 },
          rotate: arrowTransition,
          opacity: shimmerTransition
        }}
      >
        <ArrowSvg />
      </motion.span>
      <motion.span
        style={{ position: 'absolute', display: 'inline-flex' }}
        initial={{ x: 0, rotate: 90, opacity: 0 }}
        animate={{
          x: [3, 4.5, 3],
          rotate: 90,
          opacity: [0.5, 1, 0.5]
        }}
        transition={{
          x: { ...bounceTransition, duration: 1.4 },
          rotate: arrowTransition,
          opacity: { ...shimmerTransition, delay: 0.9 }
        }}
      >
        <ArrowSvg />
      </motion.span>
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
            <ToolCallArrows />
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
