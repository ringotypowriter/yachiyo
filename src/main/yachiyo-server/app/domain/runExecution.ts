import { execFile } from 'node:child_process'
import { access, constants, readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
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
  NotificationRequestEvent,
  ProviderSettings,
  RunCancelledEvent,
  RunCompletedEvent,
  RunContextCompiledEvent,
  RunContextSourceSummary,
  RunFailedEvent,
  RunMemoryRecalledEvent,
  RunRetryingEvent,
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
import {
  isTrackedToolName,
  normalizeOptionalMaxChatToken
} from '../../../../shared/yachiyo/protocol.ts'
import {
  collectMessagePath,
  wouldCreateParentCycle
} from '../../../../shared/yachiyo/threadTree.ts'
import { applyStripCompact } from '../../runtime/contextStripCompact.ts'
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
  buildDisabledToolsReminderSection,
  formatDateLine,
  formatQueryReminder
} from '../../runtime/queryReminder.ts'
import {
  buildHiddenReferenceBlock,
  resolveFileMentionsForUserQuery
} from '../../runtime/fileMentions.ts'
import { readSoulDocument, type SoulDocument } from '../../runtime/soul.ts'
import { readUserDocument, type UserDocument } from '../../runtime/user.ts'
import { resolveYachiyoUserPath } from '../../config/paths.ts'
import { homedir } from 'node:os'
import { readChannelsConfig } from '../../runtime/channelsConfig.ts'
import type { ModelRuntime, ModelUsage } from '../../runtime/types.ts'
import { RETRY_MAX_ATTEMPTS } from '../../runtime/modelRuntime.ts'
import { isRetryableModelError } from '../../runtime/retryableModelError.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'
import type { JotdownStore } from '../../services/jotdownStore.ts'
import type { RunRecoveryCheckpoint, YachiyoStorage } from '../../storage/storage.ts'
import {
  createAgentToolSet,
  normalizeToolResult,
  summarizeToolInput
} from '../../tools/agentTools.ts'
import { createFilteredMemoryService } from '../../services/memory/memoryService.ts'
import {
  DEFAULT_HARNESS_NAME,
  isAbortError,
  type CreateId,
  type EmitServerEvent,
  type Timestamp
} from './shared.ts'
import { resolveEnabledTools } from './configDomain.ts'
import {
  appendRecoveryReasoningDelta,
  appendRecoveryTextDelta,
  appendRecoveryToolCall,
  appendRecoveryToolResult,
  buildRecoveryHistory,
  buildRecoveryResponseMessages,
  clearRecoveryReasoningParts,
  cloneRecoveryResponseMessages,
  type RecoveryResponseMessage
} from './runRecovery.ts'

export interface ExecuteRunInput {
  enabledTools: ToolCallName[]
  enabledSkillNames?: string[]
  channelHint?: string
  extraTools?: import('ai').ToolSet
  recoveryCheckpoint?: RunRecoveryCheckpoint
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
  | { kind: 'completed'; totalPromptTokens?: number; usedRememberTool?: boolean }
  | { kind: 'failed' }
  | { kind: 'cancelled' }
  | { kind: 'restarted'; nextRequestMessageId: string }
  | { kind: 'recovering'; checkpoint: RunRecoveryCheckpoint; harnessId: string }

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
  onExecutionPhaseChange?: (phase: 'generating' | 'tool-running' | 'waiting-for-user') => void
  onSafeToSteerAfterTool?: () => void
  /** Called by execution to register the askUser answer handler. */
  onAskUserHandlerReady?: (handler: (toolCallId: string, answer: string) => void) => void
  onTerminalState?: () => void
  onSubagentProgress?: (chunk: string) => void
  onSubagentStarted?: (agentName: string) => void
  jotdownStore?: JotdownStore
  onSubagentFinished?: (
    agentName: string,
    status: 'success' | 'cancelled',
    lastMessage?: string,
    sessionId?: string,
    workspacePath?: string
  ) => void
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

function extractRetryErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.message) return error.message
  const statusCode = (error as { statusCode?: number }).statusCode
  return statusCode ? `HTTP ${statusCode}` : 'Provider error'
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
    availableWorkspaces.length > 0 && gitCtx.hasGit
      ? `CRITICAL RULE 1: By default agents operate in the current thread workspace: ${workspacePath}. You may also specify one of the available workspaces below using the \`workspace\` parameter. Agents MUST ONLY operate in the thread workspace or one of the listed workspaces — never an arbitrary path.`
      : availableWorkspaces.length > 0
        ? `CRITICAL RULE 1: The current thread workspace is NOT a Git repository. You MUST use the \`workspace\` parameter to select one of the available workspaces below. Agents MUST ONLY operate in the listed workspaces — never an arbitrary path.`
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
  hasUpdateProfile?: boolean
  hasRemember?: boolean
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

  if (
    input.enabledTools.length === 0 &&
    !input.hasHiddenMemorySearch &&
    !input.hasUpdateProfile &&
    !input.hasRemember
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
  try {
    if (!thread.workspacePath?.trim()) {
      return await ensureThreadWorkspace(thread.id)
    }

    const workspacePath = resolve(thread.workspacePath)
    await mkdir(workspacePath, { recursive: true })
    return workspacePath
  } catch (cause) {
    const error = new Error('Workspace initialization failed', { cause })
    ;(error as unknown as { isRetryable: boolean }).isRetryable = false
    throw error
  }
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

function upsertRunRecoveryCheckpoint(
  deps: Pick<RunExecutionDeps, 'storage'>,
  checkpoint: RunRecoveryCheckpoint
): void {
  deps.storage.upsertRunRecoveryCheckpoint(checkpoint)
}

function restorePersistedRunToolCalls(
  loadThreadToolCalls: RunExecutionDeps['loadThreadToolCalls'],
  threadId: string,
  runId: string
): Map<string, ToolCallRecord> {
  return new Map(
    loadThreadToolCalls(threadId)
      .filter((toolCall) => toolCall.runId === runId)
      .map((toolCall) => [toolCall.id, toolCall] as const)
  )
}

function consumeDuplicatePrefix(input: { prefix: string; pending: string; delta: string }): {
  prefix: string
  pending: string
  delta: string
} {
  if (!input.prefix || !input.delta) {
    return input
  }

  const candidate = input.pending + input.delta
  if (!candidate) {
    return input
  }

  if (candidate.length <= input.prefix.length && input.prefix.startsWith(candidate)) {
    return {
      prefix: candidate === input.prefix ? '' : input.prefix,
      pending: candidate === input.prefix ? '' : candidate,
      delta: ''
    }
  }

  if (candidate.startsWith(input.prefix)) {
    return {
      prefix: '',
      pending: '',
      delta: candidate.slice(input.prefix.length)
    }
  }

  return {
    prefix: '',
    pending: '',
    delta: candidate
  }
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
  const maxChatToken = normalizeOptionalMaxChatToken(deps.readConfig().chat?.maxChatToken)
  const harnessId = deps.createId()
  const recoveryCheckpoint = input.recoveryCheckpoint
  const messageId = recoveryCheckpoint?.assistantMessageId ?? deps.createId()
  const toolCalls = recoveryCheckpoint
    ? restorePersistedRunToolCalls(deps.loadThreadToolCalls, input.thread.id, input.runId)
    : new Map<string, ToolCallRecord>()
  const runningToolCallIds = new Set<string>()
  let stepCount = Math.max(0, ...[...toolCalls.values()].map((toolCall) => toolCall.stepIndex ?? 0))
  let subagentToolCallId: string | undefined
  let subagentStartedAt: string | undefined
  let buffer = recoveryCheckpoint?.content ?? ''
  let reasoningBuffer = recoveryCheckpoint?.reasoning ?? ''
  let textBlocks: MessageTextBlockRecord[] = recoveryCheckpoint?.textBlocks
    ? [...recoveryCheckpoint.textBlocks]
    : []
  let shouldStartNewTextBlock = textBlocks.length === 0
  let executionPhase: 'generating' | 'tool-running' | 'waiting-for-user' = 'generating'
  let awaitingSafeSteerPointAfterTool = false

  // Deferred promises for askUser tool calls waiting on user input
  const pendingUserAnswers = new Map<
    string,
    { resolve: (answer: string) => void; reject: (err: Error) => void }
  >()

  // Register the answer handler so the caller (RunDomain) can forward user answers.
  deps.onAskUserHandlerReady?.((toolCallId: string, answer: string): void => {
    const pending = pendingUserAnswers.get(toolCallId)
    if (pending) {
      pendingUserAnswers.delete(toolCallId)
      pending.resolve(answer)
    }
  })

  // When the run is aborted, immediately reject pending askUser promises so the
  // tool execution unblocks and the stream can exit. Without this the stream is
  // deadlocked: abort fires but the tool's deferred promise never settles.
  const rejectPendingUserAnswers = (): void => {
    for (const [id, pending] of pendingUserAnswers) {
      pending.reject(new Error('Run cancelled'))
      pendingUserAnswers.delete(id)
    }
  }
  input.abortController.signal.addEventListener('abort', rejectPendingUserAnswers, { once: true })

  let safeSteerTimer: ReturnType<typeof setTimeout> | null = null
  let duplicateTextPrefix = recoveryCheckpoint?.content ?? ''
  let pendingDuplicateText = ''
  const recoveryCreatedAt = recoveryCheckpoint?.createdAt ?? deps.timestamp()
  let recoveryResponseMessages: RecoveryResponseMessage[] =
    (buildRecoveryResponseMessages({
      checkpoint: recoveryCheckpoint ?? { content: buffer },
      toolCalls: [...toolCalls.values()]
    }) as RecoveryResponseMessage[] | undefined) ?? []

  const persistRecoveryCheckpoint = (
    options: {
      lastError?: string
      recoveryAttempts?: number
    } = {}
  ): RunRecoveryCheckpoint | undefined => {
    if (!input.requestMessageId) {
      return undefined
    }

    const checkpoint: RunRecoveryCheckpoint = {
      runId: input.runId,
      threadId: input.thread.id,
      requestMessageId: input.requestMessageId,
      assistantMessageId: messageId,
      content: buffer,
      ...(textBlocks.length > 0 ? { textBlocks } : {}),
      ...(reasoningBuffer ? { reasoning: reasoningBuffer } : {}),
      ...(recoveryResponseMessages.length > 0
        ? { responseMessages: recoveryResponseMessages }
        : {}),
      enabledTools: [...input.enabledTools],
      ...(input.enabledSkillNames ? { enabledSkillNames: [...input.enabledSkillNames] } : {}),
      ...(input.channelHint ? { channelHint: input.channelHint } : {}),
      updateHeadOnComplete: input.updateHeadOnComplete,
      createdAt: recoveryCreatedAt,
      updatedAt: deps.timestamp(),
      recoveryAttempts: options.recoveryAttempts ?? recoveryCheckpoint?.recoveryAttempts ?? 0,
      ...(options.lastError ? { lastError: options.lastError } : {})
    }
    upsertRunRecoveryCheckpoint(deps, checkpoint)
    return checkpoint
  }

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

  const setExecutionPhase = (phase: 'generating' | 'tool-running' | 'waiting-for-user'): void => {
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
  if (!recoveryCheckpoint) {
    deps.emit<MessageStartedEvent>({
      type: 'message.started',
      threadId: input.thread.id,
      runId: input.runId,
      messageId,
      parentMessageId: input.requestMessageId
    })
  }
  persistRecoveryCheckpoint()

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
    const isLocalOrOwnerDm = !isExternalChannel || isOwnerDm
    const now = new Date()
    const hiddenQueryReminder = formatQueryReminder(
      [
        buildDisabledToolsReminderSection({ enabledTools: modelEnabledTools }),
        buildCurrentTimeSection(now, { includeDate: !isLocalOrOwnerDm })
      ].flatMap((section) => (section ? [section] : []))
    )
    const sessionHint = input.thread.lastDelegatedSession
      ? `Hint: The most recent delegated coding task (Agent: ${input.thread.lastDelegatedSession.agentName}) used session_id ${input.thread.lastDelegatedSession.sessionId} in workspace ${input.thread.lastDelegatedSession.workspacePath}. If the user asks to resume or continue that task, you must provide this exact session_id and set workspace to ${input.thread.lastDelegatedSession.workspacePath} in the delegateCodingTask tool.`
      : undefined
    const effectiveReminder =
      [hiddenQueryReminder, sessionHint].filter(Boolean).join('\n\n') || undefined
    const requestMessage = deps
      .loadThreadMessages(input.thread.id)
      .find((message) => message.id === input.requestMessageId && message.role === 'user')
    const fileMentionResolution = await resolveFileMentionsForUserQuery({
      content: requestMessage?.content ?? '',
      workspacePath,
      searchService: deps.searchService
    })

    // Resolve @JotDown mentions to the latest jot down content
    let hasInlinedJotdown = false
    const jotdownMentions = fileMentionResolution.mentions.filter(
      (m) => m.query.toLowerCase() === 'jotdown'
    )
    if (jotdownMentions.length > 0 && deps.jotdownStore) {
      const latest = await deps.jotdownStore.getLatest()
      if (latest) {
        hasInlinedJotdown = true
        for (const mention of jotdownMentions) {
          mention.kind = 'resolved'
          mention.resolvedPath = 'JotDown'
          mention.resolvedKind = 'file'
          mention.candidatePaths = ['JotDown']
        }
        // Rebuild the hidden reference block so @JotDown appears resolved
        // instead of contradictory unresolved metadata.
        // Use a ~-relative path for privacy (no absolute host path leak),
        // falling back to the logical name if YACHIYO_HOME is outside home.
        const home = homedir()
        const jotdownPath = deps.jotdownStore.baseDir.startsWith(home)
          ? join('~', relative(home, deps.jotdownStore.baseDir), `${latest.id}.md`)
          : 'JotDown'
        fileMentionResolution.augmentedUserQuery = [
          buildHiddenReferenceBlock({
            mentions: fileMentionResolution.mentions,
            inlinedReference: {
              tagName: 'referenced_jotdown',
              path: jotdownPath,
              content: latest.content.trimEnd()
            }
          }),
          '',
          requestMessage?.content ?? ''
        ].join('\n')
      }
    }

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
        inlinedFileCount: (fileMentionResolution.inlinedPath ? 1 : 0) + (hasInlinedJotdown ? 1 : 0),
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
    // Only advertise saved workspaces that are actually Git repositories
    const gitValidatedWorkspaces =
      enabledSubagentProfiles.length > 0 && savedWorkspacePaths.length > 0
        ? (
            await Promise.all(
              savedWorkspacePaths.map(async (p) => {
                const hasGit = await access(join(resolve(p), '.git'), constants.F_OK)
                  .then(() => true)
                  .catch(() => false)
                return hasGit ? p : null
              })
            )
          ).filter((p): p is string => p !== null)
        : []
    const subagentContextBlock = buildSubagentContextBlock(
      gitCtx,
      workspacePath,
      enabledSubagentProfiles,
      gitValidatedWorkspaces
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
    const augmentedUserQuery = fileMentionResolution.augmentedUserQuery

    const hasSkillExpansion = skillExpandedContent !== rawContent
    const modelUserQuery = hasSkillExpansion
      ? augmentedUserQuery.slice(0, augmentedUserQuery.length - rawContent.length) +
        skillExpandedContent
      : augmentedUserQuery
    const history = loadRunHistory(
      deps.loadThreadMessages,
      input.thread.id,
      input.requestMessageId,
      modelUserQuery,
      input.thread.summaryWatermarkMessageId
    )
    const recoveredToolCalls = recoveryCheckpoint
      ? deps
          .loadThreadToolCalls(input.thread.id)
          .filter((toolCall) => toolCall.runId === input.runId)
      : []
    const recoveryHistory = recoveryCheckpoint
      ? buildRecoveryHistory({
          checkpoint: recoveryCheckpoint,
          toolCalls: recoveredToolCalls
        })
      : []
    const contextHistory = [...history, ...recoveryHistory]

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
            history: contextHistory,
            hint: { reminder: effectiveReminder },
            memory: { entries: memoryEntries }
          })
        : prepareModelMessages({
            personality: {
              basePersona: isLocalOrOwnerDm
                ? `Today is ${formatDateLine(now)}.\n\n${SYSTEM_PROMPT}`
                : SYSTEM_PROMPT
            },
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
                  hasUpdateProfile: true,
                  hasRemember:
                    !input.thread.privacyMode &&
                    (!isExternalChannel || isOwnerDm) &&
                    deps.memoryService.isConfigured(),
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
              reminder: effectiveReminder
            },
            memory: { entries: memoryEntries },
            // For owner DM threads with a rolling summary, prepend the summary as a synthetic
            // user message so local context compilation sees the earlier context.
            history: input.thread.rollingSummary?.trim()
              ? [
                  {
                    role: 'user' as const,
                    content: `<conversation_summary>\n${input.thread.rollingSummary.trim()}\n</conversation_summary>`
                  },
                  ...contextHistory
                ]
              : contextHistory
          })
    const stripCompactEnabled = config.chat?.stripCompact !== false
    const finalMessages = stripCompactEnabled ? applyStripCompact(messages) : messages
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
        updateProfileDeps: {
          userDocumentPath: resolveYachiyoUserPath(workspacePath),
          ...(isExternalChannel
            ? { userDocumentMode: isGuest ? ('guest' as const) : ('owner' as const) }
            : {})
        },
        ...(!input.thread.privacyMode &&
        (!isExternalChannel || isOwnerDm) &&
        deps.memoryService.isConfigured()
          ? { rememberDeps: { memoryService: deps.memoryService } }
          : {}),
        // askUser is only available for direct chat runs — not external channel runs
        ...(!isExternalChannel
          ? {
              askUserContext: {
                waitForUserAnswer: (
                  toolCallId: string,
                  question: string,
                  choices?: string[]
                ): Promise<string> => {
                  return new Promise<string>((resolve, reject) => {
                    pendingUserAnswers.set(toolCallId, { resolve, reject })
                    setExecutionPhase('waiting-for-user')

                    // Update the existing tool call record persisted by onToolCallStart
                    const existingToolCall = toolCalls.get(toolCallId)
                    const waitingToolCall: ToolCallRecord = {
                      ...(existingToolCall ?? {
                        id: toolCallId,
                        runId: input.runId,
                        threadId: input.thread.id,
                        requestMessageId: input.requestMessageId,
                        toolName: 'askUser',
                        startedAt: deps.timestamp(),
                        stepIndex: stepCount,
                        stepBudget: maxToolSteps
                      }),
                      status: 'waiting-for-user',
                      inputSummary: question.slice(0, 160),
                      details: { kind: 'askUser' as const, question, choices }
                    } as ToolCallRecord

                    toolCalls.set(toolCallId, waitingToolCall)
                    if (existingToolCall) {
                      deps.storage.updateToolCall(waitingToolCall)
                    } else {
                      deps.storage.createToolCall(waitingToolCall)
                    }
                    persistRecoveryCheckpoint()

                    deps.emit<ToolCallUpdatedEvent>({
                      type: 'tool.updated',
                      threadId: input.thread.id,
                      runId: input.runId,
                      toolCall: waitingToolCall
                    })
                    deps.emit<NotificationRequestEvent>({
                      type: 'notification.requested',
                      threadId: input.thread.id,
                      runId: input.runId,
                      title: 'Yachiyo needs your input',
                      body: question.slice(0, 100)
                    })
                  })
                }
              }
            }
          : {}),
        ...((gitCtx.hasGit || gitValidatedWorkspaces.length > 0) &&
        enabledSubagentProfiles.length > 0
          ? {
              subagentProfiles: enabledSubagentProfiles,
              availableWorkspaces: gitValidatedWorkspaces,
              onSubagentProgress: deps.onSubagentProgress,
              onSubagentStarted: (agentName: string) => {
                cancelPendingSafeSteerPointAfterTool()
                setExecutionPhase('tool-running')
                subagentToolCallId = deps.createId()
                subagentStartedAt = deps.timestamp()
                stepCount++
                const toolCall: ToolCallRecord = {
                  id: subagentToolCallId,
                  runId: input.runId,
                  threadId: input.thread.id,
                  requestMessageId: input.requestMessageId,
                  toolName: 'delegateCodingTask',
                  status: 'running',
                  inputSummary: agentName,
                  startedAt: subagentStartedAt,
                  stepIndex: stepCount,
                  stepBudget: maxToolSteps
                }
                toolCalls.set(toolCall.id, toolCall)
                deps.storage.createToolCall(toolCall)
                appendRecoveryToolCall(recoveryResponseMessages, {
                  toolCallId: toolCall.id,
                  toolName: toolCall.toolName,
                  toolInput: { summary: agentName }
                })
                persistRecoveryCheckpoint()
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
                lastMessage?: string,
                sessionId?: string,
                subagentWorkspacePath?: string
              ) => {
                if (sessionId && subagentWorkspacePath) {
                  const currentThread = deps.readThread(input.thread.id)
                  const updatedThread: ThreadRecord = {
                    ...currentThread,
                    lastDelegatedSession: {
                      agentName,
                      sessionId,
                      workspacePath: subagentWorkspacePath,
                      timestamp: deps.timestamp()
                    }
                  }
                  deps.storage.updateThread(updatedThread)
                  deps.emit<ThreadUpdatedEvent>({
                    type: 'thread.updated',
                    threadId: input.thread.id,
                    thread: updatedThread
                  })
                }
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
                      startedAt: subagentStartedAt ?? finishedAt,
                      stepIndex: ++stepCount,
                      stepBudget: maxToolSteps
                    }),
                    status: status === 'cancelled' ? 'failed' : 'completed',
                    outputSummary,
                    finishedAt
                  }
                  toolCalls.set(toolCall.id, toolCall)
                  deps.storage.updateToolCall(toolCall)
                  if (!startedToolCall) {
                    appendRecoveryToolCall(recoveryResponseMessages, {
                      toolCallId: toolCall.id,
                      toolName: toolCall.toolName,
                      toolInput: { summary: agentName }
                    })
                  }
                  appendRecoveryToolResult(recoveryResponseMessages, {
                    toolCallId: toolCall.id,
                    toolName: toolCall.toolName,
                    ...(status === 'cancelled'
                      ? { error: outputSummary }
                      : {
                          output: {
                            content: [{ type: 'text', text: outputSummary }]
                          }
                        })
                  })
                  persistRecoveryCheckpoint()
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
      messages: finalMessages,
      settings,
      max_token: maxChatToken,
      signal: input.abortController.signal,
      maxToolSteps,
      ...(tools ? { tools } : {}),
      onFinish: (usage) => {
        lastUsage = usage
      },
      onRetry: (attempt, maxAttempts, delayMs, error) => {
        reasoningBuffer = ''
        const normalizedResponseMessages = buildRecoveryResponseMessages({
          checkpoint: {
            content: buffer,
            ...(recoveryResponseMessages.length > 0
              ? { responseMessages: clearRecoveryReasoningParts(recoveryResponseMessages) }
              : {})
          },
          toolCalls: [...toolCalls.values()]
        }) as RecoveryResponseMessage[] | undefined
        recoveryResponseMessages =
          normalizedResponseMessages ??
          cloneRecoveryResponseMessages(recoveryCheckpoint?.responseMessages) ??
          []
        persistRecoveryCheckpoint()
        deps.emit<RunRetryingEvent>({
          type: 'run.retrying',
          threadId: input.thread.id,
          runId: input.runId,
          attempt,
          maxAttempts,
          delayMs,
          error: extractRetryErrorMessage(error)
        })
      },
      onReasoningDelta: (reasoningDelta) => {
        reasoningBuffer += reasoningDelta
        appendRecoveryReasoningDelta(recoveryResponseMessages, reasoningDelta)
        persistRecoveryCheckpoint()
        deps.emit<MessageReasoningDeltaEvent>({
          type: 'message.reasoning.delta',
          threadId: input.thread.id,
          runId: input.runId,
          messageId,
          delta: reasoningDelta
        })
      },
      onToolCallStart: (event) => {
        if (!isTrackedToolName(event.toolCall.toolName)) {
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
          toolName: event.toolCall.toolName,
          status: 'running',
          inputSummary: summarizeToolInput(event.toolCall.toolName, event.toolCall.input),
          startedAt: deps.timestamp(),
          stepIndex: stepCount,
          stepBudget: maxToolSteps
        }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.createToolCall(toolCall)
        appendRecoveryToolCall(recoveryResponseMessages, {
          toolCallId: toolCall.id,
          toolName: toolCall.toolName,
          toolInput: event.toolCall.input
        })
        persistRecoveryCheckpoint()
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallUpdate: (event) => {
        if (!isTrackedToolName(event.toolCall.toolName)) {
          return
        }

        const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
        if (!startedToolCall) {
          return
        }

        if (startedToolCall.status !== 'running') {
          return
        }

        const normalized = normalizeToolResult(event.toolCall.toolName, event.output, {
          phase: 'update'
        })
        const toolCall: ToolCallRecord = {
          ...startedToolCall,
          status: 'running',
          ...(normalized.outputSummary ? { outputSummary: normalized.outputSummary } : {}),
          ...(normalized.cwd ? { cwd: normalized.cwd } : {}),
          ...(normalized.details ? { details: normalized.details } : {})
        }

        toolCalls.set(toolCall.id, toolCall)
        deps.storage.updateToolCall(toolCall)
        persistRecoveryCheckpoint()
        deps.emit<ToolCallUpdatedEvent>({
          type: 'tool.updated',
          threadId: input.thread.id,
          runId: input.runId,
          toolCall
        })
      },
      onToolCallFinish: (event) => {
        try {
          if (!isTrackedToolName(event.toolCall.toolName)) {
            return
          }

          const startedToolCall = toolCalls.get(event.toolCall.toolCallId)
          const finishedAt = deps.timestamp()
          const normalized = event.success
            ? normalizeToolResult(event.toolCall.toolName, event.output)
            : undefined
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
                toolName: event.toolCall.toolName,
                status: normalized?.status ?? 'failed',
                inputSummary: summarizeToolInput(event.toolCall.toolName, event.toolCall.input),
                outputSummary: normalized?.outputSummary ?? errorMessage,
                ...(normalized?.cwd ? { cwd: normalized.cwd } : {}),
                ...(normalized?.details ? { details: normalized.details } : {}),
                ...(errorMessage ? { error: errorMessage } : {}),
                startedAt: finishedAt,
                stepIndex: ++stepCount,
                stepBudget: maxToolSteps,
                finishedAt
              }

          toolCalls.set(toolCall.id, toolCall)
          if (startedToolCall) {
            deps.storage.updateToolCall(toolCall)
          } else {
            deps.storage.createToolCall(toolCall)
            appendRecoveryToolCall(recoveryResponseMessages, {
              toolCallId: toolCall.id,
              toolName: event.toolCall.toolName,
              toolInput: event.toolCall.input
            })
          }
          appendRecoveryToolResult(recoveryResponseMessages, {
            toolCallId: toolCall.id,
            toolName: event.toolCall.toolName,
            output: event.output,
            error: event.error
          })
          persistRecoveryCheckpoint()
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
      const deduped = consumeDuplicatePrefix({
        prefix: duplicateTextPrefix,
        pending: pendingDuplicateText,
        delta
      })
      duplicateTextPrefix = deduped.prefix
      pendingDuplicateText = deduped.pending
      if (!deduped.delta) {
        continue
      }

      buffer += deduped.delta
      appendRecoveryTextDelta(recoveryResponseMessages, deduped.delta)
      const nextTextBlockState = appendMessageDeltaToTextBlocks({
        textBlocks,
        delta: deduped.delta,
        timestamp: deps.timestamp(),
        createId: deps.createId,
        shouldStartNewBlock: shouldStartNewTextBlock
      })
      textBlocks = nextTextBlockState.textBlocks
      shouldStartNewTextBlock = nextTextBlockState.shouldStartNewBlock
      persistRecoveryCheckpoint()
      deps.emit<MessageDeltaEvent>({
        type: 'message.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta: deduped.delta
      })
    }

    flushSafeSteerPointAfterTool()

    console.log(
      `[yachiyo][run] stream finished: runId=${input.runId}, finishReason=${lastUsage?.finishReason ?? 'unknown'}, ` +
        `steps=${stepCount}, bufferLen=${buffer.length}, rawOutput=${JSON.stringify(buffer.slice(0, 300))}`
    )

    throwIfAborted(input.abortController.signal)

    // Detect degenerate completions: the stream finished without error but
    // produced no user-visible content (e.g. Gemini finishReason=length with
    // 0 output tokens after a network hiccup). Treat as a retryable error so
    // the recovery / fail path can handle it instead of silently "completing".
    if (buffer.length === 0 && toolCalls.size === 0) {
      const reason = lastUsage?.finishReason ?? 'unknown'
      throw new Error(`Model returned empty response (finishReason=${reason})`)
    }

    const timestamp = deps.timestamp()
    const responseMessages = recoveryCheckpoint
      ? recoveryResponseMessages.length > 0
        ? recoveryResponseMessages
        : undefined
      : lastUsage?.responseMessages
    const assistantMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      parentMessageId: input.requestMessageId,
      role: 'assistant',
      content: buffer,
      ...(textBlocks.length > 0 ? { textBlocks } : {}),
      ...(reasoningBuffer ? { reasoning: reasoningBuffer } : {}),
      ...(responseMessages ? { responseMessages } : {}),
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
    const usedRememberTool = Array.from(toolCalls.values()).some(
      (tc) => tc.toolName === 'remember' && tc.status === 'completed' && !tc.error
    )
    return {
      kind: 'completed',
      totalPromptTokens: lastUsage?.totalPromptTokens,
      usedRememberTool
    }
  } catch (error) {
    clearSafeSteerTimer()

    // Reject any pending askUser promises so the tool execution unblocks
    for (const [id, pending] of pendingUserAnswers) {
      pending.reject(new Error('Run cancelled'))
      pendingUserAnswers.delete(id)
    }

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
            ...(recoveryResponseMessages.length > 0
              ? {
                  responseMessages: recoveryResponseMessages
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
          const threadMessages = deps.loadThreadMessages(input.thread.id)
          const steerMessage = threadMessages.find(
            (message) => message.id === steerMessageId && message.role === 'user'
          )
          const wouldCycleSteerParent =
            steerMessage && wouldCreateParentCycle(threadMessages, steerMessage.id, messageId)
          if (wouldCycleSteerParent) {
            console.warn('[yachiyo][thread-tree] skipped cyclic steer reparent', {
              messageId: steerMessageId,
              parentMessageId: messageId,
              threadId: input.thread.id
            })
          }
          const nextSteerParentMessageId =
            steerMessage && !wouldCycleSteerParent ? messageId : undefined
          if (
            steerMessage &&
            nextSteerParentMessageId &&
            steerMessage.parentMessageId !== nextSteerParentMessageId
          ) {
            const reparentedSteerMessage: MessageRecord = {
              ...steerMessage,
              parentMessageId: nextSteerParentMessageId
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

        deps.storage.deleteRunRecoveryCheckpoint(input.runId)
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

    const message = extractRetryErrorMessage(error) || 'Unknown model runtime error'
    const nextRecoveryAttempt = (recoveryCheckpoint?.recoveryAttempts ?? 0) + 1
    if (
      input.requestMessageId &&
      isRetryableModelError(error) &&
      nextRecoveryAttempt < RETRY_MAX_ATTEMPTS
    ) {
      runningToolCallIds.clear()
      setExecutionPhase('generating')
      finishPendingToolCalls(deps, toolCalls, {
        error: 'Tool execution was interrupted before completion.',
        finishedAt: deps.timestamp(),
        runId: input.runId,
        threadId: input.thread.id
      })

      const checkpoint = persistRecoveryCheckpoint({
        lastError: message,
        recoveryAttempts: nextRecoveryAttempt
      })
      if (checkpoint) {
        deps.emit<RunRetryingEvent>({
          type: 'run.retrying',
          threadId: input.thread.id,
          runId: input.runId,
          attempt: checkpoint.recoveryAttempts,
          maxAttempts: RETRY_MAX_ATTEMPTS,
          delayMs: Math.min(1_000 * 2 ** Math.max(0, checkpoint.recoveryAttempts - 1), 30_000),
          error: message
        })
        return {
          kind: 'recovering',
          checkpoint,
          harnessId
        }
      }
    }

    const timestamp = deps.timestamp()
    finishPendingToolCalls(deps, toolCalls, {
      error: message,
      finishedAt: timestamp,
      runId: input.runId,
      threadId: input.thread.id
    })

    if (input.requestMessageId) {
      const failedMessage = persistTerminalAssistantMessage(deps, {
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
      deps.emit<MessageCompletedEvent>({
        type: 'message.completed',
        threadId: input.thread.id,
        runId: input.runId,
        message: failedMessage
      })
      const currentThread = deps.readThread(input.thread.id)
      deps.emit<ThreadUpdatedEvent>({
        type: 'thread.updated',
        threadId: input.thread.id,
        thread: { ...currentThread, updatedAt: timestamp }
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
