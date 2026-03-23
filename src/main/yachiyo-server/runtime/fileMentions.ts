import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import createIgnore, { type Ignore } from 'ignore'

import type { SearchService } from '../services/search/searchService.ts'

const FILE_MENTION_RE = /(^|\s)@(!?)([A-Za-z0-9._/-]+)/g
const MAX_FILE_MENTION_COUNT = 8
const DEFAULT_CANDIDATE_LIMIT = 8
const DEFAULT_INLINE_MAX_BYTES = 6_000
const DEFAULT_INLINE_MAX_LINES = 120

export interface ParsedFileMention {
  raw: string
  query: string
  includeIgnored?: boolean
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

interface WorkspaceIgnoreRule {
  basePath: string
  matcher: Ignore
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

  return normalizeRelativePath(relativePath)
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

function normalizeRelativePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function isIgnoredWorkspacePath(
  relativePath: string,
  rules: WorkspaceIgnoreRule[],
  includeIgnored: boolean | undefined
): boolean {
  if (includeIgnored) {
    return false
  }

  let ignored = false
  const normalizedPath = normalizeRelativePath(relativePath)
  for (const rule of rules) {
    const scopedPath = toScopedIgnorePath(normalizedPath, rule.basePath)
    if (!scopedPath) {
      continue
    }

    const result = rule.matcher.test(scopedPath)
    if (result.ignored) {
      ignored = true
    }
    if (result.unignored) {
      ignored = false
    }
  }

  return ignored
}

function toScopedIgnorePath(path: string, basePath: string): string | null {
  if (!basePath) {
    return path
  }

  if (path === basePath) {
    return basename(path)
  }

  if (!path.startsWith(`${basePath}/`)) {
    return null
  }

  return path.slice(basePath.length + 1)
}

function compareIgnoreRuleDepth(left: WorkspaceIgnoreRule, right: WorkspaceIgnoreRule): number {
  return left.basePath.split('/').length - right.basePath.split('/').length
}

async function loadWorkspaceIgnoreRules(workspacePath: string): Promise<WorkspaceIgnoreRule[]> {
  const rules: WorkspaceIgnoreRule[] = []

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])
    const gitignoreEntry = entries.find((entry) => entry.isFile() && entry.name === '.gitignore')
    if (gitignoreEntry) {
      const gitignorePath = join(currentPath, gitignoreEntry.name)
      const gitignoreContent = await readFile(gitignorePath, 'utf8').catch(() => null)

      if (gitignoreContent) {
        rules.push({
          basePath: toWorkspaceRelativePath(workspacePath, currentPath) ?? '',
          matcher: createIgnore().add(gitignoreContent)
        })
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') {
        continue
      }

      await visit(join(currentPath, entry.name))
    }
  }

  await visit(workspacePath)
  return rules.sort(compareIgnoreRuleDepth)
}

export function parseFileMentions(content: string): ParsedFileMention[] {
  const mentions: ParsedFileMention[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  FILE_MENTION_RE.lastIndex = 0
  while ((match = FILE_MENTION_RE.exec(content)) !== null) {
    const includeIgnored = match[2] === '!'
    const query = stripTrailingMentionPunctuation(match[3]?.trim() ?? '')
    const tokenEndIndex = match.index + match[0].length
    const nextCharacter = content[tokenEndIndex]
    const key = `${includeIgnored ? '!' : ''}${query}`

    if (!query || (query === 'skills' && nextCharacter === ':') || seen.has(key)) {
      continue
    }

    seen.add(key)
    mentions.push({
      raw: `@${includeIgnored ? '!' : ''}${query}`,
      query,
      ...(includeIgnored ? { includeIgnored: true } : {})
    })

    if (mentions.length >= MAX_FILE_MENTION_COUNT) {
      break
    }
  }

  return mentions
}

async function resolveExactWorkspaceFile(
  workspacePath: string,
  query: string,
  ignoreRules: WorkspaceIgnoreRule[],
  includeIgnored?: boolean
): Promise<string | null> {
  const targetPath = resolveWorkspaceBoundPath(workspacePath, query)
  if (!targetPath) {
    return null
  }
  const targetStat = await stat(targetPath).catch(() => null)

  if (!targetStat?.isFile()) {
    return null
  }

  const relativePath = toWorkspaceRelativePath(workspacePath, targetPath)
  if (!relativePath || isIgnoredWorkspacePath(relativePath, ignoreRules, includeIgnored)) {
    return null
  }

  return relativePath
}

async function isWorkspaceFile(workspacePath: string, candidatePath: string): Promise<boolean> {
  const absolutePath = resolve(workspacePath, candidatePath)
  const candidateStat = await stat(absolutePath).catch(() => null)
  return candidateStat?.isFile() ?? false
}

function buildGlobPatterns(query: string): string[] {
  const trimmed = normalizeRelativePath(query.trim())
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
  includeIgnored?: boolean
  limit?: number
}): Promise<string[]> {
  const ignoreRules = await loadWorkspaceIgnoreRules(input.workspacePath)
  const exactMatch = await resolveExactWorkspaceFile(
    input.workspacePath,
    input.query,
    ignoreRules,
    input.includeIgnored
  )
  const candidates = exactMatch ? [exactMatch] : []
  const candidateLimit = input.limit ?? DEFAULT_CANDIDATE_LIMIT

  if (input.includeIgnored) {
    const matcherList = buildGlobPatterns(input.query).map(createGlobMatcher)
    const workspaceFiles = await findWorkspaceFilesByGlob(
      input.workspacePath,
      matcherList,
      candidateLimit
    )

    for (const filePath of workspaceFiles) {
      const relativePath = toWorkspaceRelativePath(input.workspacePath, filePath)
      if (!relativePath || candidates.includes(relativePath)) {
        continue
      }
      if (!matcherList.some((matcher) => matcher(relativePath))) {
        continue
      }

      candidates.push(relativePath)
      if (candidates.length >= candidateLimit) {
        break
      }
    }

    return candidates.slice(0, candidateLimit)
  }

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
      if (isIgnoredWorkspacePath(normalizedPath, ignoreRules, input.includeIgnored)) {
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

async function findWorkspaceFilesByGlob(
  workspacePath: string,
  matchers: Array<(value: string) => boolean>,
  limit: number
): Promise<string[]> {
  const results: string[] = []

  async function visit(currentPath: string): Promise<void> {
    if (results.length >= limit) {
      return
    }

    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git') {
        continue
      }

      const entryPath = join(currentPath, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
      } else if (entry.isFile()) {
        const relativePath = toWorkspaceRelativePath(workspacePath, entryPath)
        if (relativePath && matchers.some((matcher) => matcher(relativePath))) {
          results.push(entryPath)
        }
      }

      if (results.length >= limit) {
        return
      }
    }
  }

  await visit(workspacePath)
  return results
}

function createGlobMatcher(pattern: string): (value: string) => boolean {
  const regex = globPatternToRegExp(pattern)
  return (value: string): boolean => regex.test(value)
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalizedPattern = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  let source = '^'

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index]
    const next = normalizedPattern[index + 1]

    if (char === '*' && next === '*') {
      const nextNext = normalizedPattern[index + 2]
      source += nextNext === '/' ? '(?:.*/)?' : '.*'
      index += nextNext === '/' ? 2 : 1
      continue
    }

    if (char === '*') {
      source += '[^/]*'
      continue
    }

    if (char === '?') {
      source += '[^/]'
      continue
    }

    source += /[|\\{}()[\]^$+*?.]/.test(char) ? `\\${char}` : char
  }

  source += '$'
  return new RegExp(source)
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
  const ignoreRules = await loadWorkspaceIgnoreRules(input.workspacePath)

  for (const mention of parsedMentions) {
    const exactMatch = await resolveExactWorkspaceFile(
      input.workspacePath,
      mention.query,
      ignoreRules,
      mention.includeIgnored
    )
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
      includeIgnored: mention.includeIgnored,
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
