import type { ToolSet } from 'ai'

import {
  DEFAULT_ENABLED_TOOL_NAMES,
  normalizeEnabledTools,
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
import { createTool as createMemorySearchTool } from './agentTools/memorySearchTool.ts'
import { createTool as createReadTool } from './agentTools/readTool.ts'
import {
  takeTail,
  type AgentToolContext,
  type AgentToolOutput,
  type BashToolOutput,
  type EditToolOutput,
  type GlobToolOutput,
  type GrepToolOutput,
  type ReadToolOutput,
  type WebReadToolOutput,
  type WebSearchToolOutput,
  type WriteToolOutput
} from './agentTools/shared.ts'
import { createTool as createWebReadTool } from './agentTools/webReadTool.ts'
import { createTool as createWebSearchTool } from './agentTools/webSearchTool.ts'
import { createTool as createWriteTool } from './agentTools/writeTool.ts'

export type {
  AgentToolMetadata,
  AgentToolResult,
  AgentToolOutput,
  BashToolOutput,
  EditToolOutput,
  GlobToolOutput,
  GrepToolOutput,
  ReadToolOutput,
  ToolContentBlock,
  WebReadToolOutput,
  WebSearchToolOutput,
  WriteToolOutput
} from './agentTools/shared.ts'

export {
  createTool as createBashTool,
  isBlockedBashCommand,
  runBashTool,
  streamBashTool
} from './agentTools/bashTool.ts'
export { createTool as createEditTool, runEditTool } from './agentTools/editTool.ts'
export { createTool as createGlobTool, runGlobTool } from './agentTools/globTool.ts'
export { createTool as createGrepTool, runGrepTool } from './agentTools/grepTool.ts'
export { createTool as createReadTool, runReadTool } from './agentTools/readTool.ts'
export { createTool as createWebReadTool, runWebReadTool } from './agentTools/webReadTool.ts'
export { createTool as createWebSearchTool, runWebSearchTool } from './agentTools/webSearchTool.ts'
export { createTool as createWriteTool, runWriteTool } from './agentTools/writeTool.ts'

export interface AgentToolDependencies {
  fetchImpl?: typeof globalThis.fetch
  loadBrowserSnapshot?: BrowserWebPageSnapshotLoader
  memoryService?: MemoryService
  searchService?: SearchService
  webSearchService?: WebSearchService
}

function isToolFailure(output: unknown): output is AgentToolOutput {
  return typeof output === 'object' && output !== null && 'error' in output
}

function getOutputError(output: unknown): string | undefined {
  return isToolFailure(output) && typeof output.error === 'string' ? output.error : undefined
}

export function summarizeToolInput(toolName: ToolCallName, input: unknown): string {
  if (toolName === 'bash') {
    const command =
      typeof input === 'object' && input !== null && 'command' in input ? input.command : ''
    return typeof command === 'string' ? takeTail(command, 160).text : toolName
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

  if (toolName === 'grep' || toolName === 'glob') {
    const pattern =
      typeof input === 'object' && input !== null && 'pattern' in input ? input.pattern : ''
    return typeof pattern === 'string' && pattern.trim().length > 0
      ? takeTail(pattern, 160).text
      : toolName
  }

  const path = typeof input === 'object' && input !== null && 'path' in input ? input.path : ''
  return typeof path === 'string' && path.trim().length > 0 ? path : toolName
}

export function summarizeToolOutput(
  toolName: ToolCallName,
  output: unknown,
  options: { phase?: 'update' | 'end' } = {}
): string {
  const phase = options.phase ?? 'end'
  const error = getOutputError(output)

  if (error) {
    return error
  }

  if (toolName === 'read') {
    const details = (output as ReadToolOutput).details
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

    const summary = details.title?.trim() ? `read "${details.title}"` : 'read web page'
    return details.truncated ? `${summary} (truncated)` : summary
  }

  if (toolName === 'webSearch') {
    const details = (output as WebSearchToolOutput).details
    const summary = `found ${details.resultCount} result${details.resultCount === 1 ? '' : 's'}`
    return details.failureCode ? `search failed (${details.failureCode})` : summary
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

  if (phase === 'update') {
    return 'streaming output'
  }

  const details = (output as BashToolOutput).details
  return typeof details.exitCode === 'number' ? `exit ${details.exitCode}` : 'command completed'
}

export function normalizeToolResult(
  toolName: ToolCallName,
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

  return {
    status: phase === 'update' ? 'running' : error ? 'failed' : 'completed',
    outputSummary: summarizeToolOutput(toolName, output, { phase }),
    ...(typedOutput.metadata.cwd ? { cwd: typedOutput.metadata.cwd } : {}),
    ...(error ? { error } : {}),
    ...(typedOutput.details ? { details: typedOutput.details } : {})
  }
}

export function createAgentToolSet(
  context: AgentToolContext,
  dependencies: AgentToolDependencies = {}
): ToolSet | undefined {
  const enabledTools = new Set(
    normalizeEnabledTools(context.enabledTools, DEFAULT_ENABLED_TOOL_NAMES)
  )

  const tools: ToolSet = {}

  if (enabledTools.has('read')) {
    tools.read = createReadTool(context)
  }

  if (enabledTools.has('write')) {
    tools.write = createWriteTool(context)
  }

  if (enabledTools.has('edit')) {
    tools.edit = createEditTool(context)
  }

  if (enabledTools.has('bash')) {
    tools.bash = createBashTool(context)
  }

  if (enabledTools.has('grep') && dependencies.searchService) {
    tools.grep = createGrepTool(context, {
      searchService: dependencies.searchService
    })
  }

  if (enabledTools.has('glob') && dependencies.searchService) {
    tools.glob = createGlobTool(context, {
      searchService: dependencies.searchService
    })
  }

  if (enabledTools.has('webRead')) {
    tools.webRead = createWebReadTool(context, {
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      ...(dependencies.loadBrowserSnapshot
        ? { loadBrowserSnapshot: dependencies.loadBrowserSnapshot }
        : {})
    })
  }

  if (enabledTools.has('webSearch') && dependencies.webSearchService) {
    tools.webSearch = createWebSearchTool(context, {
      webSearchService: dependencies.webSearchService
    })
  }

  if (dependencies.memoryService?.hasHiddenSearchCapability()) {
    tools.memory_search = createMemorySearchTool(dependencies.memoryService)
  }

  return Object.keys(tools).length > 0 ? tools : undefined
}
