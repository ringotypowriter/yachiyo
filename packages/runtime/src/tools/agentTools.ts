import type { Tool, ToolSet } from 'ai'

import {
  DEFAULT_ENABLED_TOOL_NAMES,
  USER_MANAGED_TOOL_NAMES,
  normalizeEnabledTools,
  type SkillCatalogEntry,
  type SkillSummary,
  type SubagentProfile,
  type ToolCallDetailsSnapshot,
  type ToolCallName,
  type ToolCallStatus
} from '@yachiyo/shared/protocol'
import type { SearchService } from '../services/search/searchService.ts'
import type { WebSearchService } from '../services/webSearch/webSearchService.ts'
import type { MemoryService } from '../services/memory/memoryService.ts'
import type { BrowserWebPageSnapshotLoader } from '../services/webRead/browserWebPageSnapshot.ts'
import type { BrowserAutomationService } from '../services/browserAutomation/electronBrowserAutomationService.ts'

import {
  createTool as createApplyPatchTool,
  parsePatchStreaming,
  type Hunk
} from './agentTools/applyPatchTool.ts'
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
  createTool as createQuerySourceTool,
  type QuerySourceExecutor
} from './agentTools/querySourceTool.ts'
import { createTool as createReadTool } from './agentTools/readTool.ts'
import { createTool as createSkillsReadTool } from './agentTools/skillsReadTool.ts'
import {
  takeTail,
  type AgentToolContext,
  type AgentToolOutput,
  type ApplyPatchToolOutput,
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
import { createTool as createUseBrowserTool } from './agentTools/useBrowserTool.ts'
import { createTool as createUseThingsTool } from './agentTools/useThingsTool.ts'
import { createTool as createReviewThingsTool } from './agentTools/reviewThingsTool.ts'
import {
  createTool as createDelegateTaskTool,
  type DelegateTaskContext,
  type DelegateTaskFinishedEvent,
  type DelegateTaskProgressEvent,
  type DelegateTaskStartedEvent,
  type DelegateTaskToolCallEvent
} from './agentTools/delegateTaskTool.ts'

import {
  createTool as createUpdateProfileTool,
  type UpdateProfileDeps
} from './agentTools/updateProfileTool.ts'
import { createAskUserTool, type AskUserToolContext } from './agentTools/askUserTool.ts'
import {
  createUpdateTodoListTool,
  type UpdateTodoListToolContext
} from './agentTools/updateTodoListTool.ts'
import { createUseSentinelTool, type UseSentinelToolContext } from './agentTools/useSentinelTool.ts'
import type { YachiyoStorage } from '../storage/storage.ts'
import type { ThingDomain } from '../app/domain/things/thingDomain.ts'
import { createPlanExitTool } from '../app/domain/run/plan/planWriteTool.ts'
import type { ModelRuntime } from '../runtime/models/types.ts'
import type { ProviderSettings, SettingsConfig, SubagentsConfig } from '@yachiyo/shared/protocol'

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
  createUpdateTodoListTool,
  type UpdateTodoListToolContext
} from './agentTools/updateTodoListTool.ts'
export { createUseSentinelTool, type UseSentinelToolContext } from './agentTools/useSentinelTool.ts'

export {
  createTool as createApplyPatchTool,
  parsePatchStreaming,
  runApplyPatchTool
} from './agentTools/applyPatchTool.ts'
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
  DelegateTaskFinishedEvent,
  DelegateTaskProgressEvent,
  DelegateTaskStartedEvent,
  DelegateTaskToolCallEvent
} from './agentTools/delegateTaskTool.ts'

export interface AgentToolDependencies {
  availableSkills?: SkillCatalogEntry[]
  /** Active (enabled) skills, surfaced to worker subagents so they can discover what exists. */
  activeSkills?: SkillSummary[]
  fetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  browserAutomationService?: BrowserAutomationService
  memoryService?: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
  updateProfileDeps?: UpdateProfileDeps
  /** When provided, the remember tool is injected (local + owner DM contexts only). */
  rememberDeps?: RememberToolDeps
  /** When provided, querySource exposes local context sources. */
  activityOcrEnabled?: boolean
  /** When provided, useThings exposes cross-thread Things. */
  thingDomain?: ThingDomain
  sourceQueryExecutor?: QuerySourceExecutor
  sourceQueryStorage?: YachiyoStorage
  subagentProfiles?: SubagentProfile[]
  subagentsConfig?: SubagentsConfig
  /** Workspace paths the coding agent is allowed to operate in (from config savedPaths). */
  availableWorkspaces?: string[]
  onSubagentProgress?: (event: DelegateTaskProgressEvent) => void
  onSubagentStarted?: (event: DelegateTaskStartedEvent) => void
  onSubagentFinished?: (event: DelegateTaskFinishedEvent) => void
  onSubagentToolCall?: (event: DelegateTaskToolCallEvent) => void
  /** When provided, the askUser tool is injected into the tool set. */
  askUserContext?: AskUserToolContext
  /** When provided, updateTodoList drives the persistent composer todo widget. */
  todoContext?: UpdateTodoListToolContext
  /** When provided, useSentinel can manage thread-level wake checks. */
  sentinelContext?: UseSentinelToolContext
  /** Internal gate for Plan Mode's exit tool; the schema stays registered either way. */
  planModeExitEnabled?: boolean
  /** Extra tools merged into the tool set (e.g. schedule-only tools). */
  extraTools?: ToolSet
  /** Provider settings for worker subagent model calls. */
  settings?: ProviderSettings
  /** Full settings config for resolving subagent preferred models. */
  config?: SettingsConfig
  /** Factory for creating a ModelRuntime for worker subagents. */
  createModelRuntime?: () => ModelRuntime
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

function summarizeDelegateTaskOutput(output: unknown): string | undefined {
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

function getBasename(path: string): string {
  return path.split('/').pop() ?? path
}

function formatApplyPatchHunk(hunk: Hunk): string {
  switch (hunk.kind) {
    case 'add':
      return getBasename(hunk.path)
    case 'delete':
      return getBasename(hunk.path)
    case 'update':
      return getBasename(hunk.movePath ?? hunk.path)
  }
}

function summarizeApplyPatchInput(patch: string): string {
  try {
    const parts = parsePatchStreaming(patch).hunks.map(formatApplyPatchHunk)
    if (parts.length > 0) {
      return takeTail(parts.join(', '), 160).text
    }
  } catch {
    return ''
  }
  return ''
}

function parseCommandWords(command: string): string[] {
  return Array.from(
    command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g),
    (match) => match[1] ?? match[2] ?? match[3] ?? ''
  ).filter(Boolean)
}

function formatBashObject(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).hostname
  } catch {
    return getBasename(value)
  }
}

function isBashOption(value: string): boolean {
  return value.startsWith('-')
}

function isSedAddress(value: string): boolean {
  return /^\d+(?:,\d+)?[a-z]?$/i.test(value)
}

function lastBashObject(words: string[], startIndex = 1): string | undefined {
  return [...words]
    .slice(startIndex)
    .reverse()
    .find((word) => !isBashOption(word) && !isSedAddress(word))
}

const BASH_CONNECTORS = new Set(['&&', '||', '|'])

function summarizeSimpleBashCommand(words: string[]): string {
  const executable = getBasename(words[0] ?? '')
  if (!executable) return ''

  if (
    executable === 'pnpm' ||
    executable === 'npm' ||
    executable === 'yarn' ||
    executable === 'bun'
  ) {
    if (words[1] === 'run' && words[2]) return `${executable} ${words[2]}`
    return words[1] ? `${executable} ${words[1]}` : executable
  }

  if (executable === 'git') {
    const subcommand = words[1]
    if (!subcommand) return 'git'
    const separatorIndex = words.indexOf('--')
    const pathAfterSeparator = separatorIndex >= 0 ? words[separatorIndex + 1] : undefined
    const target =
      formatBashObject(pathAfterSeparator) ?? formatBashObject(lastBashObject(words, 2))
    return target ? `git ${subcommand} ${target}` : `git ${subcommand}`
  }

  if (executable === 'node' && words.includes('--test')) {
    const target = formatBashObject(lastBashObject(words, words.indexOf('--test') + 1))
    return target ? `node test ${target}` : 'node test'
  }

  const target = formatBashObject(lastBashObject(words))
  if (target && target !== executable) return `${executable} ${target}`
  return words.length > 1 ? `${executable} …` : executable
}

function summarizeBashCommand(command: string): string {
  const words = parseCommandWords(command)
  if (!words.some((word) => BASH_CONNECTORS.has(word))) {
    return summarizeSimpleBashCommand(words)
  }

  const parts: string[] = []
  let segment: string[] = []

  for (const word of words) {
    if (BASH_CONNECTORS.has(word)) {
      const summary = summarizeSimpleBashCommand(segment)
      if (summary) parts.push(summary)
      parts.push(word)
      segment = []
    } else {
      segment.push(word)
    }
  }

  const finalSummary = summarizeSimpleBashCommand(segment)
  if (finalSummary) parts.push(finalSummary)

  return takeTail(parts.join(' '), 160).text
}

function takeHead(value: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = value.trim()
  if (trimmed.length <= maxChars) {
    return { text: trimmed, truncated: false }
  }
  return { text: trimmed.slice(0, maxChars).trimEnd(), truncated: true }
}

function summarizeBashOutputSnapshot(details: Partial<BashToolOutput['details']>): string {
  const output =
    (typeof details.stdout === 'string' ? details.stdout.trim() : '') ||
    (typeof details.stderr === 'string' ? details.stderr.trim() : '')
  if (output) {
    const head = takeHead(output, 160)
    return `${head.text}${head.truncated ? '…' : ''}`
  }
  if (typeof details.exitCode === 'number') {
    return `exit ${details.exitCode}`
  }
  return 'no output'
}

export function summarizeToolInput(toolName: ToolCallName | string, input: unknown): string {
  if (toolName === 'askUser') {
    const question =
      typeof input === 'object' && input !== null && 'question' in input ? input.question : ''
    return typeof question === 'string' ? takeTail(question, 160).text : 'askUser'
  }

  if (toolName === 'bash') {
    const description =
      typeof input === 'object' && input !== null && 'description' in input
        ? (input as { description?: unknown }).description
        : ''
    if (typeof description === 'string' && description.trim().length > 0) {
      return takeTail(description.trim(), 160).text
    }
    const command =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : ''
    return typeof command === 'string' ? summarizeBashCommand(command) : toolName
  }

  if (toolName === 'jsRepl') {
    return 'JavaScript'
  }

  if (toolName === 'webRead') {
    const url = typeof input === 'object' && input !== null && 'url' in input ? input.url : ''
    return typeof url === 'string' && url.trim().length > 0 ? takeTail(url, 160).text : toolName
  }

  if (toolName === 'useBrowser') {
    if (typeof input === 'object' && input !== null && 'action' in input) {
      const action = (input as { action?: unknown }).action
      const session = (input as { session?: unknown }).session
      const url = (input as { url?: unknown }).url
      const ref = (input as { ref?: unknown }).ref
      const script = (input as { script?: unknown }).script

      const actionText = typeof action === 'string' ? action : 'useBrowser'
      const sessionText =
        typeof session === 'string' && session.trim() ? ` (${session.trim()})` : ''

      if ((actionText === 'open' || actionText === 'loadUrl') && typeof url === 'string') {
        return takeTail(url, 160).text
      }
      if (
        (actionText === 'click' || actionText === 'fill' || actionText === 'type') &&
        typeof ref === 'string'
      ) {
        return `${actionText} @${ref}${sessionText}`
      }
      if (actionText === 'eval' && typeof script === 'string' && script.trim()) {
        return `eval ${takeTail(script, 120).text}${sessionText}`
      }
      return `${actionText}${sessionText}`
    }
    return 'useBrowser'
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

  if (toolName === 'useThings' || toolName === 'reviewThings') {
    if (typeof input === 'object' && input !== null && 'action' in input) {
      const action = String(input.action)
      const name = 'name' in input && typeof input.name === 'string' ? ` #${input.name}` : ''
      return `${action}${name}`
    }
    return toolName
  }

  if (toolName === 'querySource') {
    if (typeof input === 'object' && input !== null && 'from' in input) {
      const from = input.from
      const where = 'where' in input ? input.where : undefined
      const text =
        typeof where === 'object' && where !== null && 'text' in where ? where.text : undefined
      return typeof text === 'string' && text.trim().length > 0
        ? `${String(from)}: ${takeTail(text, 120).text}`
        : String(from)
    }
    return toolName
  }

  if (toolName === 'delegateTask') {
    const agentName =
      typeof input === 'object' && input !== null && 'agent_name' in input ? input.agent_name : ''
    return typeof agentName === 'string' && agentName.trim().length > 0
      ? takeTail(agentName, 160).text
      : toolName
  }

  if (toolName === 'applyPatch') {
    const patch = typeof input === 'object' && input !== null && 'patch' in input ? input.patch : ''
    return typeof patch === 'string' && patch.trim().length > 0
      ? summarizeApplyPatchInput(patch)
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

  if (toolName === 'applyPatch') {
    const details = (output as ApplyPatchToolOutput).details
    const opCount = details.operations.length
    if (opCount === 0) return 'no changes applied'
    const parts = details.operations.map((op) => getBasename(op.movePath ?? op.path))
    return `${opCount} file${opCount === 1 ? '' : 's'} (${parts.join(', ')})`
  }

  if (toolName === 'webRead') {
    const details = (output as WebReadToolOutput).details
    if (details.savedFileName || details.savedFilePath) {
      return `saved to ${details.savedFileName ?? details.savedFilePath}`
    }

    return details.title?.trim() ? `read "${details.title}"` : 'read web page'
  }

  if (toolName === 'useBrowser') {
    const details = (output as import('./agentTools/shared.ts').UseBrowserToolOutput).details
    if (details.savedFileName || details.savedFilePath) {
      return `saved to ${details.savedFileName ?? details.savedFilePath}`
    }
    if (typeof details.refCount === 'number') {
      return `snapshot (${details.refCount} ref${details.refCount === 1 ? '' : 's'})`
    }
    if (details.finalUrl) {
      return takeTail(details.finalUrl, 160).text
    }
    return details.action
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

  if (toolName === 'bash') {
    return summarizeBashOutputSnapshot((output as BashToolOutput).details)
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

  if (
    toolName === 'remember' ||
    toolName === 'querySource' ||
    toolName === 'useThings' ||
    toolName === 'reviewThings' ||
    toolName === 'updateProfile' ||
    toolName === 'useSentinel'
  ) {
    const typed = output as { content?: Array<{ type: string; text?: string }>; error?: string }
    if (typed.error) return typed.error
    const text = typed.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return text ? takeTail(text, 120).text : 'done'
  }

  if (toolName === 'delegateTask') {
    return summarizeDelegateTaskOutput(output) ?? 'delegated task completed'
  }

  if (phase === 'update') {
    return 'streaming output'
  }

  return extractTextContent(output) ?? 'tool completed'
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
    status: phase === 'update' ? 'running' : error ? 'failed' : 'completed',
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
function disabledToolExecute<TOutput>(toolName: string): () => Promise<TOutput> {
  return async () =>
    ({
      content: [
        {
          type: 'text',
          text: `Tool "${toolName}" is currently disabled. Do not retry this tool until told it is re-enabled.`
        }
      ],
      details: {},
      metadata: { blocked: true },
      error: `Tool "${toolName}" is disabled.`
    }) as unknown as TOutput
}

const TOOL_ENABLED_MARKER = Symbol.for('yachiyo.tool.enabled')

function wrapToolEnabled<TInput, TOutput>(
  realTool: Tool<TInput, TOutput>,
  toolName: string,
  enabled: boolean
): Tool<TInput, TOutput> {
  if (enabled) {
    return Object.assign(Object.create(null), realTool, {
      [TOOL_ENABLED_MARKER]: true
    }) as Tool<TInput, TOutput>
  }
  return Object.assign(Object.create(null), realTool, {
    execute: disabledToolExecute<TOutput>(toolName),
    [TOOL_ENABLED_MARKER]: false
  }) as Tool<TInput, TOutput>
}

export function resolveAvailableToolNamesFromToolSet(toolSet: ToolSet | undefined): string[] {
  if (!toolSet) return []
  return Object.entries(toolSet)
    .filter(([, tool]) => (tool as Record<symbol, unknown>)[TOOL_ENABLED_MARKER] !== false)
    .map(([toolName]) => toolName)
}

function wrapDisabledTool<TInput, TOutput>(
  realTool: Tool<TInput, TOutput>,
  toolName: string,
  enabledTools: Set<ToolCallName>
): Tool<TInput, TOutput> {
  return wrapToolEnabled(realTool, toolName, enabledTools.has(toolName as ToolCallName))
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
  const registerOnlyEnabledToolSchemas = context.registerOnlyEnabledToolSchemas === true
  const shouldRegisterTool = (toolName: ToolCallName): boolean =>
    !registerOnlyEnabledToolSchemas || enabledTools.has(toolName)

  const tools: ToolSet = {}

  // --- User-managed tools: always registered for cache stability ---
  // When no user-managed tools are enabled the run is intentionally tool-free
  // (e.g. restricted channel policy). Skip the always-register logic so the
  // model sees no schemas and behaves as a pure conversational turn.
  const hasAnyUserTool = USER_MANAGED_TOOL_NAMES.some((name) => enabledTools.has(name))

  if (hasAnyUserTool) {
    if (shouldRegisterTool('read')) {
      tools.read = wrapDisabledTool(createReadTool(context), 'read', enabledTools)
    }
    if (shouldRegisterTool('write')) {
      tools.write = wrapDisabledTool(createWriteTool(context), 'write', enabledTools)
    }
    if (shouldRegisterTool('edit')) {
      tools.edit = wrapDisabledTool(createEditTool(context), 'edit', enabledTools)
    }
    if (shouldRegisterTool('bash')) {
      tools.bash = wrapDisabledTool(createBashTool(context), 'bash', enabledTools)
    }
    if (shouldRegisterTool('applyPatch')) {
      tools.applyPatch = wrapDisabledTool(createApplyPatchTool(context), 'applyPatch', enabledTools)
    }
    if (shouldRegisterTool('jsRepl')) {
      tools.jsRepl = wrapDisabledTool(
        createJsReplTool(context, {
          ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
          ...(dependencies.searchService ? { searchService: dependencies.searchService } : {}),
          ...(dependencies.webSearchService
            ? { webSearchService: dependencies.webSearchService }
            : {})
        }),
        'jsRepl',
        enabledTools
      )
    }

    if (shouldRegisterTool('webRead')) {
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
    }

    if (shouldRegisterTool('useBrowser')) {
      tools.useBrowser = wrapDisabledTool(
        createUseBrowserTool(context, {
          browserAutomationService: dependencies.browserAutomationService
        }),
        'useBrowser',
        enabledTools
      )
    }

    // Service-gated tools: only registered when the backing service is available.
    // Service availability is stable within a session so omitting them doesn't
    // cause cache churn — unlike user toggles which the wrapDisabledTool handles.
    if (dependencies.searchService && shouldRegisterTool('grep')) {
      tools.grep = wrapDisabledTool(
        createGrepTool(context, { searchService: dependencies.searchService }),
        'grep',
        enabledTools
      )
    }
    if (dependencies.searchService && shouldRegisterTool('glob')) {
      tools.glob = wrapDisabledTool(
        createGlobTool(context, { searchService: dependencies.searchService }),
        'glob',
        enabledTools
      )
    }

    if (dependencies.webSearchService && shouldRegisterTool('webSearch')) {
      tools.webSearch = wrapDisabledTool(
        createWebSearchTool(context, { webSearchService: dependencies.webSearchService }),
        'webSearch',
        enabledTools
      )
    }
  }

  // --- Runtime-managed tools: conditional registration (not user-toggled) ---
  if (dependencies.sentinelContext && shouldRegisterTool('useSentinel')) {
    tools.useSentinel = createUseSentinelTool(dependencies.sentinelContext)
  }

  // Register skillsRead when explicitly enabled, or when any user tool is enabled
  // for cache stability.
  if (
    dependencies.availableSkills &&
    (enabledTools.has('skillsRead') || (!registerOnlyEnabledToolSchemas && hasAnyUserTool))
  ) {
    tools.skillsRead = createSkillsReadTool(context, {
      availableSkills: dependencies.availableSkills
    })
  }

  if (
    dependencies.sourceQueryExecutor ||
    dependencies.sourceQueryStorage ||
    dependencies.memoryService?.isConfigured()
  ) {
    if (shouldRegisterTool('querySource')) {
      tools.querySource = createQuerySourceTool({
        activityOcrEnabled: dependencies.activityOcrEnabled === true,
        ...(dependencies.sourceQueryStorage ? { storage: dependencies.sourceQueryStorage } : {}),
        ...(dependencies.sourceQueryExecutor
          ? { sourceQueryExecutor: dependencies.sourceQueryExecutor }
          : {}),
        memoryService: dependencies.memoryService
      })
    }
  }

  if (dependencies.rememberDeps && shouldRegisterTool('remember')) {
    tools.remember = createRememberTool(dependencies.rememberDeps)
  }

  if (dependencies.thingDomain && shouldRegisterTool('useThings')) {
    const useThingsTool = createUseThingsTool(context, { thingDomain: dependencies.thingDomain })
    tools.useThings =
      enabledTools.has('reviewThings') && !enabledTools.has('useThings')
        ? wrapToolEnabled(useThingsTool, 'useThings', false)
        : useThingsTool
  }

  if (
    dependencies.thingDomain &&
    enabledTools.has('reviewThings') &&
    shouldRegisterTool('reviewThings')
  ) {
    tools.reviewThings = createReviewThingsTool({ thingDomain: dependencies.thingDomain })
  }

  if (dependencies.updateProfileDeps && shouldRegisterTool('updateProfile')) {
    tools.updateProfile = createUpdateProfileTool(dependencies.updateProfileDeps)
  }

  const subagentsConfig = dependencies.subagentsConfig ?? { mode: 'worker', enabledNamedAgents: [] }
  const hasSubagentTool =
    subagentsConfig.mode === 'worker'
      ? subagentsConfig.enabledNamedAgents.length > 0
      : (dependencies.subagentProfiles ?? []).some((p) => p.enabled)
  if (
    hasSubagentTool &&
    shouldRegisterTool('delegateTask') &&
    dependencies.createModelRuntime &&
    dependencies.settings
  ) {
    const subagentCtx: DelegateTaskContext = {
      workspacePath: context.workspacePath,
      availableWorkspaces: dependencies.availableWorkspaces ?? [],
      subagentsConfig,
      subagentProfiles: dependencies.subagentProfiles ?? [],
      settings: dependencies.settings,
      config: dependencies.config,
      ...(dependencies.activeSkills ? { activeSkills: dependencies.activeSkills } : {}),
      createModelRuntime: dependencies.createModelRuntime,
      parentToolContext: context,
      parentDependencies: dependencies,
      onProgress: dependencies.onSubagentProgress,
      onSubagentStarted: dependencies.onSubagentStarted,
      onSubagentFinished: dependencies.onSubagentFinished,
      onSubagentToolCall: dependencies.onSubagentToolCall
    }
    tools.delegateTask = createDelegateTaskTool(subagentCtx)
  }

  if (dependencies.askUserContext && shouldRegisterTool('askUser')) {
    tools.askUser = createAskUserTool(dependencies.askUserContext)
  }

  if (dependencies.todoContext && shouldRegisterTool('updateTodoList')) {
    tools.updateTodoList = createUpdateTodoListTool(dependencies.todoContext)
  }

  if (shouldRegisterTool('exitPlanMode')) {
    tools.exitPlanMode = wrapToolEnabled(
      createPlanExitTool(),
      'exitPlanMode',
      dependencies.planModeExitEnabled === true
    )
  }

  if (dependencies.extraTools) {
    Object.assign(tools, dependencies.extraTools)
  }

  return Object.keys(tools).length > 0 ? tools : undefined
}
