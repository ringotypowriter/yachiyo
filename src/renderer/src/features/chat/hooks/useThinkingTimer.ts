import { useEffect, useState } from 'react'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}min${s}s`
}

export function useThinkingTimer(isActive: boolean, startedAt: string): string {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!isActive) return
    const origin = new Date(startedAt).getTime()
    const compute = (): void => {
      setElapsed(Math.max(0, Math.floor((Date.now() - origin) / 1000)))
    }
    const immediateId = setTimeout(compute, 0)
    const id = setInterval(compute, 1000)
    return (): void => {
      clearTimeout(immediateId)
      clearInterval(id)
    }
  }, [isActive, startedAt])

  return formatElapsed(elapsed)
}
