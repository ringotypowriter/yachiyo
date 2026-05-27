import type { RunContextSourceSummary, SkillSummary, ToolCallName } from '@yachiyo/shared/protocol'
import type { RecallDecisionSnapshot } from '@yachiyo/shared/protocol'
import { formatActivityDuration } from '../../../../activity/ActivitySummarizer.ts'

export function buildContextSources(input: {
  evolvedTraitCount: number
  hasUserContent: boolean
  enabledTools: ToolCallName[]
  activeSkills: SkillSummary[]
  fileMentionCount: number
  inlinedFileCount: number
  workspacePath: string
  hasToolReminder: boolean
  memoryEntries: string[]
  recallDecision: RecallDecisionSnapshot | undefined
  activitySummary?: { uniqueApps: number; afkDurationMs?: number }
}): RunContextSourceSummary[] {
  const sources: RunContextSourceSummary[] = []

  sources.push({ kind: 'persona', present: true })

  sources.push(
    input.evolvedTraitCount > 0
      ? {
          kind: 'soul',
          present: true,
          count: input.evolvedTraitCount,
          summary: `${input.evolvedTraitCount} ${input.evolvedTraitCount === 1 ? 'trait' : 'traits'}`
        }
      : { kind: 'soul', present: false }
  )

  sources.push({ kind: 'user', present: input.hasUserContent })

  sources.push(
    input.activeSkills.length > 0
      ? {
          kind: 'skills',
          present: true,
          count: input.activeSkills.length,
          summary: `${input.activeSkills.length} ${input.activeSkills.length === 1 ? 'skill' : 'skills'} active`
        }
      : { kind: 'skills', present: false }
  )

  sources.push(
    input.fileMentionCount > 0
      ? {
          kind: 'fileMentions',
          present: true,
          count: input.fileMentionCount,
          summary:
            input.inlinedFileCount > 0
              ? `${input.fileMentionCount} file reference${input.fileMentionCount === 1 ? '' : 's'} · ${input.inlinedFileCount} inlined`
              : `${input.fileMentionCount} file reference${input.fileMentionCount === 1 ? '' : 's'}`
        }
      : { kind: 'fileMentions', present: false }
  )

  const toolCount = input.enabledTools.length
  const agentSummaryParts = [`${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`]
  if (input.workspacePath) {
    agentSummaryParts.push('workspace')
  }
  sources.push({
    kind: 'agent',
    present: true,
    count: toolCount,
    summary: agentSummaryParts.join(' · ')
  })

  if (input.recallDecision) {
    const entryCount = input.memoryEntries.filter((e) => e.trim()).length
    sources.push(
      input.recallDecision.shouldRecall
        ? {
            kind: 'memory',
            present: true,
            count: entryCount,
            reasons: input.recallDecision.reasons,
            summary: `${entryCount} ${entryCount === 1 ? 'memory' : 'memories'} recalled`
          }
        : {
            kind: 'memory',
            present: false,
            reasons: input.recallDecision.reasons,
            summary: 'not recalled'
          }
    )
  }

  if (input.hasToolReminder) {
    sources.push({ kind: 'toolReminder', present: true })
  }

  if (input.activitySummary) {
    const activitySummaryParts = [
      `${input.activitySummary.uniqueApps} app${input.activitySummary.uniqueApps === 1 ? '' : 's'}`
    ]
    if (
      input.activitySummary.afkDurationMs !== undefined &&
      input.activitySummary.afkDurationMs > 0
    ) {
      activitySummaryParts.push(
        `AFK ${formatActivityDuration(input.activitySummary.afkDurationMs)}`
      )
    }
    sources.push({
      kind: 'activity',
      present: true,
      summary: activitySummaryParts.join(' · ')
    })
  }

  return sources
}
