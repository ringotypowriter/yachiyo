import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { tool, type Tool } from 'ai'

import type { GrepToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { SearchService } from '../../services/search/searchService.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  expandTilde,
  FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE,
  grepToolInputSchema,
  isForbiddenHugeSearchRoot,
  type AgentToolContext,
  type GrepToolInput,
  type GrepToolOutput,
  textContent,
  toToolModelOutput
} from './shared.ts'

const AUTO_SAVE_DIR = '.yachiyo/tool-result'
const INLINE_CONTENT_LIMIT = 32_000

export const GREP_TOOL_DESCRIPTION =
  'Search file contents by regular expression (or literal string). Prefer this over bash (grep/rg/ag) for all code search. If output is too large it is auto-saved to a workspace file.\n' +
  '• `pattern`: Rust regex syntax when ripgrep is available, otherwise POSIX ERE (e.g. "function\\s+\\w+", "import.*from"). No lookaheads or backreferences. Use `literal: true` for exact fixed-string matching.\n' +
  '• `caseSensitive`: defaults to true.\n' +
  '• `include`: glob to filter files (e.g. "*.ts", "*.{ts,tsx}"). Highly recommended for large repos.\n' +
  '• `context`: number of lines before/after each match (0-30).\n' +
  '• `filesOnly`: when true, returns only the list of matching file paths (no line content).\n' +
  '• `limit`: max matches returned (default 50, max 200).'

export function createTool(
  context: AgentToolContext,
  dependencies: { searchService: SearchService }
): Tool<GrepToolInput, GrepToolOutput> {
  return tool({
    description: GREP_TOOL_DESCRIPTION,
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
  const searchPath = expandTilde(input.path?.trim() || '.')
  const resolvedPath = resolveToolTarget(context.workspacePath, searchPath)
  const fallbackDetails: GrepToolCallDetails = {
    backend: dependencies.searchService.capabilities.grep.available,
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
    const result = await dependencies.searchService.grep({
      cwd: context.workspacePath,
      pattern: input.pattern,
      path: searchPath,
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      literal: input.literal,
      caseSensitive: input.caseSensitive,
      include: input.include,
      context: input.context,
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

    const content = input.filesOnly
      ? formatGrepFilesOnly(matches, result.truncated)
      : formatGrepContent(matches, result.truncated)

    // Record reads for the line ranges the model actually saw.
    // Only when content is inlined (not spilled to file) and not files-only.
    if (!input.filesOnly && content.length <= INLINE_CONTENT_LIMIT && context.readRecordCache) {
      const fileRanges = new Map<string, Array<{ startLine: number; endLine: number }>>()
      for (const match of result.matches) {
        const absPath = isAbsolute(match.path) ? match.path : resolve(result.rootPath, match.path)
        const startLine = Math.max(1, match.line - (match.contextBefore?.length ?? 0))
        const endLine = match.line + (match.contextAfter?.length ?? 0)
        const existing = fileRanges.get(absPath)
        if (existing) {
          existing.push({ startLine, endLine })
        } else {
          fileRanges.set(absPath, [{ startLine, endLine }])
        }
      }
      for (const [absPath, ranges] of fileRanges) {
        const mtimeMs = await stat(absPath).then(
          (s) => s.mtimeMs,
          () => undefined
        )
        for (const range of ranges) {
          context.readRecordCache.recordRead(absPath, range.startLine, range.endLine, mtimeMs)
        }
      }
    }

    if (content.length > INLINE_CONTENT_LIMIT) {
      const saved = await spillToFile(context.workspacePath, content)
      return {
        content: textContent(
          `Output too large to inline (${matches.length} matches across ${new Set(matches.map((m) => m.path)).size} files). Full output saved to ${saved.relativePath}.\nUse the read tool to read it.`
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

  // Use standard path:line: text format (familiar to models from grep/rg output).
  // Group by file with blank lines between groups for readability.
  const hasContext = matches.some((m) => m.contextBefore?.length || m.contextAfter?.length)
  const groups = new Map<string, typeof matches>()
  for (const match of matches) {
    const existing = groups.get(match.path)
    if (existing) {
      existing.push(match)
    } else {
      groups.set(match.path, [match])
    }
  }

  const sections: string[] = []

  for (const [filePath, fileMatches] of groups) {
    const lines: string[] = []
    for (const match of fileMatches) {
      if (hasContext && match.contextBefore?.length) {
        for (let i = 0; i < match.contextBefore.length; i++) {
          const lineNum = match.line - match.contextBefore.length + i
          lines.push(`${filePath}:${lineNum}- ${match.contextBefore[i]}`)
        }
      }
      lines.push(`${filePath}:${match.line}: ${match.text}`)
      if (hasContext && match.contextAfter?.length) {
        for (let i = 0; i < match.contextAfter.length; i++) {
          lines.push(`${filePath}:${match.line + 1 + i}- ${match.contextAfter[i]}`)
        }
      }
    }
    sections.push(lines.join('\n'))
  }

  let output = sections.join('\n\n')
  if (truncated) {
    output += `\n\n[truncated — showing ${matches.length} matches. Use \`include\` to filter by file type or narrow your pattern.]`
  }
  return output
}

function formatGrepFilesOnly(matches: GrepToolCallDetails['matches'], truncated: boolean): string {
  if (matches.length === 0) {
    return 'No matches found.'
  }

  const uniquePaths = [...new Set(matches.map((m) => m.path))]
  let output = uniquePaths.join('\n')
  if (truncated) {
    output += `\n\n[truncated — ${uniquePaths.length} files shown. Narrow your pattern or use \`include\` to filter.]`
  }
  return output
}

async function spillToFile(
  workspacePath: string,
  content: string
): Promise<{ relativePath: string; absolutePath: string }> {
  const filename = `grep-${Date.now()}.txt`
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
