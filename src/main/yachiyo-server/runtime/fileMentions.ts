import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import type { SearchService } from '../services/search/searchService.ts'

const FILE_MENTION_RE = /(^|\s)@([A-Za-z0-9._/-]+)/g
const MAX_FILE_MENTION_COUNT = 8
const DEFAULT_CANDIDATE_LIMIT = 8
const DEFAULT_INLINE_MAX_BYTES = 6_000
const DEFAULT_INLINE_MAX_LINES = 120

export interface ParsedFileMention {
  raw: string
  query: string
}

export interface ResolvedFileMention {
  raw: string
  query: string
  kind: 'resolved' | 'ambiguous' | 'missing'
  resolvedPath?: string
  candidatePaths: string[]
}

export interface FileMentionResolution {
  mentions: ResolvedFileMention[]
  augmentedUserQuery: string
  inlinedPath?: string
}

function stripTrailingMentionPunctuation(value: string): string {
  return value.replace(/[.,!?;:)\]]+$/g, '')
}

function toWorkspaceRelativePath(workspacePath: string, targetPath: string): string | undefined {
  const relativePath = relative(resolve(workspacePath), resolve(targetPath))
  if (!relativePath) {
    return undefined
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined
  }

  return relativePath
}

function resolveWorkspaceBoundPath(workspacePath: string, targetPath: string): string | undefined {
  const resolvedWorkspacePath = resolve(workspacePath)
  const resolvedTargetPath = resolve(resolvedWorkspacePath, targetPath)
  const relativePath = relative(resolvedWorkspacePath, resolvedTargetPath)

  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined
  }

  return resolvedTargetPath
}

function toUnique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function parseFileMentions(content: string): ParsedFileMention[] {
  const mentions: ParsedFileMention[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  FILE_MENTION_RE.lastIndex = 0
  while ((match = FILE_MENTION_RE.exec(content)) !== null) {
    const query = stripTrailingMentionPunctuation(match[2]?.trim() ?? '')
    const tokenEndIndex = match.index + match[0].length
    const nextCharacter = content[tokenEndIndex]

    if (!query || (query === 'skills' && nextCharacter === ':') || seen.has(query)) {
      continue
    }

    seen.add(query)
    mentions.push({
      raw: `@${query}`,
      query
    })

    if (mentions.length >= MAX_FILE_MENTION_COUNT) {
      break
    }
  }

  return mentions
}

async function resolveExactWorkspaceFile(
  workspacePath: string,
  query: string
): Promise<string | null> {
  const targetPath = resolveWorkspaceBoundPath(workspacePath, query)
  if (!targetPath) {
    return null
  }
  const targetStat = await stat(targetPath).catch(() => null)

  if (!targetStat?.isFile()) {
    return null
  }

  return toWorkspaceRelativePath(workspacePath, targetPath) ?? null
}

async function isWorkspaceFile(workspacePath: string, candidatePath: string): Promise<boolean> {
  const absolutePath = resolve(workspacePath, candidatePath)
  const candidateStat = await stat(absolutePath).catch(() => null)
  return candidateStat?.isFile() ?? false
}

function buildGlobPatterns(query: string): string[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return ['**/*']
  }

  const basePatterns = [trimmed, `${trimmed}*`, `**/${trimmed}`, `**/${trimmed}*`]

  const name = basename(trimmed)
  if (name !== trimmed) {
    basePatterns.push(`**/${name}`, `**/${name}*`)
  }

  return toUnique(basePatterns)
}

export async function searchWorkspaceFileMentionCandidates(input: {
  query: string
  workspacePath: string
  searchService: SearchService
  limit?: number
}): Promise<string[]> {
  const exactMatch = await resolveExactWorkspaceFile(input.workspacePath, input.query)
  const candidates = exactMatch ? [exactMatch] : []
  const candidateLimit = input.limit ?? DEFAULT_CANDIDATE_LIMIT

  for (const pattern of buildGlobPatterns(input.query)) {
    if (candidates.length >= candidateLimit) {
      break
    }

    const result = await input.searchService.glob({
      cwd: input.workspacePath,
      pattern,
      path: '.',
      limit: candidateLimit
    })

    for (const path of result.paths) {
      const normalizedPath = toWorkspaceRelativePath(
        input.workspacePath,
        resolve(input.workspacePath, path)
      )
      if (!normalizedPath) {
        continue
      }
      if (!(await isWorkspaceFile(input.workspacePath, normalizedPath))) {
        continue
      }
      if (!candidates.includes(normalizedPath)) {
        candidates.push(normalizedPath)
      }

      if (candidates.length >= candidateLimit) {
        break
      }
    }
  }

  return candidates.slice(0, candidateLimit)
}

async function maybeInlineResolvedFile(input: {
  mention: ResolvedFileMention
  workspacePath: string
  maxBytes?: number
  maxLines?: number
}): Promise<{ path: string; content: string } | null> {
  if (input.mention.kind !== 'resolved' || !input.mention.resolvedPath) {
    return null
  }

  const absolutePath = resolve(input.workspacePath, input.mention.resolvedPath)
  const fileStat = await stat(absolutePath).catch(() => null)
  const maxBytes = input.maxBytes ?? DEFAULT_INLINE_MAX_BYTES
  const maxLines = input.maxLines ?? DEFAULT_INLINE_MAX_LINES

  if (!fileStat?.isFile() || fileStat.size > maxBytes) {
    return null
  }

  const content = await readFile(absolutePath, 'utf8').catch(() => null)
  if (content === null) {
    return null
  }

  const lineCount = content.split(/\r?\n/).length
  if (lineCount > maxLines) {
    return null
  }

  return {
    path: input.mention.resolvedPath,
    content: content.trimEnd()
  }
}

function buildHiddenReferenceBlock(input: {
  mentions: ResolvedFileMention[]
  inlinedFile?: { path: string; content: string } | null
}): string {
  const lines = ['<file_mentions>']

  for (const mention of input.mentions) {
    if (mention.kind === 'resolved' && mention.resolvedPath) {
      lines.push(`- ${mention.raw} -> ${mention.resolvedPath}`)
      continue
    }

    if (mention.kind === 'ambiguous') {
      lines.push(`- ${mention.raw} -> ambiguous: ${mention.candidatePaths.join(', ')}`)
      continue
    }

    lines.push(`- ${mention.raw} -> unresolved`)
  }

  lines.push('</file_mentions>')

  if (!input.inlinedFile) {
    return lines.join('\n')
  }

  return [
    lines.join('\n'),
    '',
    `<referenced_file path="${input.inlinedFile.path}">`,
    input.inlinedFile.content,
    '</referenced_file>'
  ].join('\n')
}

export async function resolveFileMentionsForUserQuery(input: {
  content: string
  workspacePath: string
  searchService?: SearchService
}): Promise<FileMentionResolution> {
  const parsedMentions = parseFileMentions(input.content)
  if (parsedMentions.length === 0) {
    return {
      mentions: [],
      augmentedUserQuery: input.content
    }
  }

  const mentions: ResolvedFileMention[] = []

  for (const mention of parsedMentions) {
    const exactMatch = await resolveExactWorkspaceFile(input.workspacePath, mention.query)
    if (exactMatch) {
      mentions.push({
        ...mention,
        kind: 'resolved',
        resolvedPath: exactMatch,
        candidatePaths: [exactMatch]
      })
      continue
    }

    if (!input.searchService) {
      mentions.push({
        ...mention,
        kind: 'missing',
        candidatePaths: []
      })
      continue
    }

    const candidates = await searchWorkspaceFileMentionCandidates({
      query: mention.query,
      workspacePath: input.workspacePath,
      searchService: input.searchService
    })

    if (candidates.length === 1) {
      mentions.push({
        ...mention,
        kind: 'resolved',
        resolvedPath: candidates[0],
        candidatePaths: candidates
      })
      continue
    }

    mentions.push({
      ...mention,
      kind: candidates.length > 1 ? 'ambiguous' : 'missing',
      candidatePaths: candidates
    })
  }

  const resolvedMentions = mentions.filter((mention) => mention.kind === 'resolved')
  const inlinedFile =
    resolvedMentions.length === 1 && mentions.length === 1
      ? await maybeInlineResolvedFile({
          mention: resolvedMentions[0],
          workspacePath: input.workspacePath
        })
      : null

  return {
    mentions,
    inlinedPath: inlinedFile?.path,
    augmentedUserQuery: [
      buildHiddenReferenceBlock({
        mentions,
        ...(inlinedFile ? { inlinedFile } : {})
      }),
      '',
      input.content
    ].join('\n')
  }
}
