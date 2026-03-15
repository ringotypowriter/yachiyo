import type React from 'react'
import { DEFAULT_SETTINGS, useAppStore } from '@renderer/app/store/useAppStore'

export function RunStatusStrip(): React.JSX.Element | null {
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const lastError = useAppStore((s) => s.lastError)
  const runStatus = useAppStore((s) => s.runStatus)
  const settings = useAppStore((s) => s.settings ?? DEFAULT_SETTINGS)

  if (connectionStatus !== 'connected') {
    return (
      <div
        className="flex items-center gap-2 px-6 py-2 text-xs"
        style={{ color: '#b53a2f', borderTop: '1px solid rgba(0,0,0,0.06)' }}
      >
        <span>Local server is unavailable. Reload the app if this keeps happening.</span>
      </div>
    )
  }

  if (!settings.apiKey.trim() || !settings.model.trim()) {
    return (
      <div
        className="flex items-center gap-2 px-6 py-2 text-xs"
        style={{ color: '#8a6d3b', borderTop: '1px solid rgba(0,0,0,0.06)' }}
      >
        <span>Open Settings and add a provider key to start the MVP chat flow.</span>
      </div>
    )
  }

  if (runStatus === 'failed' && lastError) {
    return (
      <div
        className="flex items-center gap-2 px-6 py-2 text-xs"
        style={{ color: '#b53a2f', borderTop: '1px solid rgba(0,0,0,0.06)' }}
      >
        <span>{lastError}</span>
      </div>
    )
  }

  return null
}
