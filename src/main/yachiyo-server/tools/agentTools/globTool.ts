import { isAbsolute, relative, resolve } from 'node:path'

import { tool, type Tool } from 'ai'

import type { GlobToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  globToolInputSchema,
  type AgentToolContext,
  type GlobToolInput,
  type GlobToolOutput,
  textContent,
  toToolModelOutput
} from './shared.ts'

export function createTool(
  context: AgentToolContext,
  dependencies: { searchService: SearchService }
): Tool<GlobToolInput, GlobToolOutput> {
  return tool({
    description:
      'Find files by glob pattern under the current thread workspace or an absolute path. Prefer this over bash for file discovery.',
    inputSchema: globToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      runGlobTool(input, context, {
        abortSignal: options.abortSignal,
        searchService: dependencies.searchService
      })
  })
}

export async function runGlobTool(
  input: GlobToolInput,
  context: AgentToolContext,
  dependencies: {
    abortSignal?: AbortSignal
    searchService: SearchService
  }
): Promise<GlobToolOutput> {
  const searchPath = input.path?.trim() || '.'
  const resolvedPath = resolveToolTarget(context.workspacePath, searchPath)
  const fallbackDetails: GlobToolCallDetails = {
    backend: dependencies.searchService.capabilities.fileDiscovery.preferred,
    pattern: input.pattern,
    path: resolvedPath,
    resultCount: 0,
    truncated: false,
    matches: []
  }

  try {
    const result = await dependencies.searchService.glob({
      cwd: context.workspacePath,
      pattern: input.pattern,
      path: searchPath,
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      signal: dependencies.abortSignal
    })

    const matches = result.paths.map((path) =>
      toWorkspaceDisplayPath(context.workspacePath, result.rootPath, path)
    )
    const details: GlobToolCallDetails = {
      backend: result.backend,
      pattern: input.pattern,
      path: resolvedPath,
      resultCount: matches.length,
      truncated: result.truncated,
      matches
    }

    return {
      content: textContent(formatGlobContent(matches, result.truncated)),
      details,
      metadata: {}
    }
  } catch (error) {
    return {
      content: textContent(error instanceof Error ? error.message : 'File discovery failed.'),
      details: fallbackDetails,
      error: error instanceof Error ? error.message : 'File discovery failed.',
      metadata: {}
    }
  }
}

function formatGlobContent(matches: string[], truncated: boolean): string {
  if (matches.length === 0) {
    return 'No files found.'
  }

  const lines = [...matches]
  if (truncated) {
    lines.push('', '[truncated file results]')
  }
  return lines.join('\n')
}

function resolveToolTarget(workspacePath: string, targetPath: string): string {
  return isAbsolute(targetPath) ? resolve(targetPath) : resolve(workspacePath, targetPath)
}

function toWorkspaceDisplayPath(
  workspacePath: string,
  rootPath: string,
  matchPath: string
): string {
  const absoluteMatchPath = isAbsolute(matchPath) ? matchPath : resolve(rootPath, matchPath)
  const relativeToWorkspace = relative(workspacePath, absoluteMatchPath)

  if (
    relativeToWorkspace &&
    !relativeToWorkspace.startsWith('..') &&
    !isAbsolute(relativeToWorkspace)
  ) {
    return relativeToWorkspace
  }

  if (relativeToWorkspace === '') {
    return '.'
  }

  return matchPath
}
