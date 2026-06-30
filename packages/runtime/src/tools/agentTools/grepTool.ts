import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { tool, type Tool } from 'ai'

import type { GrepToolCallDetails } from '@yachiyo/shared/protocol'
import type { SearchService } from '../../services/search/searchService.ts'
import {
  DEFAULT_SEARCH_LIMIT,
  FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE,
  grepToolInputSchema,
  isForbiddenHugeSearchRoot,
  resolveSearchToolTargets,
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
  '• `pattern`: Regular expression. Use `literal: true` for exact fixed-string matching.\n' +
  '• `path`: file/directory to search. Multiple existing roots may be separated by spaces; an existing path containing spaces stays one root.\n' +
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
  const targets = await resolveSearchToolTargets(context.workspacePath, input.path?.trim() || '.')
  const resolvedPath = formatResolvedTargetPath(targets.map((target) => target.resolvedPath))
  const fallbackDetails: GrepToolCallDetails = {
    backend: dependencies.searchService.capabilities.grep.available,
    pattern: input.pattern,
    path: resolvedPath,
    resultCount: 0,
    truncated: false,
    matches: []
  }

  if (
    targets.some((target) => isForbiddenHugeSearchRoot(target.resolvedPath, context.workspacePath))
  ) {
    return {
      content: textContent(FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE),
      details: fallbackDetails,
      error: FORBIDDEN_HUGE_SEARCH_ROOT_MESSAGE,
      metadata: {}
    }
  }

  try {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const matches: GrepToolCallDetails['matches'] = []
    const readPaths = new Set<string>()
    let backend = dependencies.searchService.capabilities.grep.available
    let truncated = false

    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]!
      const remaining = limit - matches.length
      if (remaining <= 0) {
        truncated = true
        break
      }

      const result = await dependencies.searchService.grep({
        cwd: context.workspacePath,
        pattern: input.pattern,
        path: target.searchPath,
        limit: remaining,
        literal: input.literal,
        caseSensitive: input.caseSensitive,
        include: input.include,
        context: input.context,
        signal: dependencies.abortSignal
      })
      backend = result.backend
      truncated =
        truncated ||
        result.truncated ||
        (matches.length + result.matches.length >= limit && index < targets.length - 1)

      for (const match of result.matches) {
        matches.push({
          ...match,
          path: toWorkspaceDisplayPath(context.workspacePath, result.rootPath, match.path)
        })
        const absPath = isAbsolute(match.path) ? match.path : resolve(result.rootPath, match.path)
        readPaths.add(absPath)
      }
    }

    const details: GrepToolCallDetails = {
      backend,
      pattern: input.pattern,
      path: resolvedPath,
      resultCount: matches.length,
      truncated,
      matches
    }

    const content = input.filesOnly
      ? formatGrepFilesOnly(matches, truncated)
      : formatGrepContent(matches, truncated)

    // Record files whose matching content the model actually saw.
    // Only when content is inlined (not spilled to file) and not files-only.
    if (!input.filesOnly && content.length <= INLINE_CONTENT_LIMIT && context.readRecordCache) {
      for (const absPath of readPaths) {
        const mtimeMs = await stat(absPath).then(
          (s) => s.mtimeMs,
          () => undefined
        )
        context.readRecordCache.recordRead(absPath, 1, 1, mtimeMs)
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

  const sections: string[] = [
    `Found ${matches.length} ${plural(matches.length, 'match', 'matches')} in ${groups.size} ${plural(groups.size, 'file', 'files')}.`
  ]

  for (const [filePath, fileMatches] of groups) {
    const lines: string[] = [filePath]
    for (const match of fileMatches) {
      if (hasContext && match.contextBefore?.length) {
        for (let i = 0; i < match.contextBefore.length; i++) {
          const lineNum = match.line - match.contextBefore.length + i
          lines.push(`  ${lineNum}- ${match.contextBefore[i]}`)
        }
      }
      lines.push(`  ${match.line}: ${match.text}`)
      if (hasContext && match.contextAfter?.length) {
        for (let i = 0; i < match.contextAfter.length; i++) {
          lines.push(`  ${match.line + 1 + i}- ${match.contextAfter[i]}`)
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
  let output = [
    `Found ${uniquePaths.length} ${plural(uniquePaths.length, 'file', 'files')} with matches.`,
    '',
    ...uniquePaths.map((path) => `- ${path}`)
  ].join('\n')
  if (truncated) {
    output += `\n\n[truncated — ${uniquePaths.length} files shown. Narrow your pattern or use \`include\` to filter.]`
  }
  return output
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm
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

function formatResolvedTargetPath(paths: string[]): string {
  return paths.join('\n')
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
