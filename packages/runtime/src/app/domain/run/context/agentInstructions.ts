import { platform, release } from 'node:os'

import type {
  NamedSubagentId,
  SkillSummary,
  SubagentProfile,
  ToolCallName
} from '@yachiyo/shared/protocol'
import { RUN_MODE_DEFINITIONS, SELECTABLE_RUN_MODE_IDS } from '@yachiyo/shared/toolModes'
import {
  DEFAULT_NAMED_SUBAGENT_PROFILES,
  SUBAGENT_DESCRIPTIONS,
  WORKER_DELEGATION_PROMPT_GUIDANCE
} from '../../../../settings/namedSubagents.ts'
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
  }
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
    'Use `delegateTask` to run parallel tasks or to work within a narrower tool context. Choose the subagent that matches the task and write a self-contained prompt.',
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

  if (mode === 'acp') {
    lines.push(
      '',
      'Session resume:',
      '- Omit `session_id` for new tasks.',
      '- Only pass `session_id` when the user explicitly asks to resume, with an exact ID from a prior `delegateTask` result in context. Never invent one.'
    )
  }

  if (mode === 'worker') {
    const enabled = subagentsConfig?.enabledNamedAgents ?? []
    if (enabled.length > 0) {
      lines.push('', 'Worker prompt guidance:')
      for (const item of WORKER_DELEGATION_PROMPT_GUIDANCE) {
        lines.push(`- ${item}`)
      }
      lines.push('', 'Available subagents:')
      for (const id of enabled) {
        const tools = DEFAULT_NAMED_SUBAGENT_PROFILES[id]?.allowedTools?.join(', ') ?? 'all tools'
        lines.push(`- ${id}: ${SUBAGENT_DESCRIPTIONS[id]} (Tools: ${tools})`)
      }
    }
  } else {
    lines.push('', 'Available agent profiles:')
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
    'You are operating as a tool-using local agent.',
    'Default execution mode is YOLO: use tools directly for normal local work instead of asking for per-step confirmation.',
    'Available run modes:',
    ...runModeLines,
    'The active mode is Auto Mode unless the turn reminder states otherwise.',
    workspaceLine,
    systemLine,
    'Relative paths should resolve from that workspace unless you intentionally use an absolute path.'
  ]

  if (input.isUserSpecifiedWorkspace) {
    instructions.push(
      "The user has loaded a specific project workspace. At the start of your first reply, if the user's message is ambiguous or lacks context, proactively explore the project (e.g. read key files, check structure) to gain enough understanding before responding — the user may jump directly into discussing the project without preamble."
    )
  }

  if (input.userDocumentPath || input.soulDocumentPath) {
    instructions.push('Durable context files live outside the thread workspace.')
  }

  if (input.userDocumentPath) {
    instructions.push(
      `USER.md is at ${input.userDocumentPath}. It stores durable understanding of the user. Update it only for stable user facts, preferences, communication style, or work style.`
    )
  }

  if (input.soulDocumentPath) {
    instructions.push(
      `SOUL.md is at ${input.soulDocumentPath}. It stores your evolving self-model and personality continuity. Do not mix USER.md content into SOUL.md.`,
      'To update SOUL.md, use yachiyo CLI commands (for example, yachiyo soul add) or built-in skills. Do not use raw edit or write tools on SOUL.md directly.'
    )
  }

  if (
    input.enabledTools.length === 0 &&
    !input.hasSourceQuery &&
    !input.hasUpdateProfile &&
    !input.hasRemember &&
    !input.hasTodoTool
  ) {
    instructions.push('No tools are available for this run. Respond without tool calls.')
    return instructions.join('\n')
  }

  if (input.enabledTools.length > 0) {
    instructions.push(`Available tools: ${input.enabledTools.join(', ')}.`)
  }

  if (input.activeSkills.length > 0) {
    instructions.push(`Active Skills: ${input.activeSkills.map((skill) => skill.name).join(', ')}.`)
  }

  if (input.enabledTools.includes('bash')) {
    instructions.push('Use bash for shell commands when shell execution is the clearest path.')
  }

  if (input.enabledTools.includes('grep')) {
    instructions.push('Use grep for text/code search before falling back to bash search commands.')
  }

  if (input.enabledTools.includes('glob')) {
    instructions.push('Use glob for file discovery before falling back to bash find/fd commands.')
  }

  if (
    input.enabledTools.some(
      (toolName) =>
        toolName === 'read' || toolName === 'write' || toolName === 'edit' || toolName === 'glob'
    )
  ) {
    instructions.push(
      'Use read, write, or edit for direct file work when that is clearer than shell commands.'
    )
  }

  if (input.enabledTools.includes('webRead')) {
    instructions.push(
      'Use webRead for static HTTP(S) resources when you want to read the response body. It extracts readable content from HTML when possible, returns raw bodies for non-HTML text responses, and falls back to raw HTML if extraction fails. It is not a browser automation or JS-rendering tool.'
    )
  }

  if (input.enabledTools.includes('webSearch')) {
    instructions.push(
      'Use webSearch for general search results across the web. It returns normalized search hits, not arbitrary browser automation.'
    )
  }

  if (input.enabledTools.includes('skillsRead')) {
    instructions.push('Use skillsRead to get the full instructions of a discovered Skill by name.')
  }

  if (input.hasSourceQuery) {
    instructions.push(
      'querySource is available internally. Use it to look up local context sources, including memories when configured, past conversations, and activity records when source storage is available. In user-facing answers, describe thread records as conversations unless naming a table or field.'
    )
  }

  if (input.hasTodoTool) {
    instructions.push(
      [
        'updateTodoList is available internally to maintain the persistent todo widget for the user.',
        'Use updateTodoList when the user asks for work with three or more independent steps, or when executing a plan that has explicit sequential steps; do not use it for single-step tasks, pure information answers, or trivial operations.',
        'Each call must send the full current list with statuses pending, in_progress, or completed. Prefer one in_progress item for strictly sequential work, but preserve multiple in_progress items when that is the honest state.',
        'A good todo entry is user-visible, outcome-oriented, independently actionable, and verifiable as done. Keep entries at the same abstraction level.',
        'Do not make todo entries for internal tool usage, thinking, reading context, reporting back, or vague phases like "investigate", "implement", or "test" unless the concrete outcome is named.',
        'Todo entry few-shots:',
        'Bad: "Investigate code", "Implement changes", "Test". Good: "Identify the renderer path exposing hidden messages", "Separate hidden and visible follow-up drafts", "Verify hidden-message grouping and streaming behavior".',
        'Bad: "Research options", "Write plan", "Finalize". Good: "Compare candidate options against the user constraints", "Draft the selected plan with concrete steps", "List unresolved decisions and recommended defaults".',
        'Before starting a step, mark it in_progress. Immediately after finishing a step, mark it completed.',
        'If blocked by an external dependency or error, keep the current item in_progress and include the blocker in that item description.',
        'Remove items that are no longer relevant. When all work is finished, send the full list with every item completed; do not clear the list.'
      ].join('\n')
    )
  }

  const parts: string[] = [instructions.join('\n')]
  if (input.subagentContextBlock) {
    parts.push(input.subagentContextBlock)
  }

  return parts.join('\n\n')
}
