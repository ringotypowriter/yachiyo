export interface SubagentIndicatorAgent {
  delegationId: string
  agentName: string
  codeName?: string
  progress: string
}

export interface SubagentIndicatorProgressEntry {
  delegationId: string
  agentName: string
  chunk: string
}

export function canCancelFromIndicator(agents: SubagentIndicatorAgent[]): boolean {
  return agents.length === 1
}

export function resolveLegacySubagentIds(
  activeSubagentIds: readonly string[],
  snapshotIds: readonly string[]
): string[] {
  const snapshotIdSet = new Set(snapshotIds)
  return activeSubagentIds.filter((delegationId) => !snapshotIdSet.has(delegationId))
}

export function resolveSubagentIndicatorAgent<T extends SubagentIndicatorAgent>(
  agents: T[],
  selectedDelegationId: string | null
): T | undefined {
  return agents.find((agent) => agent.delegationId === selectedDelegationId) ?? agents[0]
}

export type SubagentIndicatorTabKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End'

export function resolveSubagentIndicatorTabIndex(
  agentCount: number,
  currentIndex: number,
  key: SubagentIndicatorTabKey
): number {
  if (agentCount === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return agentCount - 1
  if (key === 'ArrowLeft') return (currentIndex - 1 + agentCount) % agentCount
  return (currentIndex + 1) % agentCount
}

/** Build a plain-text stream with labeled agent sections. */
export function buildSubagentIndicatorStream(
  entries: SubagentIndicatorProgressEntry[],
  codeNames?: Record<string, string | undefined>
): string {
  let stream = ''
  let currentDelegationId: string | null = null

  for (const entry of entries) {
    if (entry.delegationId !== currentDelegationId) {
      if (stream && !stream.endsWith('\n')) {
        stream += '\n'
      }
      const codeName = codeNames?.[entry.delegationId]
      if (codeName) {
        stream += `[${codeName}]\n`
      } else {
        stream += `[${entry.agentName}]\n`
      }
      currentDelegationId = entry.delegationId
    }
    stream += entry.chunk
  }

  return stream
}
