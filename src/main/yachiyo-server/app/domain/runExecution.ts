import { execFile } from 'node:child_process'
import { access, constants, readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MEMORY_RECALL_TIMEOUT_MS = 15_000
const DEFAULT_MAX_TOOL_STEPS = 100
const OWNER_DM_MAX_TOOL_STEPS = 30
const EXTERNAL_CHANNEL_MAX_TOOL_STEPS = 10

import type {
  HarnessFinishedEvent,
  HarnessStartedEvent,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  MessageTextBlockRecord,
  MessageTurnContext,
  ProviderSettings,
  RunCancelledEvent,
  RunCompletedEvent,
  RunContextCompiledEvent,
  RunContextSourceSummary,
  RunFailedEvent,
  RunMemoryRecalledEvent,
  SkillCatalogEntry,
  SkillSummary,
  SettingsConfig,
  SubagentProfile,
  SubagentStartedEvent,
  SubagentFinishedEvent,
  ThreadRecord,
  ThreadUpdatedEvent,
  ToolCallName,
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../shared/yachiyo/protocol.ts'
import { isCoreToolName } from '../../../../shared/yachiyo/protocol.ts'
import { collectMessagePath } from '../../../../shared/yachiyo/threadTree.ts'
import { prepareModelMessages } from '../../runtime/messagePrepare.ts'
import {
  buildExternalAgentInstructions,
  compileExternalContextLayers
} from '../../runtime/externalContextLayers.ts'
import { EXTERNAL_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../../runtime/prompt.ts'
import type { MemoryService } from '../../services/memory/memoryService.ts'
import type { RecallDecisionSnapshot } from '../../../../shared/yachiyo/protocol.ts'
import { resolveActiveSkills } from '../../services/skills/skillResolver.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import type { BrowserWebPageSnapshotLoader } from '../../services/webRead/browserWebPageSnapshot.ts'
import {
  buildCurrentTimeSection,
  buildToolAvailabilityReminderSection,
  formatQueryReminder
} from '../../runtime/queryReminder.ts'
import { resolveFileMentionsForUserQuery } from '../../runtime/fileMentions.ts'
import { readSoulDocument, type SoulDocument } from '../../runtime/soul.ts'
import { readUserDocument, type UserDocument } from '../../runtime/user.ts'
import { resolveYachiyoUserPath } from '../../config/paths.ts'
import { readChannelsConfig } from '../../runtime/channelsConfig.ts'
import type { ModelRuntime, ModelUsage } from '../../runtime/types.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import {
  createAgentToolSet,
  normalizeToolResult,
  summarizeToolInput
} from '../../tools/agentTools.ts'
import { createFilteredMemoryService } from '../../tools/agentTools/memorySearchTool.ts'
import {
  DEFAULT_HARNESS_NAME,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'
import { resolveEnabledTools } from './configDomain.ts'

export interface ExecuteRunInput {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  channelHint?: string
  extraTools?: import('ai').ToolSet
  runId: string
  thread: ThreadRecord
  requestMessageId: string
  abortController: AbortController
  updateHeadOnComplete: boolean
  previousEnabledTools: ToolCallName[] | null
}

export interface RestartRunReason {
  type: 'restart'
  nextRequestMessageId: string
}

export type ExecuteRunResult =
  | { kind: 'completed'; totalPromptTokens?: number }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'restarted'; nextRequestMessageId: string }

export interface RunExecutionDeps {
  storage: YachiyoStorage
  createId: CreateId
  timestamp: Timestamp
  emit: EmitServerEvent
  createModelRuntime: () => ModelRuntime
  ensureThreadWorkspace: (threadId: string) => Promise<string>
  buildMemoryLayerEntries?: (input: {
    requestMessageId: string
    signal: AbortSignal
    thread: ThreadRecord
    userQuery: string
  }) => Promise<{
    entries: string[]
    recallDecision?: RecallDecisionSnapshot
  }>
  fetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  memoryService: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
  readSoulDocument?: () => Promise<SoulDocument | null>
  readUserDocument?: () => Promise<UserDocument | null>
  readThread: (threadId: string) => ThreadRecord
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
  loadThreadMessages: (threadId: string) => MessageRecord[]
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
  listSkills: (workspacePaths?: string[]) => Promise<SkillCatalogEntry[]>
  onEnabledToolsUsed: (enabledTools: ToolCallName[]) => void
  onExecutionPhaseChange?: (phase: 'generating' | 'tool-running') => void
  onSafeToSteerAfterTool?: () => void
  onTerminalState?: () => void
  onSubagentProgress?: (chunk: string) => void
  onSubagentStarted?: (agentName: string) => void
  onSubagentFinished?: (
    agentName: string,
    status: 'success' | 'cancelled',
    lastMessage?: string
  ) => void
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function appendMessageDeltaToTextBlocks(input: {
  textBlocks: MessageTextBlockRecord[]
  delta: string
  timestamp: string
  createId: CreateId
  shouldStartNewBlock: boolean
}): { textBlocks: MessageTextBlockRecord[]; shouldStartNewBlock: boolean } {
  if (!input.delta) {
    return {
      textBlocks: input.textBlocks,
      shouldStartNewBlock: input.shouldStartNewBlock
    }
  }

  const nextTextBlocks = [...input.textBlocks]
  const currentTextBlock =
    !input.shouldStartNewBlock && nextTextBlocks.length > 0 ? nextTextBlocks.at(-1) : undefined

  if (currentTextBlock) {
    nextTextBlocks[nextTextBlocks.length - 1] = {
      ...currentTextBlock,
      content: currentTextBlock.content + input.delta
    }
  } else {
    nextTextBlocks.push({
      id: input.createId(),
      content: input.delta,
      createdAt: input.timestamp
    })
  }

  return {
    textBlocks: nextTextBlocks,
    shouldStartNewBlock: false
  }
}

function isRestartRunReason(value: unknown): value is RestartRunReason {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'restart' &&
    typeof (value as { nextRequestMessageId?: unknown }).nextRequestMessageId === 'string'
  )
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return
  }

  const error = new Error('Aborted')
  error.name = 'AbortError'
  throw error
}

function resolveModelEnabledTools(input: {
  activeSkills: SkillSummary[]
  enabledTools: ToolCallName[]
}): ToolCallName[] {
  if (input.activeSkills.length === 0 || input.enabledTools.includes('skillsRead')) {
    return input.enabledTools
  }

  return [...input.enabledTools, 'skillsRead']
}

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

  return sources
}

interface GitContext {
  hasGit: boolean
  currentBranch?: string
  mainBranch?: string
  hasAgentsMd?: boolean
}

async function detectGitContext(workspacePath: string): Promise<GitContext> {
  try {
    await access(join(workspacePath, '.git'), constants.F_OK)
  } catch {
    return { hasGit: false }
  }

  try {
    const [currentResult, mainResult] = await Promise.allSettled([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspacePath }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: workspacePath })
    ])

    const currentBranch =
      currentResult.status === 'fulfilled' ? currentResult.value.stdout.trim() : undefined
    const rawMain = mainResult.status === 'fulfilled' ? mainResult.value.stdout.trim() : undefined
    const mainBranch = rawMain?.replace(/^origin\//, '') ?? 'main'

    let hasAgentsMd = false
    try {
      await access(join(workspacePath, 'AGENTS.md'), constants.F_OK)
      hasAgentsMd = true
    } catch {
      // file absent
    }

    return { hasGit: true, currentBranch, mainBranch, hasAgentsMd }
  } catch {
    return { hasGit: true }
  }
}

function buildSubagentContextBlock(
  gitCtx: GitContext,
  workspacePath: string,
  profiles: SubagentProfile[],
  availableWorkspaces: string[] = []
): string {
  const enabledProfiles = profiles.filter((p) => p.enabled)
  if (enabledProfiles.length === 0) {
    return ''
  }

  if (!gitCtx.hasGit && availableWorkspaces.length === 0) {
    return [
      '<coding_agents>',
      '⚠️ CRITICAL: The current workspace is NOT a Git repository.',
      'You CANNOT use the `delegateCodingTask` tool. If the user asks you to delegate a task, inform them that a Git repository must be initialized first to ensure safe YOLO execution.',
      '</coding_agents>'
    ].join('\n')
  }

  const gitContextLines: string[] = []
  if (gitCtx.hasGit) {
    gitContextLines.push(
      'Git Context:',
      `- Current Branch: ${gitCtx.currentBranch ?? 'unknown'}`,
      `- Main Branch: ${gitCtx.mainBranch ?? 'main'}`
    )
    if (gitCtx.hasAgentsMd) {
      gitContextLines.push(
        '- AGENTS.md: Yes (check it before delegating — it may contain project-specific rules or constraints for coding agents)'
      )
    }
  }

  const workspaceRule =
    availableWorkspaces.length > 0
      ? `CRITICAL RULE 1: By default agents operate in the current thread workspace: ${workspacePath}. You may also specify one of the available workspaces below using the \`workspace\` parameter. Agents MUST ONLY operate in the thread workspace or one of the listed workspaces — never an arbitrary path.`
      : `CRITICAL RULE 1: Agents MUST ONLY operate within the current thread workspace: ${workspacePath}.`

  const lines = [
    '<coding_agents>',
    'You can delegate complex coding tasks to the following ACP-compatible agents using the `delegateCodingTask` tool.',
    workspaceRule,
    '',
    ...gitContextLines
  ]

  if (availableWorkspaces.length > 0) {
    lines.push('')
    lines.push('Available Workspaces (use the `workspace` parameter to select):')
    for (const ws of availableWorkspaces) {
      lines.push(`- ${ws}`)
    }
  }

  lines.push(
    '',
    'CRITICAL RULE 2 (PROMPT AUTHORING):',
    'When writing the `prompt` parameter for the delegated agent, you MUST follow these constraints:',
    '- Write strictly in English.',
    '- Use direct, imperative natural language (e.g., "Implement X", "Ensure Y").',
    '- Provide ONLY: the objective, current context/constraints, and acceptance criteria.',
    '- DO NOT predefine architectural structures; let the agent decide the implementation.',
    '- DO NOT use overly structured, markdown-heavy formatting.',
    '',
    'CRITICAL RULE 3 (SESSION RESUME):',
    '- For a new delegated task, omit `session_id`.',
    '- Use `session_id` only when the user explicitly asks to continue or resume the same delegated task.',
    '- Only copy the exact `session_id` from a previous `delegateCodingTask` tool result that is present in the current context.',
    '- Never invent, guess, infer, or transform a `session_id`.',
    '',
    'Available Agents:'
  )

  for (const profile of enabledProfiles) {
    lines.push(`- Name: "${profile.name}" (Description: ${profile.description})`)
  }

  lines.push('</coding_agents>')
  return lines.join('\n')
}

function buildAgentInstructions(input: {
  workspacePath: string
  enabledTools: ToolCallName[]
  activeSkills: SkillSummary[]
  hasHiddenMemorySearch: boolean
  soulDocumentPath?: string
  userDocumentPath?: string
  subagentContextBlock?: string
  isUserSpecifiedWorkspace?: boolean
  maxToolSteps?: number
}): string {
  const instructions = [
    'You are operating as a tool-using local agent.',
    'Default execution mode is YOLO: use tools directly for normal local work instead of asking for per-step confirmation.',
    `The current thread workspace is ${input.workspacePath}.`,
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

  if (input.enabledTools.length === 0 && !input.hasHiddenMemorySearch) {
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
    instructions.push(
      'Use skillsRead to inspect discovered Skills by name. It returns paths by default and only includes full SKILL.md content when you explicitly request it.'
    )
  }

  if (input.hasHiddenMemorySearch) {
    instructions.push(
      'Long-term memory search is available internally. Use it for durable preferences, decisions, workflows, constraints, bugs, and project facts instead of guessing.'
    )
  }

  // Tool Execution Discipline
  instructions.push(
    'Before modifying any file, use read or grep to verify the exact content and context; never assume or guess file contents.',
    'Prefer native search tools (grep, glob) over complex bash pipelines for file and content discovery; this avoids shell-escaping errors and produces more reliable results.',
    'After any write or edit operation, verify the result by reading the affected location before proceeding.'
  )

  // Blast Radius & Risk Management
  instructions.push(
    'Before executing destructive or large-scale operations (mass file deletion, heavy refactoring, database wipes, force-overwriting existing work), output an explicit plan stating the scope and consequences, then pause for user confirmation.',
    'When a tool call is blocked or fails, diagnose the root cause and try an alternative approach; never brute-force retry the same blocked action.'
  )

  // Anti-Hallucination
  instructions.push(
    'Never invent file contents, API shapes, configuration keys, or project structures. If you are uncertain about any of these, use tools to discover the ground truth before proceeding.'
  )

  // Response Discipline
  instructions.push(
    "After completing tool work, always synthesize a direct response to the user's original question. Never end your turn with only tool calls and no user-facing text."
  )
  if (input.maxToolSteps != null) {
    instructions.push(
      `You have a turn budget of ${input.maxToolSteps} generation rounds for this conversation turn. Each round may include multiple parallel tool calls. Plan tool usage efficiently — prefer targeted reads over broad exploration.`
    )
  }

  const parts: string[] = [instructions.join('\n')]
  if (input.subagentContextBlock) {
    parts.push(input.subagentContextBlock)
  }

  return parts.join('\n\n')
}

async function ensureResolvedWorkspacePath(
  thread: ThreadRecord,
  ensureThreadWorkspace: (threadId: string) => Promise<string>
): Promise<string> {
  if (!thread.workspacePath?.trim()) {
    return ensureThreadWorkspace(thread.id)
  }

  const workspacePath = resolve(thread.workspacePath)
  await mkdir(workspacePath, { recursive: true })
  return workspacePath
}

const SKILL_MENTION_RE = /^@skills:([a-zA-Z0-9_-]+)(\s|$)/

async function expandSkillMention(
  content: string,
  listSkills: RunExecutionDeps['listSkills'],
  workspacePaths: string[]
): Promise<string> {
  const match = SKILL_MENTION_RE.exec(content)
  if (!match) return content

  const skillName = match[1]
  const skills = await listSkills(workspacePaths)
  const skill = skills.find((s) => s.name === skillName)
  if (!skill) return content

  const skillContent = await readFile(skill.skillFilePath, 'utf8').catch(() => '')
  const lines: string[] = [
    `Skill: ${skill.name}`,
    ...(skill.description ? [`Description: ${skill.description}`] : []),
    '',
    skillContent.trim()
  ]
  const replacement = lines.join('\n').trim()
  const remainder = content.slice(match[0].length)
  return remainder ? `${replacement}\n\n${remainder}` : replacement
}

function loadRunHistory(
  loadThreadMessages: RunExecutionDeps['loadThreadMessages'],
  threadId: string,
  requestMessageId: string,
  requestMessageContentOverride?: string,
  /** If set, only messages after this watermark are included (external channel rolling summary). */
  summaryWatermarkMessageId?: string
): Array<Pick<MessageRecord, 'content' | 'images' | 'attachments' | 'role' | 'responseMessages'>> {
  let messagePath = collectMessagePath(loadThreadMessages(threadId), requestMessageId)

  // For external channels with a rolling summary watermark, trim history to only
  // messages after the watermark. The rolling summary covers everything before it.
  if (summaryWatermarkMessageId) {
    const watermarkIndex = messagePath.findIndex((m) => m.id === summaryWatermarkMessageId)
    if (watermarkIndex >= 0) {
      messagePath = messagePath.slice(watermarkIndex + 1)
    }
  }

  return messagePath.map(({ content, id, images, attachments, role, responseMessages }) => ({
    content: id === requestMessageId ? (requestMessageContentOverride ?? content) : content,
    ...(images ? { images } : {}),
    ...(attachments ? { attachments } : {}),
    ...(responseMessages ? { responseMessages } : {}),
    role
  }))
}

function finishPendingToolCalls(
  deps: Pick<RunExecutionDeps, 'emit' | 'storage'>,
  toolCalls: Map<string, ToolCallRecord>,
  input: { threadId: string; runId: string; finishedAt: string; error: string }
): void {
  for (const current of toolCalls.values()) {
    if (current.status !== 'running') {
      continue
    }

    const nextToolCall: ToolCallRecord = {
      ...current,
      status: 'failed',
      outputSummary: input.error,
      error: input.error,
      finishedAt: input.finishedAt
    }

    toolCalls.set(nextToolCall.id, nextToolCall)
    deps.storage.updateToolCall(nextToolCall)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: nextToolCall
    })
  }
}

function bindCompletedToolCallsToAssistant(
  deps: Pick<RunExecutionDeps, 'emit' | 'loadThreadToolCalls'>,
  toolCalls: Map<string, ToolCallRecord>,
  input: { threadId: string; runId: string; assistantMessageId: string }
): void {
  const persistedToolCalls = deps
    .loadThreadToolCalls(input.threadId)
    .filter(
      (toolCall) =>
        toolCall.runId === input.runId && toolCall.assistantMessageId === input.assistantMessageId
    )

  for (const persistedToolCall of persistedToolCalls) {
    toolCalls.set(persistedToolCall.id, persistedToolCall)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: persistedToolCall
    })
  }
}

function buildInterruptedToolCallInput(toolCall: ToolCallRecord): unknown {
  if (toolCall.toolName === 'bash') {
    return {
      command:
        toolCall.details && 'command' in toolCall.details
          ? toolCall.details.command
          : toolCall.inputSummary
    }
  }

  if (toolCall.toolName === 'webRead') {
    return {
      url:
        toolCall.details && 'requestedUrl' in toolCall.details
          ? toolCall.details.requestedUrl
          : toolCall.inputSummary
    }
  }

  if (toolCall.toolName === 'webSearch') {
    return {
      query:
        toolCall.details && 'query' in toolCall.details
          ? toolCall.details.query
          : toolCall.inputSummary
    }
  }

  if (toolCall.toolName === 'skillsRead') {
    return {
      names:
        toolCall.details && 'requestedNames' in toolCall.details
          ? toolCall.details.requestedNames
          : toolCall.inputSummary
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean)
    }
  }

  if (toolCall.toolName === 'grep' || toolCall.toolName === 'glob') {
    return {
      pattern:
        toolCall.details && 'pattern' in toolCall.details
          ? toolCall.details.pattern
          : toolCall.inputSummary
    }
  }

  if (
    toolCall.toolName === 'read' ||
    toolCall.toolName === 'write' ||
    toolCall.toolName === 'edit'
  ) {
    return {
      path:
        toolCall.details && 'path' in toolCall.details
          ? toolCall.details.path
          : toolCall.inputSummary
    }
  }

  return toolCall.inputSummary
}

function buildInterruptedToolCallOutput(toolCall: ToolCallRecord): unknown {
  if (toolCall.error) {
    return {
      type: 'content',
      value: [{ type: 'text', text: toolCall.error }]
    }
  }

  if (toolCall.toolName === 'bash' && toolCall.details && 'stdout' in toolCall.details) {
    const stdout = toolCall.details.stdout.trim()
    const stderr = 'stderr' in toolCall.details ? toolCall.details.stderr.trim() : ''
    const blocks = [
      ...(stdout ? [{ type: 'text', text: stdout }] : []),
      ...(stderr ? [{ type: 'text', text: stderr }] : [])
    ]

    if (blocks.length > 0) {
      return {
        type: 'content',
        value: blocks
      }
    }
  }

  if (toolCall.outputSummary) {
    return {
      type: 'content',
      value: [{ type: 'text', text: toolCall.outputSummary }]
    }
  }

  return {
    type: 'content',
    value: [{ type: 'text', text: 'tool completed' }]
  }
}

function buildInterruptedResponseMessages(input: {
  buffer: string
  reasoningBuffer: string
  toolCalls: Map<string, ToolCallRecord>
}): unknown[] | undefined {
  const completedToolCalls = [...input.toolCalls.values()]
    .filter((toolCall) => toolCall.finishedAt)
    .sort((left, right) => {
      const leftStep = left.stepIndex ?? 0
      const rightStep = right.stepIndex ?? 0
      return leftStep - rightStep || left.startedAt.localeCompare(right.startedAt)
    })

  if (completedToolCalls.length === 0 && !input.buffer && !input.reasoningBuffer) {
    return undefined
  }

  const assistantContent: unknown[] = []
  if (input.reasoningBuffer) {
    assistantContent.push({ type: 'reasoning', text: input.reasoningBuffer })
  }
  if (input.buffer) {
    assistantContent.push({ type: 'text', text: input.buffer })
  }
  for (const toolCall of completedToolCalls) {
    assistantContent.push({
      type: 'tool-call',
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      input: buildInterruptedToolCallInput(toolCall)
    })
  }

  const responseMessages: unknown[] = [
    {
      role: 'assistant',
      content: assistantContent
    }
  ]

  for (const toolCall of completedToolCalls) {
    responseMessages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: toolCall.id,
          toolName: toolCall.toolName,
          output: buildInterruptedToolCallOutput(toolCall)
        }
      ]
    })
  }

  return responseMessages
}

function persistTerminalAssistantMessage(
  deps: Pick<RunExecutionDeps, 'readThread' | 'storage'>,
  input: {
    runId: string
    threadId: string
    messageId: string
    requestMessageId: string
    timestamp: string
    settings: ProviderSettings
    status: MessageRecord['status']
    content: string
    textBlocks: MessageTextBlockRecord[]
  }
): MessageRecord {
  const currentThread = deps.readThread(input.threadId)
  const assistantMessage: MessageRecord = {
    id: input.messageId,
    threadId: input.threadId,
    parentMessageId: input.requestMessageId,
    role: 'assistant',
    content: input.content,
    ...(input.textBlocks.length > 0 ? { textBlocks: input.textBlocks } : {}),
    status: input.status,
    createdAt: input.timestamp,
    modelId: input.settings.model,
    providerName: input.settings.providerName
  }

  deps.storage.completeRun({
    runId: input.runId,
    updatedThread: {
      ...currentThread,
      updatedAt: input.timestamp
    },
    assistantMessage
  })

  return assistantMessage
}

export async function executeServerRun(
  deps: RunExecutionDeps,
  input: ExecuteRunInput
): Promise<ExecuteRunResult> {
  const settings = deps.readSettings()
  const harnessId = deps.createId()
  const messageId = deps.createId()
  const toolCalls = new Map<string, ToolCallRecord>()
  const runningToolCallIds = new Set<string>()
  let stepCount = 0
  let subagentToolCallId: string | undefined
  let subagentStartedAt: string | undefined
  let buffer = ''
  let reasoningBuffer = ''
  let textBlocks: MessageTextBlockRecord[] = []
  let shouldStartNewTextBlock = true
  let executionPhase: 'generating' | 'tool-running' = 'generating'
  let awaitingSafeSteerPointAfterTool = false
  let safeSteerTimer: ReturnType<typeof setTimeout> | null = null

  const clearSafeSteerTimer = (): void => {
    if (!safeSteerTimer) {
      return
    }

    clearTimeout(safeSteerTimer)
    safeSteerTimer = null
  }

  const cancelPendingSafeSteerPointAfterTool = (): void => {
    awaitingSafeSteerPointAfterTool = false
    clearSafeSteerTimer()
  }

  const flushSafeSteerPointAfterTool = (): void => {
    if (!awaitingSafeSteerPointAfterTool) {
      return
    }

    awaitingSafeSteerPointAfterTool = false
    clearSafeSteerTimer()
    deps.onSafeToSteerAfterTool?.()
  }

  const setExecutionPhase = (phase: 'generating' | 'tool-running'): void => {
    if (executionPhase === phase) {
      return
    }

    executionPhase = phase
    deps.onExecutionPhaseChange?.(phase)
  }

  deps.emit<HarnessStartedEvent>({
    type: 'harness.started',
    threadId: input.thread.id,
    runId: input.runId,
    harnessId,
    name: DEFAULT_HARNESS_NAME
  })
  deps.emit<MessageStartedEvent>({
    type: 'message.started',
    threadId: input.thread.id,
    runId: input.runId,
    messageId,
    parentMessageId: input.requestMessageId
  })

  try {
    const workspacePath = await ensureResolvedWorkspacePath(
      input.thread,
      deps.ensureThreadWorkspace
    )
    const runtime = deps.createModelRuntime()
    const availableSkills = await deps.listSkills([workspacePath])
    const activeSkills = resolveActiveSkills({
      availableSkills,
      config: deps.readConfig(),
      ...(input.enabledSkillNames !== undefined
        ? { enabledSkillNames: input.enabledSkillNames }
        : {})
    })
    const soulDocument = deps.readSoulDocument
      ? await deps.readSoulDocument()
      : await readSoulDocument()
    const isExternalChannel = input.thread.source != null && input.thread.source !== 'local'
    const channelUser =
      isExternalChannel && input.thread.channelUserId
        ? deps.storage.getChannelUser(input.thread.channelUserId)
        : undefined
    const isGuest = isExternalChannel && (channelUser?.role ?? 'guest') !== 'owner'
    // Owner DM: an external DM (no channelGroupId) where the user is the owner.
    // These get the full local agent toolset — no sandboxing, no stripped instructions.
    const isOwnerDm = isExternalChannel && !isGuest && !input.thread.channelGroupId
    if (isExternalChannel) {
      console.log(
        `[yachiyo] external channel run: user=${channelUser?.username ?? 'unknown'}, role=${channelUser?.role ?? 'guest'}, isGuest=${isGuest}, isOwnerDm=${isOwnerDm}`
      )
    }
    const maxToolSteps = isExternalChannel
      ? isOwnerDm
        ? OWNER_DM_MAX_TOOL_STEPS
        : EXTERNAL_CHANNEL_MAX_TOOL_STEPS
      : DEFAULT_MAX_TOOL_STEPS
    // Owner DMs use the owner's configured full tool set; all other runs use whatever
    // the caller passed in (which for channel services is policy.allowedTools).
    const modelEnabledTools = resolveModelEnabledTools({
      activeSkills,
      enabledTools: isOwnerDm
        ? resolveEnabledTools(undefined, deps.readConfig().enabledTools)
        : input.enabledTools
    })
    const guestUserPath = resolveYachiyoUserPath(workspacePath)
    const userDocument = isGuest
      ? await readUserDocument({ filePath: guestUserPath, guest: true })
      : deps.readUserDocument
        ? await deps.readUserDocument()
        : await readUserDocument()
    const hiddenQueryReminder = formatQueryReminder(
      [
        ...(input.previousEnabledTools
          ? [
              buildToolAvailabilityReminderSection({
                previousEnabledTools: input.previousEnabledTools,
                enabledTools: input.enabledTools
              })
            ]
          : []),
        buildCurrentTimeSection()
      ].flatMap((section) => (section ? [section] : []))
    )
    const requestMessage = deps
      .loadThreadMessages(input.thread.id)
      .find((message) => message.id === input.requestMessageId && message.role === 'user')
    const fileMentionResolution = await resolveFileMentionsForUserQuery({
      content: requestMessage?.content ?? '',
      workspacePath,
      searchService: deps.searchService
    })
    let memoryEntries: string[] = []
    let recallDecision: RecallDecisionSnapshot | undefined
    if (deps.buildMemoryLayerEntries && !isGuest) {
      try {
        const result = await deps.buildMemoryLayerEntries({
          requestMessageId: input.requestMessageId,
          signal: AbortSignal.any([
            input.abortController.signal,
            AbortSignal.timeout(MEMORY_RECALL_TIMEOUT_MS)
          ]),
          thread: input.thread,
          userQuery: requestMessage?.content ?? ''
        })
        memoryEntries = result.entries
        recallDecision = result.recallDecision
      } catch (error) {
        console.warn('[yachiyo][memory] failed to build memory layer; continuing run', {
          error: error instanceof Error ? error.message : String(error),
          runId: input.runId,
          threadId: input.thread.id
        })
      }
    }
    deps.emit<RunMemoryRecalledEvent>({
      type: 'run.memory.recalled',
      threadId: input.thread.id,
      runId: input.runId,
      requestMessageId: input.requestMessageId,
      recalledMemoryEntries: memoryEntries,
      ...(recallDecision ? { recallDecision } : {})
    })
    deps.emit<RunContextCompiledEvent>({
      type: 'run.context.compiled',
      threadId: input.thread.id,
      runId: input.runId,
      contextSources: buildContextSources({
        evolvedTraitCount: (soulDocument?.evolvedTraits ?? []).filter((t) => t.trim()).length,
        hasUserContent: (userDocument?.content ?? '').trim().length > 0,
        enabledTools: modelEnabledTools,
        activeSkills,
        fileMentionCount: fileMentionResolution.mentions.length,
        inlinedFileCount: fileMentionResolution.inlinedPath ? 1 : 0,
        workspacePath,
        hasToolReminder: hiddenQueryReminder !== undefined,
        memoryEntries,
        recallDecision
      })
    })
    const config = deps.readConfig()
    const enabledSubagentProfiles = (config.subagentProfiles ?? []).filter((p) => p.enabled)
    const savedWorkspacePaths = config.workspace?.savedPaths ?? []
    const gitCtx =
      enabledSubagentProfiles.length > 0
        ? await detectGitContext(workspacePath)
        : ({ hasGit: false } as GitContext)
    const subagentContextBlock = buildSubagentContextBlock(
      gitCtx,
      workspacePath,
      enabledSubagentProfiles,
      savedWorkspacePaths
    )

    // Persist per-turn injected context on the request message for lossless replay.
    if (requestMessage && (hiddenQueryReminder || memoryEntries.length > 0)) {
      const turnContext: MessageTurnContext = {
        ...(hiddenQueryReminder ? { reminder: hiddenQueryReminder } : {}),
        ...(memoryEntries.length > 0 ? { memoryEntries } : {})
      }
      deps.storage.updateMessage({ ...requestMessage, turnContext })
    }

    const rawContent = requestMessage?.content ?? ''
    const skillExpandedContent = await expandSkillMention(rawContent, deps.listSkills, [
      workspacePath
    ])
    // File mention augmentation prepends a hidden reference block to the original content.
    // Skill expansion replaces @skills:name with the skill doc in the user content portion.
    // When both are active, swap the original content tail in the augmented query with the
    // skill-expanded version so both augmentations compose correctly.
    const hasSkillExpansion = skillExpandedContent !== rawContent
    const modelUserQuery = hasSkillExpansion
      ? fileMentionResolution.augmentedUserQuery.slice(
          0,
          fileMentionResolution.augmentedUserQuery.length - rawContent.length
        ) + skillExpandedContent
      : fileMentionResolution.augmentedUserQuery
    const history = loadRunHistory(
      deps.loadThreadMessages,
      input.thread.id,
      input.requestMessageId,
      modelUserQuery,
      input.thread.summaryWatermarkMessageId
    )

    const messages =
      isExternalChannel && !isOwnerDm
        ? compileExternalContextLayers({
            personality: { basePersona: EXTERNAL_SYSTEM_PROMPT },
            soul: { content: soulDocument?.rawContent ?? '' },
            user: { content: userDocument?.content ?? '' },
            executionContract: buildExternalAgentInstructions({
              enabledTools: modelEnabledTools,
              guest: isGuest,
              guestInstruction: isGuest ? readChannelsConfig().guestInstruction : undefined,
              maxToolSteps
            }),
            channelInstruction: input.channelHint ?? '',
            rollingSummary: input.thread.rollingSummary,
            history,
            hint: { reminder: hiddenQueryReminder || undefined },
            memory: { entries: memoryEntries }
          })
        : prepareModelMessages({
            personality: { basePersona: SYSTEM_PROMPT },
            soul: { content: soulDocument?.rawContent ?? '' },
            user: { content: userDocument?.content ?? '' },
            skills: { activeSkills },
            agent: {
              instructions: [
                buildAgentInstructions({
                  workspacePath,
                  enabledTools: modelEnabledTools,
                  activeSkills,
                  hasHiddenMemorySearch:
                    !input.thread.privacyMode && deps.memoryService.hasHiddenSearchCapability(),
                  soulDocumentPath: soulDocument?.filePath,
                  userDocumentPath: userDocument?.filePath,
                  subagentContextBlock: subagentContextBlock || undefined,
                  isUserSpecifiedWorkspace: !!input.thread.workspacePath?.trim(),
                  maxToolSteps
                }),
                // For owner DMs the channel transport contract (reply tags, plain-text,
                // length limits) must stay in the system prefix so it applies every turn.
                ...(isOwnerDm && input.channelHint?.trim() ? [input.channelHint.trim()] : [])
              ].join('\n\n')
            },
            hint: {
              reminder: hiddenQueryReminder || undefined
            },
            memory: { entries: memoryEntries },
            // For threads with a rolling summary (owner DMs or auto-compacted local threads),
            // prepend the summary as a synthetic user message so local context compilation,
            // which has no dedicated rollingSummary field, still sees the earlier context.
            history: input.thread.rollingSummary?.trim()
              ? [
                  {
                    role: 'user' as const,
                    content: `<conversation_summary>\n${input.thread.rollingSummary.trim()}\n</conversation_summary>`
                  },
                  ...history
                ]
              : history
          })
    const tools = createAgentToolSet(
      {
        enabledTools: modelEnabledTools,
        workspacePath,
        sandboxed: isExternalChannel && !isOwnerDm
      },
      {
        availableSkills,
        fetchImpl: deps.fetchImpl,
        loadBrowserSnapshot: deps.loadBrowserSnapshot,
        searchService: deps.searchService,
        memoryService: input.thread.privacyMode
          ? undefined
          : isGuest
            ? createFilteredMemoryService(
                deps.memoryService,
                readChannelsConfig().memoryFilterKeywords ?? []
              )
            : deps.memoryService,
        webSearchService: deps.webSearchService,
        ...(isExternalChannel
          ? {
              updateMemoryDeps: {
                memoryService: deps.memoryService,
                userDocumentPath: resolveYachiyoUserPath(workspacePath)
              }
            }
          : {}),
        ...((gitCtx.hasGit || savedWorkspacePaths.length > 0) && enabledSubagentProfiles.length > 0
          ? {
              subagentProfiles: enabledSubagentProfiles,
              availableWorkspaces: savedWorkspacePaths,
              onSubagentProgress: deps.onSubagentProgress,
              onSubagentStarted: (agentName: string) => {
                cancelPendingSafeSteerPointAfterTool()
                setExecutionPhase('tool-running')
                subagentToolCallId = deps.createId()
                subagentStartedAt = deps.timestamp()
                const toolCall: ToolCallRecord = {
                  id: subagentToolCallId,
                  runId: input.runId,
                  threadId: input.thread.id,
                  requestMessageId: input.requestMessageId,
                  toolName: 'delegateCodingTask',
                  status: 'running',
                  inputSummary: agentName,
                  startedAt: subagentStartedAt
                }
                toolCalls.set(toolCall.id, toolCall)
                deps.storage.createToolCall(toolCall)
                deps.emit<ToolCallUpdatedEvent>({
                  type: 'tool.updated',
                  threadId: input.thread.id,
                  runId: input.runId,
                  toolCall
                })
                deps.emit<SubagentStartedEvent>({
                  type: 'subagent.started',
                  threadId: input.thread.id,
                  runId: input.runId,
                  agentName
                })
              },
              onSubagentFinished: (
                agentName: string,
                status: 'success' | 'cancelled',
                lastMessage?: string
              ) => {
                if (subagentToolCallId) {
                  const startedToolCall = toolCalls.get(subagentToolCallId)
                  const finishedAt = deps.timestamp()
                  const outputSummary = lastMessage
                    ? lastMessage.slice(0, 120) + (lastMessage.length > 120 ? '…' : '')
                    : status === 'cancelled'
                      ? 'cancelled'
                      : 'done'
                  const toolCall: ToolCallRecord = {
                    ...(startedToolCall ?? {
                      id: subagentToolCallId,
                      runId: input.runId,
                      threadId: input.thread.id,
                      requestMessageId: input.requestMessageId,
                      toolName: 'delegateCodingTask',
                      inputSummary: agentName,
                      startedAt: subagentStartedAt ?? finishedAt
                    }),
                    status: status === 'cancelled' ? 'failed' : 'completed',
                    outputSummary,
                    finishedAt
                  }
                  toolCalls.set(toolCall.id, toolCall)
                  deps.storage.updateToolCall(toolCall)
                  deps.emit<ToolCallUpdatedEvent>({
                    type: 'tool.updated',
                    threadId: input.thread.id,
                    runId: input.runId,
                    toolCall
                  })
                }
                deps.emit<SubagentFinishedEvent>({
                  type: 'subagent.finished',
                  threadId: input.thread.id,
                  runId: input.runId,
                  agentName,
                  status
                })
                awaitingSafeSteerPointAfterTool = true
                setExecutionPhase('generating')
                if (!safeSteerTimer) {
                  safeSteerTimer = setTimeout(() => {
                    safeSteerTimer = null
                    flushSafeSteerPointAfterTool()
                  }, 0)
                }
              }
            }
          : {}),
        ...(input.extraTools ? { extraTools: input.extraTools } : {})
      }
    )
    console.log(
      `[yachiyo][run] toolSet: ${tools ? Object.keys(tools).join(', ') : 'none'}, extraTools: ${input.extraTools ? Object.keys(input.extraTools).join(', ') : 'none'}`
    )
    deps.onEnabledToolsUsed(input.enabledTools)

    let lastUsage: ModelUsage | undefined

    for await (const delta of runtime.streamReply({
      messages,
      settings,
      signal: input.abortController.signal,
      maxToolSteps,
      ...(tools ? { tools } : {}),
      onFinish: (usage) => {
        lastUsage = usage
      },
      onReasoningDelta: (reasoningDelta) => {
        reasoningBuffer += reasoningDelta
        deps.emit<MessageReasoningDeltaEvent>({
          type: 'message.reasoning.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta: reasoningDelta
        })
      },
      onToolCallStart: (event) => {
        if (!isCoreToolName(event.toolCall.toolName)) {
          return
        }

        cancelPendingSafeSteerPointAfterTool()
        runningToolCallIds.add(event.toolCall.toolCallId)
        shouldStartNewTextBlock = true
        setExecutionPhase('tool-running')
        stepCount++

        const toolCall: ToolCallRecord = {
          id: event.toolCall.toolCallId,
          runId: input.runId,
          threadId: input.thread.id,
          requestMessageId: input.requestMessageId,
          toolName: event.toolCall.toolName as ToolCallName,
          status: 'running',
          inputSummary: summarizeToolInput(
            event.toolCall.toolName as ToolCallName,
            event.toolCall.input
          ),
          startedAt: deps.timestamp(),
          stepIndex: stepCount,
          stepBudget: maxToolSteps
        }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.createToolCall(toolCall)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallUpdate: (event) => {
        if (!isCoreToolName(event.toolCall.toolName)) {
          return
        }

        const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
        if (!startedToolCall) {
          return
        }

        if (startedToolCall.status !== 'running') {
          return
        }

        const toolName = event.toolCall.toolName as ToolCallName
        const normalized = normalizeToolResult(toolName, event.output, { phase: 'update' })
        const toolCall: ToolCallRecord = {
          ...startedToolCall,
          status: 'running',
          ...(normalized.outputSummary ? { outputSummary: normalized.outputSummary } : {}),
          ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
          ...(normalized.details ? { details: normalized.details } : {})
        }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.updateToolCall(toolCall)
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallFinish: (event) => {
        try {
          if (!isCoreToolName(event.toolCall.toolName)) {
            return
          }

          const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
          const toolName = event.toolCall.toolName as ToolCallName
          const finishedAt = deps.timestamp()
          const normalized = event.success ? normalizeToolResult(toolName, event.output) : undefined
          const errorMessage =
            normalized?.error ??
            (event.success || event.error === undefined
              ? undefined
              : event.error instanceof Error
                ? event.error.message
                : String(event.error))
          const toolCall: ToolCallRecord = startedToolCall
            ? {
                ...startedToolCall,
                status: normalized?.status ?? 'failed',
                outputSummary: normalized?.outputSummary ?? errorMessage,
                ...(normalized?.cwd ? { cwd: normalized.cwd } : {}),
                ...(normalized?.details ? { details: normalized.details } : {}),
                ...(errorMessage ? { error: errorMessage } : {}),
                finishedAt
              }
            : {
                id: event.toolCall.toolCallId,
                runId: input.runId,
                threadId: input.thread.id,
                requestMessageId: input.requestMessageId,
                toolName,
                status: normalized?.status ?? 'failed',
                inputSummary: summarizeToolInput(toolName, event.toolCall.input),
                outputSummary: normalized?.outputSummary ?? errorMessage,
                ...(normalized?.cwd ? { cwd: normalized.cwd } : {}),
                ...(normalized?.details ? { details: normalized.details } : {}),
                ...(errorMessage ? { error: errorMessage } : {}),
                startedAt: finishedAt,
                finishedAt
              }

          toolCalls.set(toolCall.id, toolCall)
          if (startedToolCall) {
            deps.storage.updateToolCall(toolCall)
          } else {
            deps.storage.createToolCall(toolCall)
          }
          deps.emit<ToolCallUpdatedEvent>({
            type: 'tool.updated',
            threadId: input.thread.id,
            runId: input.runId,
            toolCall
          })

          runningToolCallIds.delete(event.toolCall.toolCallId)
          if (runningToolCallIds.size === 0) {
            awaitingSafeSteerPointAfterTool = true
            setExecutionPhase('generating')
            if (!safeSteerTimer) {
              safeSteerTimer = setTimeout(() => {
                safeSteerTimer = null
                flushSafeSteerPointAfterTool()
              }, 0)
            }
          }
        } catch (error) {
          console.error('[yachiyo][tool-finish] failed to persist terminal tool state', {
            error: error instanceof Error ? error.message : String(error),
            runId: input.runId,
            success: event.success,
            threadId: input.thread.id,
            toolCallId: event.toolCall.toolCallId,
            toolName: event.toolCall.toolName
          })
          throw error
        }
      }
    })) {
      flushSafeSteerPointAfterTool()

      throwIfAborted(input.abortController.signal)

      if (!delta) continue
      buffer += delta
      const nextTextBlockState = appendMessageDeltaToTextBlocks({
        textBlocks,
        delta,
        timestamp: deps.timestamp(),
        createId: deps.createId,
        shouldStartNewBlock: shouldStartNewTextBlock
      })
      textBlocks = nextTextBlockState.textBlocks
      shouldStartNewTextBlock = nextTextBlockState.shouldStartNewBlock
      deps.emit<MessageDeltaEvent>({
        type: 'message.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta
      })
    }

    flushSafeSteerPointAfterTool()

    console.log(
      `[yachiyo][run] stream finished: runId=${input.runId}, finishReason=${lastUsage?.finishReason ?? 'unknown'}, ` +
        `steps=${stepCount}, bufferLen=${buffer.length}, rawOutput=${JSON.stringify(buffer.slice(0, 300))}`
    )

    throwIfAborted(input.abortController.signal)

    const timestamp = deps.timestamp()
    const assistantMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: buffer,
      ...(textBlocks.length > 0 ? { textBlocks } : {}),
      ...(reasoningBuffer ? { reasoning: reasoningBuffer } : {}),
      ...(lastUsage?.responseMessages ? { responseMessages: lastUsage.responseMessages } : {}),
      status: 'completed',
      createdAt: timestamp,
      modelId: settings.model,
      providerName: settings.providerName
    }
    const currentThread = deps.readThread(input.thread.id)

    const updatedThread: ThreadRecord = {
      ...currentThread,
      updatedAt: timestamp,
      ...(input.updateHeadOnComplete
        ? { preview: assistantMessage.content.slice(0, 240) }
        : currentThread.preview
          ? { preview: currentThread.preview }
          : {}),
      ...(input.updateHeadOnComplete
        ? { headMessageId: assistantMessage.id }
        : currentThread.headMessageId
          ? { headMessageId: currentThread.headMessageId }
          : {})
    }

    deps.storage.completeRun({ runId: input.runId, updatedThread, assistantMessage, ...lastUsage })
    deps.onTerminalState?.()

    deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.thread.id,
      runId: input.runId,
      message: assistantMessage
    })
    bindCompletedToolCallsToAssistant(deps, toolCalls, {
      threadId: input.thread.id,
      runId: input.runId,
      assistantMessageId: assistantMessage.id
    })
    deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.thread.id,
      thread: updatedThread
    })
    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'completed'
    })
    deps.emit<RunCompletedEvent>({
      type: 'run.completed',
      threadId: input.thread.id,
      runId: input.runId,
      ...lastUsage
    })
    return { kind: 'completed', totalPromptTokens: lastUsage?.totalPromptTokens }
  } catch (error) {
    clearSafeSteerTimer()

    if (input.abortController.signal.aborted || isAbortError(error)) {
      const restartReason = input.abortController.signal.reason
      const timestamp = deps.timestamp()

      if (isRestartRunReason(restartReason)) {
        if (
          input.requestMessageId &&
          (buffer.length > 0 || reasoningBuffer.length > 0 || toolCalls.size > 0)
        ) {
          const currentThread = deps.readThread(input.thread.id)
          const partialAssistantMessage: MessageRecord = {
            id: messageId,
            threadId: input.thread.id,
            parentMessageId: input.requestMessageId,
            role: 'assistant',
            content: buffer,
            ...(textBlocks.length > 0 ? { textBlocks } : {}),
            ...(reasoningBuffer ? { reasoning: reasoningBuffer } : {}),
            ...(toolCalls.size > 0
              ? {
                  responseMessages: buildInterruptedResponseMessages({
                    buffer,
                    reasoningBuffer,
                    toolCalls
                  })
                }
              : {}),
            status: 'stopped',
            createdAt: timestamp,
            modelId: settings.model,
            providerName: settings.providerName
          }
          deps.storage.saveThreadMessage({
            thread: currentThread,
            updatedThread: currentThread,
            message: partialAssistantMessage
          })
          deps.emit<MessageCompletedEvent>({
            type: 'message.completed',
            threadId: input.thread.id,
            runId: input.runId,
            message: partialAssistantMessage
          })
          bindCompletedToolCallsToAssistant(deps, toolCalls, {
            threadId: input.thread.id,
            runId: input.runId,
            assistantMessageId: messageId
          })

          const steerMessageId = restartReason.nextRequestMessageId
          const steerMessage = deps
            .loadThreadMessages(input.thread.id)
            .find((message) => message.id === steerMessageId && message.role === 'user')
          if (steerMessage && steerMessage.parentMessageId !== messageId) {
            const reparentedSteerMessage: MessageRecord = {
              ...steerMessage,
              parentMessageId: messageId
            }
            deps.storage.updateMessage(reparentedSteerMessage)
            deps.emit<MessageCompletedEvent>({
              type: 'message.completed',
              threadId: input.thread.id,
              runId: input.runId,
              message: reparentedSteerMessage
            })
          }
        }

        deps.emit<HarnessFinishedEvent>({
          type: 'harness.finished',
          threadId: input.thread.id,
          runId: input.runId,
          harnessId,
          name: DEFAULT_HARNESS_NAME,
          status: 'cancelled'
        })
        return {
          kind: 'restarted',
          nextRequestMessageId: restartReason.nextRequestMessageId
        }
      }

      finishPendingToolCalls(deps, toolCalls, {
        error: 'Run cancelled before the tool call finished.',
        finishedAt: timestamp,
        runId: input.runId,
        threadId: input.thread.id
      })

      if (input.requestMessageId) {
        const currentThread = deps.readThread(input.thread.id)
        const stoppedMessage: MessageRecord = {
          id: messageId,
          threadId: input.thread.id,
          parentMessageId: input.requestMessageId,
          role: 'assistant',
          content: buffer,
          ...(textBlocks.length > 0 ? { textBlocks } : {}),
          status: 'stopped',
          createdAt: timestamp,
          modelId: settings.model,
          providerName: settings.providerName
        }
        const updatedThread: ThreadRecord = {
          ...currentThread,
          updatedAt: timestamp,
          ...(buffer ? { preview: buffer.slice(0, 240) } : {})
        }
        deps.storage.saveThreadMessage({
          thread: currentThread,
          updatedThread,
          message: stoppedMessage
        })
        deps.emit<MessageCompletedEvent>({
          type: 'message.completed',
          threadId: input.thread.id,
          runId: input.runId,
          message: stoppedMessage
        })
        deps.emit<ThreadUpdatedEvent>({
          type: 'thread.updated',
          threadId: input.thread.id,
          thread: updatedThread
        })

        // Bind all tool calls from this run to the stopped assistant message.
        // Unlike the normal completion path where completeRun sets
        // assistantMessageId in storage first, here we must do it explicitly.
        for (const [toolCallId, toolCall] of toolCalls.entries()) {
          if (toolCall.runId === input.runId && toolCall.assistantMessageId !== messageId) {
            const bound: ToolCallRecord = { ...toolCall, assistantMessageId: messageId }
            toolCalls.set(toolCallId, bound)
            deps.storage.updateToolCall(bound)
            deps.emit<ToolCallUpdatedEvent>({
              type: 'tool.updated',
              threadId: input.thread.id,
              runId: input.runId,
              toolCall: bound
            })
          }
        }
      }

      deps.storage.cancelRun({
        runId: input.runId,
        completedAt: timestamp
      })
      deps.onTerminalState?.()

      deps.emit<HarnessFinishedEvent>({
        type: 'harness.finished',
        threadId: input.thread.id,
        runId: input.runId,
        harnessId,
        name: DEFAULT_HARNESS_NAME,
        status: 'cancelled'
      })
      deps.emit<RunCancelledEvent>({
        type: 'run.cancelled',
        threadId: input.thread.id,
        runId: input.runId
      })
      return { kind: 'cancelled' }
    }

    const message = error instanceof Error ? error.message : 'Unknown model runtime error'
    const timestamp = deps.timestamp()
    finishPendingToolCalls(deps, toolCalls, {
      error: message,
      finishedAt: timestamp,
      runId: input.runId,
      threadId: input.thread.id
    })

    if (input.requestMessageId) {
      persistTerminalAssistantMessage(deps, {
        runId: input.runId,
        threadId: input.thread.id,
        messageId,
        requestMessageId: input.requestMessageId,
        timestamp,
        settings,
        status: 'failed',
        content: buffer,
        textBlocks
      })
      bindCompletedToolCallsToAssistant(deps, toolCalls, {
        threadId: input.thread.id,
        runId: input.runId,
        assistantMessageId: messageId
      })
    }

    deps.storage.failRun({
      runId: input.runId,
      completedAt: timestamp,
      error: message
    })
    deps.onTerminalState?.()

    deps.emit<HarnessFinishedEvent>({
      type: 'harness.finished',
      threadId: input.thread.id,
      runId: input.runId,
      harnessId,
      name: DEFAULT_HARNESS_NAME,
      status: 'failed',
      error: message
    })
    deps.emit<RunFailedEvent>({
      type: 'run.failed',
      threadId: input.thread.id,
      runId: input.runId,
      error: message
    })
    return { kind: 'failed' }
  }
}
