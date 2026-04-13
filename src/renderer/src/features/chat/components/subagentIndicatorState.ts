export interface SubagentIndicatorAgent {
  delegationId: string
  agentName: string
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

export function buildSubagentIndicatorStream(entries: SubagentIndicatorProgressEntry[]): string {
  let stream = ''
  let currentDelegationId: string | null = null

  for (const entry of entries) {
    if (entry.delegationId !== currentDelegationId) {
      if (stream && !stream.endsWith('\n')) {
        stream += '\n'
      }
      stream += `[${entry.agentName}]\n`
      currentDelegationId = entry.delegationId
    }
    stream += entry.chunk
  }

  return stream
}
