import type React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DEFAULT_SETTINGS, useAppStore } from '@renderer/app/store/useAppStore'

function useStripContent(): { key: string; color: string; text: string } | null {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const latestRun = useAppStore((s) =>
    activeThreadId ? (s.latestRunsByThread[activeThreadId] ?? null) : null
  )
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)

  if (connectionStatus !== 'connected') {
    return {
      key: 'disconnected',
      color: '#b53a2f',
      text: 'Local server is unavailable. Reload the app if this keeps happening.'
    }
  }

  const needsApiKey = settings.provider !== 'vertex'
  if ((needsApiKey && !settings.apiKey.trim()) || !settings.model.trim()) {
    return {
      key: 'setup',
      color: '#8a6d3b',
      text: 'Open Settings to configure a provider and model before chatting.'
    }
  }

  if (latestRun?.status === 'failed' && latestRun.error) {
    return { key: `error-${latestRun.id}`, color: '#b53a2f', text: latestRun.error }
  }

  return null
}

export function RunStatusStrip(): React.JSX.Element {
  const content = useStripContent()

  return (
    <AnimatePresence initial={false}>
      {content && (
        <motion.div
          key={content.key}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          style={{ overflow: 'hidden' }}
        >
          <div
            className="flex items-center gap-2 px-6 py-2 text-xs"
            style={{ color: content.color, borderTop: '1px solid rgba(0,0,0,0.06)' }}
          >
            <span>{content.text}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
