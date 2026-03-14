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

  if (runStatus === 'cancelled') {
    return (
      <div
        className="flex items-center gap-2 px-6 py-2 text-xs"
        style={{ color: '#8e8e93', borderTop: '1px solid rgba(0,0,0,0.06)' }}
      >
        <span>Stopped.</span>
      </div>
    )
  }

  if (runStatus !== 'running') return null

  return (
    <div
      className="flex items-center gap-2 px-6 py-1.5 text-xs"
      style={{ color: '#8e8e93', borderTop: '1px solid rgba(0,0,0,0.06)' }}
    >
      <span className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1 h-1 rounded-full animate-bounce"
            style={{
              background: '#8e8e93',
              animationDelay: `${i * 0.15}s`,
              animationDuration: '0.8s'
            }}
          />
        ))}
      </span>
      <span>Thinking...</span>
    </div>
  )
}
