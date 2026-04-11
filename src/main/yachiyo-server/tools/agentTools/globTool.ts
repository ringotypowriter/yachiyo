import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { tool, type Tool } from 'ai'

import type { GlobToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  expandTilde,
  FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE,
  globToolInputSchema,
  isForbiddenHugeSearchRoot,
  type AgentToolContext,
  type GlobToolInput,
  type GlobToolOutput,
  textContent,
  toToolModelOutput
} from './shared.ts'

const AUTO_SAVE_DIR = '.yachiyo/tool-result'
const INLINE_CONTENT_LIMIT = 32_000

export const GLOB_TOOL_DESCRIPTION =
  'Find files by glob pattern. Prefer this over bash (find/ls/fd) for all file discovery. Hidden files are included and .gitignore is NOT applied. If output is too large it is auto-saved to a workspace file.\n' +
  'Supports `*` (any chars except /), `**` (any depth), `?` (single char).\n' +
  'IMPORTANT: patterns are anchored to the search root. To find a file or directory at ANY depth, prefix with `**/`. Examples:\n' +
  '  - find any `slidev` directory anywhere: `**/slidev/**` (NOT `slidev/**/*`, which only matches `slidev/` directly under the search root)\n' +
  '  - find all TypeScript files anywhere: `**/*.ts`\n' +
  '  - find tests under src: `src/**/*.test.ts`\n' +
  '• `pattern`: glob pattern.\n' +
  '• `path`: directory to search in (defaults to workspace root).\n' +
  '• `limit`: max files returned (default 50, max 200).'

export function createTool(
  context: AgentToolContext,
  dependencies: { searchService: SearchService }
): Tool<GlobToolInput, GlobToolOutput> {
  return tool({
    description: GLOB_TOOL_DESCRIPTION,
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
  const { pattern, searchPath } = resolveGlobInput(
    input.pattern,
    input.path?.trim(),
    context.workspacePath
  )
  const resolvedPath = resolveToolTarget(context.workspacePath, searchPath)
  const fallbackDetails: GlobToolCallDetails = {
    backend: dependencies.searchService.capabilities.fileDiscovery.available,
    pattern: input.pattern,
    path: resolvedPath,
    resultCount: 0,
    truncated: false,
    matches: []
  }

  if (isForbiddenHugeSearchRoot(resolvedPath, context.workspacePath)) {
    return {
      content: textContent(FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE),
      details: fallbackDetails,
      error: FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE,
      metadata: {}
    }
  }

  try {
    const result = await dependencies.searchService.glob({
      cwd: context.workspacePath,
      pattern,
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

    const content = formatGlobContent(matches, result.truncated)

    if (content.length > INLINE_CONTENT_LIMIT) {
      const saved = await spillToFile(context.workspacePath, content)
      return {
        content: textContent(
          `Output too large to inline (${matches.length} files). Full output saved to ${saved.relativePath}.\nUse the read tool to read it.`
        ),
        details,
        metadata: { outputFilePath: saved.absolutePath }
      }
    }

    return {
      content: textContent(content),
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

  let output = matches.join('\n')
  if (truncated) {
    output += `\n\n[truncated — showing ${matches.length} files. Use a more specific pattern to narrow results.]`
  }
  return output
}

// When the model passes something like "~/.aerospace*" or "/home/user/.config*" as the
// pattern (i.e. an absolute/tilde path with a glob suffix), split it into the directory
// portion (used as the search path) and the basename portion (used as the pattern).
export function resolveGlobInput(
  rawPattern: string,
  rawPath: string | undefined,
  workspacePath: string
): { pattern: string; searchPath: string } {
  const expandedPattern = expandTilde(rawPattern.trim())

  if (isAbsolute(expandedPattern)) {
    return {
      pattern: basename(expandedPattern),
      searchPath: dirname(expandedPattern)
    }
  }

  return {
    pattern: rawPattern.trim(),
    searchPath: expandTilde(rawPath?.trim() || '.') || workspacePath
  }
}

async function spillToFile(
  workspacePath: string,
  content: string
): Promise<{ relativePath: string; absolutePath: string }> {
  const filename = `glob-${Date.now()}.txt`
  const relativePath = join(AUTO_SAVE_DIR, filename)
  const absolutePath = join(workspacePath, relativePath)
  await mkdir(join(workspacePath, AUTO_SAVE_DIR), { recursive: true })
  await writeFile(absolutePath, content, 'utf8')
  return { relativePath, absolutePath }
}

function resolveToolTarget(workspacePath: string, targetPath: string): string {
  const expanded = expandTilde(targetPath)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspacePath, expanded)
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
