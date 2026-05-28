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
