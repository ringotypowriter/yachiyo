import type React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useT } from '@yachiyo/i18n/react'
import { DEFAULT_SETTINGS, useAppStore } from '@renderer/app/store/useAppStore'
import { theme } from '@renderer/theme/theme'

function useStripContent(): { key: string; color: string; text: string } | null {
  const t = useT()
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const latestRun = useAppStore((s) =>
    activeThreadId ? (s.latestRunsByThread[activeThreadId] ?? null) : null
  )
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)

  if (connectionStatus !== 'connected') {
    return {
      key: 'disconnected',
      color: theme.text.danger,
      text: t('runs.serverUnavailable')
    }
  }

  const needsApiKey = settings.provider !== 'vertex' && settings.provider !== 'openai-codex'
  const needsCodexSession =
    settings.provider === 'openai-codex' && !settings.codexSessionPath?.trim()
  if ((needsApiKey && !settings.apiKey.trim()) || needsCodexSession || !settings.model.trim()) {
    return {
      key: 'setup',
      color: theme.text.warning,
      text: t('runs.setupRequired')
    }
  }

  if (latestRun?.status === 'failed' && latestRun.error) {
    return { key: `error-${latestRun.id}`, color: theme.text.danger, text: latestRun.error }
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
            style={{ color: content.color, borderTop: `1px solid ${theme.border.subtle}` }}
          >
            <span>{content.text}</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
