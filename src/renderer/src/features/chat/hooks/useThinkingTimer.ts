import { useEffect, useRef, useState } from 'react'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}min${s}s`
}

export function useThinkingTimer(isActive: boolean): string {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(0)

  useEffect(() => {
    if (!isActive) return
    startRef.current = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)
    return (): void => clearInterval(id)
  }, [isActive])

  return formatElapsed(elapsed)
}
