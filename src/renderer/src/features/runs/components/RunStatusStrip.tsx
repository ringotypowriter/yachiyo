import { useAppStore } from '@renderer/app/store/useAppStore'

export function RunStatusStrip() {
  const runStatus = useAppStore((s) => s.runStatus)

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
              animationDuration: '0.8s',
            }}
          />
        ))}
      </span>
      <span>Thinking...</span>
    </div>
  )
}
