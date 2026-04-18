import type { Tool, ToolSet } from 'ai'

import {
  DEFAULT_ENABLED_TOOL_NAMES,
  USER_MANAGED_TOOL_NAMES,
  normalizeEnabledTools,
  type SkillCatalogEntry,
  type SubagentProfile,
  type ToolCallDetailsSnapshot,
  type ToolCallName,
  type ToolCallStatus
} from '../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../services/search/searchService.ts'
import type { WebSearchService } from '../services/webSearch/webSearchService.ts'
import type { MemoryService } from '../services/memory/memoryService.ts'
import type { BrowserWebPageSnapshotLoader } from '../services/webRead/browserWebPageSnapshot.ts'

import { createTool as createBashTool } from './agentTools/bashTool.ts'
import { createTool as createEditTool } from './agentTools/editTool.ts'
import { createTool as createGlobTool } from './agentTools/globTool.ts'
import { createTool as createGrepTool } from './agentTools/grepTool.ts'
import { createTool as createJsReplTool } from './agentTools/jsReplTool.ts'
import {
  createTool as createRememberTool,
  type RememberToolDeps
} from './agentTools/rememberTool.ts'
import {
  createTool as createSearchMemoryTool,
  type CrossThreadSearchFn
} from './agentTools/searchMemoryTool.ts'
import { createTool as createReadTool } from './agentTools/readTool.ts'
import { createTool as createSkillsReadTool } from './agentTools/skillsReadTool.ts'
import {
  takeTail,
  type AgentToolContext,
  type AgentToolOutput,
  type BashToolOutput,
  type EditToolOutput,
  type GlobToolOutput,
  type GrepToolOutput,
  type JsReplToolOutput,
  type ReadToolOutput,
  type SkillsReadToolOutput,
  type WebReadToolOutput,
  type WebSearchToolOutput,
  type WriteToolOutput
} from './agentTools/shared.ts'
import { ReadRecordCache } from './agentTools/readRecordCache.ts'
import { createTool as createWebReadTool } from './agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from './agentTools/webSearchTool.ts'
import { createTool as createWriteTool } from './agentTools/writeTool.ts'
import {
  createTool as createDelegateCodingTaskTool,
  type DelegateCodingTaskContext,
  type DelegateCodingTaskFinishedEvent,
  type DelegateCodingTaskProgressEvent,
  type DelegateCodingTaskStartedEvent
} from './agentTools/delegateCodingTaskTool.ts'
import {
  createTool as createUpdateProfileTool,
  type UpdateProfileDeps
} from './agentTools/updateProfileTool.ts'
import { createAskUserTool, type AskUserToolContext } from './agentTools/askUserTool.ts'

export type {
  AgentToolMetadata,
  AgentToolResult,
  AgentToolOutput,
  AskUserToolOutput,
  BashToolOutput,
  EditToolOutput,
  GlobToolOutput,
  GrepToolOutput,
  JsReplToolOutput,
  ReadToolOutput,
  SkillsReadToolOutput,
  ToolContentBlock,
  WebReadToolOutput,
  WebSearchToolOutput,
  WriteToolOutput
} from './agentTools/shared.ts'
export { ReadRecordCache } from './agentTools/readRecordCache.ts'

export { createAskUserTool, type AskUserToolContext } from './agentTools/askUserTool.ts'

export {
  createTool as createBashTool,
  isBlockedBashCommand,
  runBashTool,
  streamBashTool
} from './agentTools/bashTool.ts'
export { createTool as createEditTool, runEditTool } from './agentTools/editTool.ts'
export { createTool as createJsReplTool } from './agentTools/jsReplTool.ts'
export { createTool as createGlobTool, runGlobTool } from './agentTools/globTool.ts'
export { createTool as createGrepTool, runGrepTool } from './agentTools/grepTool.ts'
export { createTool as createReadTool, runReadTool } from './agentTools/readTool.ts'
export {
  createTool as createSkillsReadTool,
  runSkillsReadTool
} from './agentTools/skillsReadTool.ts'
export { createTool as createWebReadTool, runWebReadTool } from './agentTools/webReadTool.ts'
export { createTool as createWebSearchTool, runWebSearchTool } from './agentTools/webSearchTool.ts'
export { createTool as createWriteTool, runWriteTool } from './agentTools/writeTool.ts'
export type {
  DelegateCodingTaskFinishedEvent,
  DelegateCodingTaskProgressEvent,
  DelegateCodingTaskStartedEvent
} from './agentTools/delegateCodingTaskTool.ts'

export interface AgentToolDependencies {
  availableSkills?: SkillCatalogEntry[]
  fetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  memoryService?: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
  updateProfileDeps?: UpdateProfileDeps
  /** When provided, the remember tool is injected (local + owner DM contexts only). */
  rememberDeps?: RememberToolDeps
  /** When provided, searchMemory gains a "cross-thread" domain for FTS5/BM25 thread search. */
  crossThreadSearch?: CrossThreadSearchFn
  subagentProfiles?: SubagentProfile[]
  /** Workspace paths the coding agent is allowed to operate in (from config savedPaths). */
  availableWorkspaces?: string[]
  onSubagentProgress?: (event: DelegateCodingTaskProgressEvent) => void
  onSubagentStarted?: (event: DelegateCodingTaskStartedEvent) => void
  onSubagentFinished?: (event: DelegateCodingTaskFinishedEvent) => void
  /** When provided, the askUser tool is injected into the tool set. */
  askUserContext?: AskUserToolContext
  /** Extra tools merged into the tool set (e.g. schedule-only tools). */
  extraTools?: ToolSet
}

function isToolFailure(output: unknown): output is AgentToolOutput {
  return typeof output === 'object' && output !== null && 'error' in output
}

function getOutputError(output: unknown): string | undefined {
  return isToolFailure(output) && typeof output.error === 'string' ? output.error : undefined
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return `${bytes} bytes`
  }
  if (bytes < 1024) {
    return `${bytes} bytes`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const rounded = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return `${rounded} ${units[unitIndex]}`
}

function extractTextContent(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null || !('content' in output)) {
    return undefined
  }

  const content = output.content
  if (!Array.isArray(content)) {
    return undefined
  }

  const text = content
    .filter(
      (
        block
      ): block is {
        type: 'text'
        text: string
      } =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('')
    .trim()

  return text || undefined
}

function summarizeDelegateCodingTaskOutput(output: unknown): string | undefined {
  const text = extractTextContent(output)
  if (!text) {
    return undefined
  }

  const footerMarker =
    "CRITICAL: The subagent has finished its execution. Before replying to the user, you MUST use your `read`, `bash` (e.g., git status, git diff), or `grep` tools to verify the actual file changes. Do not blindly trust the agent's summary. Once verified, report your findings to the user."
  const withoutFooter = text.replace(`\n\n${footerMarker}`, '').trim()
  const sessionLineMatch = /Session ID:\s*([^\n]+)/i.exec(withoutFooter)
  const sessionSummary = sessionLineMatch ? `session ${sessionLineMatch[1].trim()}` : undefined
  const body = withoutFooter.replace(/Session ID:[^\n]*\n*/i, '').trim()
  const bodySummary = body ? takeTail(body, 120).text : undefined

  if (sessionSummary && bodySummary) {
    return `${sessionSummary} • ${bodySummary}`
  }

  return sessionSummary ?? bodySummary ?? takeTail(withoutFooter, 120).text
}

export function summarizeToolInput(toolName: ToolCallName | string, input: unknown): string {
  if (toolName === 'askUser') {
    const question =
      typeof input === 'object' && input !== null && 'question' in input ? input.question : ''
    return typeof question === 'string' ? takeTail(question, 160).text : 'askUser'
  }

  if (toolName === 'bash') {
    const command =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : ''
    return typeof command === 'string' ? takeTail(command, 160).text : toolName
  }

  if (toolName === 'jsRepl') {
    const code = typeof input === 'object' && input !== null && 'code' in input ? input.code : ''
    return typeof code === 'string' ? takeTail(code, 160).text : toolName
  }

  if (toolName === 'webRead') {
    const url = typeof input === 'object' && input !== null && 'url' in input ? input.url : ''
    return typeof url === 'string' && url.trim().length > 0 ? takeTail(url, 160).text : toolName
  }

  if (toolName === 'webSearch') {
    const query = typeof input === 'object' && input !== null && 'query' in input ? input.query : ''
    return typeof query === 'string' && query.trim().length > 0
      ? takeTail(query, 160).text
      : toolName
  }

  if (toolName === 'skillsRead') {
    const names =
      typeof input === 'object' && input !== null && 'names' in input ? input.names : undefined
    return Array.isArray(names) && names.length > 0
      ? takeTail(names.join(', '), 160).text
      : toolName
  }

  if (toolName === 'grep' || toolName === 'glob') {
    const pattern =
      typeof input === 'object' && input !== null && 'pattern' in input ? input.pattern : ''
    return typeof pattern === 'string' && pattern.trim().length > 0
      ? takeTail(pattern, 160).text
      : toolName
  }

  if (toolName === 'remember') {
    const title = typeof input === 'object' && input !== null && 'title' in input ? input.title : ''
    return typeof title === 'string' && title.trim().length > 0
      ? takeTail(title, 160).text
      : toolName
  }

  if (toolName === 'searchMemory') {
    const query = typeof input === 'object' && input !== null && 'query' in input ? input.query : ''
    return typeof query === 'string' && query.trim().length > 0
      ? takeTail(query, 160).text
      : toolName
  }

  if (toolName === 'delegateCodingTask') {
    const agentName =
      typeof input === 'object' && input !== null && 'agent_name' in input ? input.agent_name : ''
    return typeof agentName === 'string' && agentName.trim().length > 0
      ? takeTail(agentName, 160).text
      : toolName
  }

  const path = typeof input === 'object' && input !== null && 'path' in input ? input.path : ''
  return typeof path === 'string' && path.trim().length > 0 ? path : toolName
}

export function summarizeToolOutput(
  toolName: ToolCallName | string,
  output: unknown,
  options: { phase?: 'update' | 'end' } = {}
): string {
  const phase = options.phase ?? 'end'
  const error = getOutputError(output)

  if (error) {
    return error
  }

  if (toolName === 'askUser') {
    const details = (output as import('./agentTools/shared.ts').AskUserToolOutput).details
    return details.answer ? `answered: ${takeTail(details.answer, 120).text}` : 'waiting for answer'
  }

  if (toolName === 'read') {
    const details = (output as ReadToolOutput).details
    if (details.mediaType === 'application/pdf') {
      const pages = details.totalPages ?? 0
      const lines = `lines ${details.startLine}-${details.endLine}`
      const cached = details.cached ? ', cached' : ''
      const truncated = details.truncated ? ' (truncated)' : ''
      return `${pages} page${pages === 1 ? '' : 's'}, ${lines}${cached}${truncated}`
    }
    if (details.mediaType) {
      return `read image (${details.mediaType}, ${formatByteSize(details.totalBytes)})`
    }
    const summary = `lines ${details.startLine}-${details.endLine}`
    return details.truncated ? `${summary} (truncated)` : summary
  }

  if (toolName === 'write') {
    const details = (output as WriteToolOutput).details
    return details.overwritten
      ? `overwrote ${details.bytesWritten} bytes`
      : `wrote ${details.bytesWritten} bytes`
  }

  if (toolName === 'edit') {
    const details = (output as EditToolOutput).details
    return details.firstChangedLine === undefined
      ? `replaced ${details.replacements} occurrence${details.replacements === 1 ? '' : 's'}`
      : `replaced ${details.replacements} occurrence${details.replacements === 1 ? '' : 's'} at line ${details.firstChangedLine}`
  }

  if (toolName === 'webRead') {
    const details = (output as WebReadToolOutput).details
    if (details.savedFileName || details.savedFilePath) {
      return `saved to ${details.savedFileName ?? details.savedFilePath}`
    }

    return details.title?.trim() ? `read "${details.title}"` : 'read web page'
  }

  if (toolName === 'webSearch') {
    const details = (output as WebSearchToolOutput).details
    const summary = `found ${details.resultCount} result${details.resultCount === 1 ? '' : 's'}`
    return details.failureCode ? `search failed (${details.failureCode})` : summary
  }

  if (toolName === 'skillsRead') {
    const details = (output as SkillsReadToolOutput).details
    if (details.resolvedCount === 0) {
      return 'no skills found'
    }
    return `read ${details.resolvedCount} skill${details.resolvedCount === 1 ? '' : 's'}`
  }

  if (toolName === 'jsRepl') {
    const details = (output as JsReplToolOutput).details
    if (details.timedOut) return 'timed out'
    if (details.error) return `error: ${takeTail(details.error, 80).text}`
    if (details.result) return takeTail(details.result, 120).text
    return details.consoleOutput ? 'console output' : 'no output'
  }

  if (toolName === 'grep') {
    const details = (output as GrepToolOutput).details
    const summary = `found ${details.resultCount} match${details.resultCount === 1 ? '' : 'es'}`
    return details.truncated ? `${summary} (truncated)` : summary
  }

  if (toolName === 'glob') {
    const details = (output as GlobToolOutput).details
    const summary = `found ${details.resultCount} file${details.resultCount === 1 ? '' : 's'}`
    return details.truncated ? `${summary} (truncated)` : summary
  }

  if (toolName === 'remember' || toolName === 'searchMemory') {
    const typed = output as { content?: Array<{ type: string; text?: string }>; error?: string }
    if (typed.error) return typed.error
    const text = typed.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return text ? takeTail(text, 120).text : 'done'
  }

  if (toolName === 'delegateCodingTask') {
    return summarizeDelegateCodingTaskOutput(output) ?? 'delegated task completed'
  }

  if (phase === 'update') {
    return 'streaming output'
  }

  const details = (output as BashToolOutput).details
  return typeof details.exitCode === 'number' ? `exit ${details.exitCode}` : 'command completed'
}

export function normalizeToolResult(
  toolName: ToolCallName | string,
  output: unknown,
  options: { phase?: 'update' | 'end' } = {}
): {
  status: ToolCallStatus
  outputSummary?: string
  cwd?: string
  error?: string
  details?: ToolCallDetailsSnapshot
} {
  const phase = options.phase ?? 'end'
  const typedOutput = output as AgentToolOutput
  const error = getOutputError(output)

  const isBackground =
    toolName === 'bash' &&
    typedOutput.details &&
    'background' in typedOutput.details &&
    typedOutput.details.background === true

  return {
    status:
      phase === 'update' ? 'running' : isBackground ? 'background' : error ? 'failed' : 'completed',
    outputSummary: isBackground
      ? `background: ${(typedOutput.details as { taskId?: string }).taskId ?? 'unknown'}`
      : summarizeToolOutput(toolName, output, { phase }),
    ...(typedOutput.metadata?.cwd ? { cwd: typedOutput.metadata.cwd } : {}),
    ...(error ? { error } : {}),
    ...(typedOutput.details ? { details: typedOutput.details } : {})
  }
}

/**
 * Wrap a real tool so that when it is disabled by the user, its execute
 * short-circuits with a "disabled" error. The schema stays registered in
 * the API request regardless, keeping the prompt cache prefix stable.
 */
function wrapDisabledTool<TInput, TOutput>(
  realTool: Tool<TInput, TOutput>,
  toolName: string,
  enabledTools: Set<ToolCallName>
): Tool<TInput, TOutput> {
  if (enabledTools.has(toolName as ToolCallName)) {
    return realTool
  }
  const disabledExecute = async (): Promise<TOutput> =>
    ({
      content: [
        {
          type: 'text',
          text: `Tool "${toolName}" is currently disabled by the user. Do not retry this tool until told it is re-enabled.`
        }
      ],
      details: {},
      metadata: { blocked: true },
      error: `Tool "${toolName}" is disabled by the user.`
    }) as unknown as TOutput
  return Object.assign(Object.create(null), realTool, {
    execute: disabledExecute
  }) as Tool<TInput, TOutput>
}

export function createAgentToolSet(
  context: AgentToolContext,
  dependencies: AgentToolDependencies = {}
): ToolSet | undefined {
  // Inject a shared read-record cache if not already provided.
  if (!context.readRecordCache) {
    context.readRecordCache = new ReadRecordCache()
  }

  const enabledTools = new Set(
    normalizeEnabledTools(context.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
  )

  const tools: ToolSet = {}

  // --- User-managed tools: always registered for cache stability ---
  // When no user-managed tools are enabled the run is intentionally tool-free
  // (e.g. restricted channel policy). Skip the always-register logic so the
  // model sees no schemas and behaves as a pure conversational turn.
  const hasAnyUserTool = USER_MANAGED_TOOL_NAMES.some((name) => enabledTools.has(name))

  if (hasAnyUserTool) {
    tools.read = wrapDisabledTool(createReadTool(context), 'read', enabledTools)
    tools.write = wrapDisabledTool(createWriteTool(context), 'write', enabledTools)
    tools.edit = wrapDisabledTool(createEditTool(context), 'edit', enabledTools)
    tools.bash = wrapDisabledTool(createBashTool(context), 'bash', enabledTools)
    tools.jsRepl = wrapDisabledTool(
      createJsReplTool(context, {
        ...(dependencies.searchService ? { searchService: dependencies.searchService } : {}),
        ...(dependencies.webSearchService
          ? { webSearchService: dependencies.webSearchService }
          : {})
      }),
      'jsRepl',
      enabledTools
    )

    tools.webRead = wrapDisabledTool(
      createWebReadTool(context, {
        ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
        ...(dependencies.loadBrowserSnapshot
          ? { loadBrowserSnapshot: dependencies.loadBrowserSnapshot }
          : {})
      }),
      'webRead',
      enabledTools
    )

    // Service-gated tools: only registered when the backing service is available.
    // Service availability is stable within a session so omitting them doesn't
    // cause cache churn — unlike user toggles which the wrapDisabledTool handles.
    if (dependencies.searchService) {
      tools.grep = wrapDisabledTool(
        createGrepTool(context, { searchService: dependencies.searchService }),
        'grep',
        enabledTools
      )
      tools.glob = wrapDisabledTool(
        createGlobTool(context, { searchService: dependencies.searchService }),
        'glob',
        enabledTools
      )
    }

    if (dependencies.webSearchService) {
      tools.webSearch = wrapDisabledTool(
        createWebSearchTool(context, { webSearchService: dependencies.webSearchService }),
        'webSearch',
        enabledTools
      )
    }
  }

  // --- Runtime-managed tools: conditional registration (not user-toggled) ---
  // Register skillsRead when explicitly enabled, or when any user tool is enabled
  // for cache stability (wrapped as disabled when not explicitly enabled).
  if (dependencies.availableSkills && (enabledTools.has('skillsRead') || hasAnyUserTool)) {
    tools.skillsRead = wrapDisabledTool(
      createSkillsReadTool(context, {
        availableSkills: dependencies.availableSkills
      }),
      'skillsRead',
      enabledTools
    )
  }

  if (dependencies.memoryService?.isConfigured() || dependencies.crossThreadSearch) {
    tools.searchMemory = createSearchMemoryTool({
      memoryService: dependencies.memoryService,
      crossThreadSearch: dependencies.crossThreadSearch
    })
  }

  if (dependencies.rememberDeps) {
    tools.remember = createRememberTool(dependencies.rememberDeps)
  }

  if (dependencies.updateProfileDeps) {
    tools.updateProfile = createUpdateProfileTool(dependencies.updateProfileDeps)
  }

  const enabledSubagentProfiles = (dependencies.subagentProfiles ?? []).filter((p) => p.enabled)
  if (enabledSubagentProfiles.length > 0) {
    const subagentCtx: DelegateCodingTaskContext = {
      workspacePath: context.workspacePath,
      availableWorkspaces: dependencies.availableWorkspaces ?? [],
      profiles: enabledSubagentProfiles,
      onProgress: dependencies.onSubagentProgress,
      onSubagentStarted: dependencies.onSubagentStarted,
      onSubagentFinished: dependencies.onSubagentFinished
    }
    tools.delegateCodingTask = createDelegateCodingTaskTool(subagentCtx)
  }

  if (dependencies.askUserContext) {
    tools.askUser = createAskUserTool(dependencies.askUserContext)
  }

  if (dependencies.extraTools) {
    Object.assign(tools, dependencies.extraTools)
  }

  return Object.keys(tools).length > 0 ? tools : undefined
}
