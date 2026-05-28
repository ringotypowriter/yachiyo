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

export interface AgentIdentity {
  delegationId: string
  agentName: string
  index: number
  color: string
}

export function canCancelFromIndicator(agents: SubagentIndicatorAgent[]): boolean {
  return agents.length === 1
}

/** Build a plain-text stream with labeled agent sections. */
export function buildSubagentIndicatorStream(
  entries: SubagentIndicatorProgressEntry[],
  identities?: Record<string, AgentIdentity>
): string {
  let stream = ''
  let currentDelegationId: string | null = null

  for (const entry of entries) {
    if (entry.delegationId !== currentDelegationId) {
      if (stream && !stream.endsWith('\n')) {
        stream += '\n'
      }
      const identity = identities?.[entry.delegationId]
      if (identity) {
        stream += `[#${identity.index} ${entry.agentName}]\n`
      } else {
        stream += `[${entry.agentName}]\n`
      }
      currentDelegationId = entry.delegationId
    }
    stream += entry.chunk
  }

  return stream
}

export function buildAgentIdentities(agents: SubagentIndicatorAgent[]): AgentIdentity[] {
  const colors = [
    '#3b82f6', // blue
    '#10b981', // emerald
    '#f59e0b', // amber
    '#8b5cf6', // violet
    '#ec4899', // pink
    '#06b6d4', // cyan
    '#f97316', // orange
    '#84cc16' // lime
  ]

  return agents.map((agent, i) => ({
    delegationId: agent.delegationId,
    agentName: agent.agentName,
    index: i + 1,
    color: colors[i % colors.length] ?? colors[0]
  }))
}
