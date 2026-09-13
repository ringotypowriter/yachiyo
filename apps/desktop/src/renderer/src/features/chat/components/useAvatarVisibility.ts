import { useEffect, useState } from 'react'

export function useAvatarVisibility(active: boolean, threadId: string | null): boolean {
  const [snapshot, setSnapshot] = useState({ active, threadId, expired: !active })
  const changed = snapshot.active !== active || snapshot.threadId !== threadId
  if (changed) {
    setSnapshot({
      active,
      threadId,
      expired: !active && (snapshot.threadId !== threadId || !snapshot.active)
    })
  }
  useEffect(() => {
    if (active) return
    const timer = setTimeout(() => setSnapshot({ active, threadId, expired: true }), 10_000)
    return () => clearTimeout(timer)
  }, [active, threadId])
  return active || (!changed && !snapshot.expired)
}
