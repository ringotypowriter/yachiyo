import { platform, release } from 'node:os'

import type {
  NamedSubagentId,
  SkillSummary,
  SubagentProfile,
  SubagentSnapshot,
  ToolCallName
} from '@yachiyo/shared/protocol'
import { RUN_MODE_DEFINITIONS, SELECTABLE_RUN_MODE_IDS } from '@yachiyo/shared/toolModes'
import type { GitContext } from './gitContext.ts'

export function resolveModelEnabledTools(input: {
  activeSkills: SkillSummary[]
  enabledTools: ToolCallName[]
}): ToolCallName[] {
  if (input.activeSkills.length === 0 || input.enabledTools.includes('skillsRead')) {
    return input.enabledTools
  }

  return [...input.enabledTools, 'skillsRead']
}

export function buildSubagentContextBlock(
  gitCtx: GitContext,
  workspacePath: string,
  profiles: SubagentProfile[],
  availableWorkspaces: string[] = [],
  subagentsConfig?: {
    mode: 'worker' | 'acp'
    enabledNamedAgents: NamedSubagentId[]
  },
  activeSubagents: readonly SubagentSnapshot[] = []
): string {
  const enabledProfiles = profiles.filter((p) => p.enabled)
  const mode = subagentsConfig?.mode ?? 'worker'
  const hasAnySubagent =
    mode === 'worker'
      ? (subagentsConfig?.enabledNamedAgents.length ?? 0) > 0
      : enabledProfiles.length > 0

  if (!hasAnySubagent) {
    return ''
  }

  if (mode === 'acp' && !gitCtx.hasGit && availableWorkspaces.length === 0) {
    return [
      '<subagents>',
      'The `delegateTask` tool is unavailable because the current workspace is not a Git repository. If asked to delegate, inform the user that a Git repository must be initialized first for safe execution.',
      '</subagents>'
    ].join('\n')
  }

  const gitContextLines: string[] = []
  if (gitCtx.hasGit) {
    gitContextLines.push(
      'Git Context:',
      `- Current Branch: ${gitCtx.currentBranch ?? 'unknown'}`,
      `- Main Branch: ${gitCtx.mainBranch ?? 'main'}`
    )
    if (gitCtx.agentsMdContent) {
      gitContextLines.push(
        'Project Agent Rules (AGENTS.md):',
        '```markdown',
        gitCtx.agentsMdContent,
        '```'
      )
    } else if (gitCtx.hasAgentsMd) {
      gitContextLines.push(
        '- AGENTS.md: Yes (check it before doing any coding work — it may contain project-specific rules or constraints for coding agents)'
      )
    }
  }

  const workspaceRule =
    availableWorkspaces.length > 0
      ? `Agents operate in the current workspace by default (${workspacePath}). To switch workspaces, pass the \`workspace\` parameter with one of the listed paths.`
      : `Agents must stay within the current workspace: ${workspacePath}.`

  const lines = [
    '<subagents>',
    'Project rules below govern your work in this workspace and must also be preserved when you delegate. Workspace and profile details describe where delegated agents can run.',
    '',
    '<agent_rules>',
    workspaceRule
  ]

  if (gitContextLines.length > 0) {
    lines.push('', ...gitContextLines)
  }

  if (availableWorkspaces.length > 0) {
    lines.push('', 'Available Workspaces:')
    for (const ws of availableWorkspaces) {
      lines.push(`- ${ws}`)
    }
  }

  if (mode === 'worker') {
    lines.push(
      '',
      'Worker collaboration:',
      '- `delegateTask` launches a Worker Task asynchronously. The tool call completes when launch succeeds; it does not mean the Task or Worker lifecycle has ended.',
      '- When your next useful action depends on a running Task, end the current parent turn without presenting the overall work as complete. Every completed Task turn is delivered automatically and wakes this conversation.',
      '- Use `getTask` with an exact Task ID when you need its current state, latest progress, output, or error. Do not busy-poll.',
      '- After a Worker finishes a turn, its Task becomes idle and remains addressable with its conversation history until it expires.',
      '- Continue related work or recover an interrupted idle Task with `steerTask`. A running Task reads the steer at a safe boundary; an idle Task wakes immediately.',
      '- Launch a new Worker when the work should be independent or no suitable live Worker exists. Code names are display labels, not routing addresses.'
    )
    if (activeSubagents.length > 0) {
      lines.push('', 'Current live Worker Task roster:')
      for (const subagent of activeSubagents) {
        lines.push(
          `- ${subagent.agentId}: ${subagent.codeName} (${subagent.agentType}), ${subagent.state}`
        )
      }
    } else {
      lines.push('', 'Current live Worker Task roster: none.')
    }
  }

  if (mode === 'acp') {
    lines.push(
      '',
      'Session resume:',
      '- Omit `session_id` for new tasks.',
      '- Only pass `session_id` when the user explicitly asks to resume, with an exact ID from a prior `delegateTask` result in context. Never invent one.',
      '',
      'Available agent profiles:'
    )
    for (const profile of enabledProfiles) {
      lines.push(`- ${profile.name}: ${profile.description}`)
    }
  }

  lines.push('</agent_rules>', '</subagents>')
  return lines.join('\n')
}

export function buildAgentInstructions(input: {
  workspacePath: string
  workspaceLabel?: string
  enabledTools: ToolCallName[]
  activeSkills: SkillSummary[]
  hasSourceQuery: boolean
  hasUpdateProfile?: boolean
  hasRemember?: boolean
  hasTodoTool?: boolean
  soulDocumentPath?: string
  userDocumentPath?: string
  subagentContextBlock?: string
  isUserSpecifiedWorkspace?: boolean
}): string {
  const workspaceLine = input.workspaceLabel
    ? `The current thread workspace is ${input.workspacePath} (${input.workspaceLabel}).`
    : `The current thread workspace is ${input.workspacePath}.`
  const systemLine = `System Platform: ${platform()} ${release()}`
  const runModeLines = SELECTABLE_RUN_MODE_IDS.map((modeId) => {
    const mode = RUN_MODE_DEFINITIONS[modeId]
    return `- ${mode.label}: ${mode.description}`
  })
  const instructions = [
    '## Local agent runtime',
    '',
    'You are operating as a tool-using local agent. In Auto Mode, use the capabilities exposed for this run directly when they help with the user’s request; normal local work does not need per-step confirmation.',
    'Available run modes:',
    ...runModeLines,
    'Auto Mode is active unless the latest turn reminder names another mode.',
    workspaceLine,
    systemLine,
    'Resolve relative paths from this workspace unless a task intentionally uses an absolute path.',
    '',
    'In Yachiyo, a thread is the persistent container for messages, branches, workspace context, and continuity. A conversation is the visible dialogue inside that thread. A run is one execution attempt within it, so a per-run limit applies to the active execution rather than to the whole conversation. Scheduled work can continue later in an independent thread without the user remaining present.'
  ]

  if (input.isUserSpecifiedWorkspace) {
    instructions.push(
      'The user deliberately loaded this project workspace. If their first message assumes project knowledge without giving enough context, inspect the relevant files before interpreting the request; they may continue a project discussion without reintroducing it.'
    )
  }

  if (input.userDocumentPath || input.soulDocumentPath) {
    instructions.push('', 'Durable context documents live outside the thread workspace.')
  }

  if (input.userDocumentPath) {
    instructions.push(
      `The current USER.md content is already loaded above. Its file is ${input.userDocumentPath}; update that document only when a fact or collaboration preference should persist beyond the current task.`
    )
  }

  if (input.soulDocumentPath) {
    instructions.push(
      `The current SOUL.md content is already loaded above. Its file is ${input.soulDocumentPath}; it holds your evolving self-model rather than facts about the user. Update it through the Yachiyo CLI or the relevant built-in Skill so its structure remains intact.`
    )
  }

  const hasYachiyoHelp = input.activeSkills.some((skill) => skill.name === 'yachiyo-help')
  instructions.push(
    hasYachiyoHelp
      ? 'When the user asks how to configure or manage Yachiyo, read the yachiyo-help Skill for the current commands and use it as the operating guide.'
      : 'If the user asks how to configure or manage Yachiyo, direct them to Settings > Skills > yachiyo-help because that operating guide is not active in this run.'
  )

  if (
    input.enabledTools.length === 0 &&
    !input.hasSourceQuery &&
    !input.hasUpdateProfile &&
    !input.hasRemember &&
    !input.hasTodoTool
  ) {
    instructions.push(
      'This run exposes no tools, so answer from the conversation and available context.'
    )
    return instructions.join('\n')
  }

  instructions.push(
    '',
    'The runtime exposes the tools available for this run with their own descriptions and input contracts. Choose among them by the job at hand instead of repeating those contracts here. Active Skills are listed in their own layer; load one when its description fits the task.'
  )

  const parts: string[] = [instructions.join('\n')]
  if (input.subagentContextBlock) {
    parts.push(input.subagentContextBlock)
  }

  return parts.join('\n\n')
}
