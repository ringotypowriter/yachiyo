import { FolderOpen, SquarePen, SquareTerminal } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Thread } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

export interface ThreadHeaderTitleProps {
  activeThread: Thread | null
  centered?: boolean
  onOpenThreadWorkspace: () => Promise<void>
  onOpenInEditor?: () => Promise<void>
  onOpenInTerminal?: () => Promise<void>
}

const workspaceButtonClass =
  'no-drag shrink-0 rounded p-1 opacity-60 hover:opacity-100 hover:bg-black/8 transition-all'
const workspaceButtonStyle = { color: theme.text.secondary }

export function ThreadHeaderTitle({
  activeThread,
  centered = false,
  onOpenThreadWorkspace,
  onOpenInEditor,
  onOpenInTerminal
}: ThreadHeaderTitleProps): React.JSX.Element {
  const workspaceButtons = activeThread ? (
    <motion.div layout className="flex items-center gap-0.5 shrink-0">
      <button
        onClick={() => void onOpenThreadWorkspace()}
        className={workspaceButtonClass}
        style={workspaceButtonStyle}
        title="Open workspace in Finder"
        aria-label="Open workspace in Finder"
      >
        <FolderOpen size={11} strokeWidth={1.7} />
      </button>
      {onOpenInTerminal ? (
        <button
          onClick={() => void onOpenInTerminal()}
          className={workspaceButtonClass}
          style={workspaceButtonStyle}
          title="Open workspace in terminal"
          aria-label="Open workspace in terminal"
        >
          <SquareTerminal size={11} strokeWidth={1.7} />
        </button>
      ) : null}
      {onOpenInEditor ? (
        <button
          onClick={() => void onOpenInEditor()}
          className={workspaceButtonClass}
          style={workspaceButtonStyle}
          title="Open workspace in editor"
          aria-label="Open workspace in editor"
        >
          <SquarePen size={11} strokeWidth={1.7} />
        </button>
      ) : null}
    </motion.div>
  ) : null

  return (
    <motion.div
      layout
      className="flex flex-col min-w-0"
      style={{ alignItems: centered ? 'center' : 'flex-start' }}
    >
      {/* Title + inline buttons when sidebar on */}
      <motion.div layout className="flex items-center gap-1.5 min-w-0">
        {activeThread?.icon ? (
          <motion.span
            layout
            className="shrink-0 select-none leading-none"
            style={{ fontSize: '1em' }}
          >
            {activeThread.icon}
          </motion.span>
        ) : null}
        <motion.span
          layout
          className="text-sm font-semibold truncate"
          style={{ color: theme.text.primary, letterSpacing: '-0.2px' }}
        >
          {activeThread?.title ?? 'Start a conversation'}
        </motion.span>
        <AnimatePresence>{!centered && workspaceButtons}</AnimatePresence>
      </motion.div>

      {/* Buttons below title when centered (sidebar off) */}
      <AnimatePresence>{centered && workspaceButtons}</AnimatePresence>
    </motion.div>
  )
}
