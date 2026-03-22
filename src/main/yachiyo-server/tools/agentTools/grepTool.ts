import { isAbsolute, relative, resolve } from 'node:path'

import { tool, type Tool } from 'ai'

import type { GrepToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  grepToolInputSchema,
  type AgentToolContext,
  type GrepToolInput,
  type GrepToolOutput,
  textContent,
  toToolModelOutput
} from './shared.ts'

export function createTool(
  context: AgentToolContext,
  dependencies: { searchService: SearchService }
): Tool<GrepToolInput, GrepToolOutput> {
  return tool({
    description:
      'Search file contents under the current thread workspace or an absolute path. Prefer this over bash for code/text search. Returns normalized line matches.',
    inputSchema: grepToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      runGrepTool(input, context, {
        abortSignal: options.abortSignal,
        searchService: dependencies.searchService
      })
  })
}

export async function runGrepTool(
  input: GrepToolInput,
  context: AgentToolContext,
  dependencies: {
    abortSignal?: AbortSignal
    searchService: SearchService
  }
): Promise<GrepToolOutput> {
  const searchPath = input.path?.trim() || '.'
  const resolvedPath = resolveToolTarget(context.workspacePath, searchPath)
  const fallbackDetails: GrepToolCallDetails = {
    backend: dependencies.searchService.capabilities.grep.preferred,
    pattern: input.pattern,
    path: resolvedPath,
    resultCount: 0,
    truncated: false,
    matches: []
  }

  try {
    const result = await dependencies.searchService.grep({
      cwd: context.workspacePath,
      pattern: input.pattern,
      path: searchPath,
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      literal: input.literal,
      caseSensitive: input.caseSensitive,
      signal: dependencies.abortSignal
    })

    const matches = result.matches.map((match) => ({
      ...match,
      path: toWorkspaceDisplayPath(context.workspacePath, result.rootPath, match.path)
    }))
    const details: GrepToolCallDetails = {
      backend: result.backend,
      pattern: input.pattern,
      path: resolvedPath,
      resultCount: matches.length,
      truncated: result.truncated,
      matches
    }

    return {
      content: textContent(formatGrepContent(matches, result.truncated)),
      details,
      metadata: {}
    }
  } catch (error) {
    return {
      content: textContent(error instanceof Error ? error.message : 'Search failed.'),
      details: fallbackDetails,
      error: error instanceof Error ? error.message : 'Search failed.',
      metadata: {}
    }
  }
}

function formatGrepContent(matches: GrepToolCallDetails['matches'], truncated: boolean): string {
  if (matches.length === 0) {
    return 'No matches found.'
  }

  const lines = matches.map((match) => `${match.path}:${match.line}: ${match.text}`)
  if (truncated) {
    lines.push('', '[truncated search results]')
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
