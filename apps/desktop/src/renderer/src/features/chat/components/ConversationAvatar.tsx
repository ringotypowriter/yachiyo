import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore, type AppState } from '@renderer/app/store/useAppStore'
import { YachiyoAvatar } from '@renderer/components/avatar/YachiyoAvatar'
import { avatarLabels, type AvatarPhase } from '@renderer/components/avatar/avatarTypes'
import { WINK_DURATION_MS } from '@renderer/components/avatar/winkMotion'
import { selectRunAvatarPhase, shouldCelebrateRun } from '../lib/runAvatarState'

function selectIndicator(state: AppState): {
  threadId: string | null
  runId: string | null
  completedRunId?: string
  status: string
  phase: AvatarPhase
} {
  const threadId = state.activeThreadId
  const latest = threadId ? state.latestRunsByThread[threadId] : undefined
  return {
    threadId,
    runId: threadId ? (state.activeRunIdsByThread[threadId] ?? null) : null,
    completedRunId: latest?.id,
    status: latest?.status ?? 'idle',
    phase: selectRunAvatarPhase(state, threadId)
  }
}

export function ConversationAvatar(): React.JSX.Element {
  const current = useAppStore(useShallow(selectIndicator))
  const [celebratingThread, setCelebratingThread] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      const next = selectIndicator(state)
      const previous = selectIndicator(previousState)
      if (
        next.threadId === previous.threadId &&
        next.runId === previous.runId &&
        next.completedRunId === previous.completedRunId &&
        next.status === previous.status
      )
        return
      clearTimeout(timer)
      const celebrate = !document.hidden && shouldCelebrateRun(previous, next)
      setCelebratingThread(celebrate ? next.threadId : null)
      if (celebrate) timer = setTimeout(() => setCelebratingThread(null), WINK_DURATION_MS + 100)
    })
    return () => {
      unsubscribe()
      clearTimeout(timer)
    }
  }, [])

  const celebrating =
    current.phase === 'idle' && celebratingThread !== null && celebratingThread === current.threadId
  const phase = celebrating ? 'success' : current.phase
  return (
    <div className="conversation-avatar" data-conversation-avatar>
      <YachiyoAvatar
        phase={phase}
        size="conversation"
        idleWink={false}
        label={`Yachiyo: ${avatarLabels[phase]}`}
      />
    </div>
  )
}
