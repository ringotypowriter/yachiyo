import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import createIgnore, { type Ignore } from 'ignore'
import { matchSorter } from 'match-sorter'

import type { SearchService } from '../services/search/searchService.ts'

const FILE_MENTION_RE = /(^|\s)@(!?)(?:"([^"]+)"|([\p{L}\p{N}\p{M}._/-]+))/gu
const MAX_FILE_MENTION_COUNT = 8
const DEFAULT_CANDIDATE_LIMIT = 8
const DEFAULT_INLINE_MAX_BYTES = 6_000
const DEFAULT_INLINE_MAX_LINES = 120
const DEFAULT_INLINE_MAX_DIRECTORY_BYTES = 4_000
const DEFAULT_INLINE_MAX_DIRECTORY_ENTRIES = 80
const DEFAULT_FUZZY_SCAN_MAX_DIRECTORIES = 200
const DEFAULT_FUZZY_SCAN_MAX_CANDIDATES = 32

export interface ParsedFileMention {
  raw: string
  query: string
  includeIgnored?: boolean
}

export interface ResolvedFileMention {
  raw: string
  query: string
  includeIgnored?: boolean
  kind: 'resolved' | 'ambiguous' | 'missing'
  resolvedPath?: string
  resolvedKind?: 'file' | 'directory'
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

const WORKSPACE_IGNORE_CACHE_TTL_MS = 5_000
const workspaceIgnoreCache = new Map<string, { rules: WorkspaceIgnoreRule[]; timestamp: number }>()

export function clearWorkspaceIgnoreCache(): void {
  workspaceIgnoreCache.clear()
}

async function loadWorkspaceIgnoreRules(workspacePath: string): Promise<WorkspaceIgnoreRule[]> {
  const resolvedWorkspacePath = resolve(workspacePath)
  const cached = workspaceIgnoreCache.get(resolvedWorkspacePath)
  if (cached && Date.now() - cached.timestamp < WORKSPACE_IGNORE_CACHE_TTL_MS) {
    return cached.rules
  }

  const rules: WorkspaceIgnoreRule[] = []

  async function visit(currentPath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true }).catch(() => [])
    const gitignoreEntry = entries.find((entry) => entry.isFile() && entry.name === '.gitignore')
    if (gitignoreEntry) {
      const gitignorePath = join(currentPath, gitignoreEntry.name)
      const gitignoreContent = await readFile(gitignorePath, 'utf8').catch(() => null)

      if (gitignoreContent) {
        rules.push({
          basePath: toWorkspaceRelativePath(resolvedWorkspacePath, currentPath) ?? '',
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

  await visit(resolvedWorkspacePath)
  const sortedRules = rules.sort(compareIgnoreRuleDepth)
  workspaceIgnoreCache.set(resolvedWorkspacePath, { rules: sortedRules, timestamp: Date.now() })
  return sortedRules
}

function resolveScopedPathQuery(
  workspacePath: string,
  query: string
): { relativeRootPath: string; rootPath: string; scopedQuery: string } | null {
  const normalizedQuery = normalizeRelativePath(query.trim())
  if (!normalizedQuery.includes('/')) {
    return null
  }

  const trailingSlash = normalizedQuery.endsWith('/')
  const trimmedQuery = trailingSlash ? normalizedQuery.slice(0, -1) : normalizedQuery
  if (!trimmedQuery) {
    return null
  }

  const lastSlashIndex = trimmedQuery.lastIndexOf('/')
  const relativeRootPath = trailingSlash ? trimmedQuery : trimmedQuery.slice(0, lastSlashIndex)
  const scopedQuery = trailingSlash ? '' : trimmedQuery.slice(lastSlashIndex + 1)
  if (!relativeRootPath) {
    return null
  }

  const rootPath = resolveWorkspaceBoundPath(workspacePath, relativeRootPath)
  if (!rootPath) {
    return null
  }

  return { relativeRootPath, rootPath, scopedQuery }
}

export function parseFileMentions(content: string): ParsedFileMention[] {
  const mentions: ParsedFileMention[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null

  FILE_MENTION_RE.lastIndex = 0
  while ((match = FILE_MENTION_RE.exec(content)) !== null) {
    const includeIgnored = match[2] === '!'
    const isQuoted = match[3] != null
    const rawPath = isQuoted ? match[3] : (match[4] ?? '')
    const query = isQuoted ? rawPath.trim() : stripTrailingMentionPunctuation(rawPath.trim())
    const tokenEndIndex = match.index + match[0].length
    const nextCharacter = content[tokenEndIndex]
    const key = `${includeIgnored ? '!' : ''}${query}`

    if (!query || (query === 'skills' && nextCharacter === ':') || seen.has(key)) {
      continue
    }

    seen.add(key)
    const bang = includeIgnored ? '!' : ''
    mentions.push({
      raw: isQuoted ? `@${bang}"${query}"` : `@${bang}${query}`,
      query,
      ...(includeIgnored ? { includeIgnored: true } : {})
    })

    if (mentions.length >= MAX_FILE_MENTION_COUNT) {
      break
    }
  }

  return mentions
}

async function resolveExactWorkspacePath(
  workspacePath: string,
  query: string,
  ignoreRules: WorkspaceIgnoreRule[],
  includeIgnored?: boolean
): Promise<{ path: string; kind: 'file' | 'directory' } | null> {
  const targetPath = resolveWorkspaceBoundPath(workspacePath, query)
  if (!targetPath) {
    return null
  }
  const targetStat = await stat(targetPath).catch(() => null)

  if (!targetStat || (!targetStat.isFile() && !targetStat.isDirectory())) {
    return null
  }

  const relativePath = toWorkspaceRelativePath(workspacePath, targetPath)
  if (!relativePath || isIgnoredWorkspacePath(relativePath, ignoreRules, includeIgnored)) {
    return null
  }

  return {
    path: relativePath,
    kind: targetStat.isDirectory() ? 'directory' : 'file'
  }
}

async function isWorkspaceFile(workspacePath: string, candidatePath: string): Promise<boolean> {
  const absolutePath = resolve(workspacePath, candidatePath)
  const candidateStat = await stat(absolutePath).catch(() => null)
  return candidateStat?.isFile() ?? false
}

async function resolveWorkspacePathKind(
  workspacePath: string,
  candidatePath: string
): Promise<'file' | 'directory' | null> {
  const absolutePath = resolveWorkspaceBoundPath(workspacePath, candidatePath)
  if (!absolutePath) {
    return null
  }

  const candidateStat = await stat(absolutePath).catch(() => null)
  if (!candidateStat) {
    return null
  }

  if (candidateStat.isDirectory()) {
    return 'directory'
  }

  if (candidateStat.isFile()) {
    return 'file'
  }

  return null
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

async function searchWorkspacePathsByGlob(input: {
  query: string
  workspacePath: string
  searchService: SearchService
  includeIgnored?: boolean
  scopedPathQuery?: { relativeRootPath: string; rootPath: string; scopedQuery: string } | null
  limit: number
}): Promise<string[]> {
  const searchRootPath = input.scopedPathQuery?.rootPath ?? input.workspacePath
  const searchPath = input.scopedPathQuery?.relativeRootPath ?? '.'
  const effectiveQuery = input.scopedPathQuery?.scopedQuery ?? input.query

  if (input.includeIgnored) {
    const matcherList = buildGlobPatterns(effectiveQuery).map(createGlobMatcher)
    const workspaceFiles = await findWorkspaceFilesByGlob(
      searchRootPath,
      matcherList,
      input.limit,
      searchRootPath
    )

    return workspaceFiles
      .map((filePath) => toWorkspaceRelativePath(input.workspacePath, filePath))
      .filter((relativePath): relativePath is string => Boolean(relativePath))
  }

  const candidates: string[] = []
  for (const pattern of buildGlobPatterns(effectiveQuery)) {
    if (candidates.length >= input.limit) {
      break
    }

    const result = await input.searchService.glob({
      cwd: input.workspacePath,
      pattern,
      path: searchPath,
      limit: input.limit
    })

    for (const path of result.paths) {
      const normalizedPath = toWorkspaceRelativePath(
        input.workspacePath,
        resolve(searchRootPath, path)
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

      if (candidates.length >= input.limit) {
        break
      }
    }
  }

  return candidates
}

async function searchWorkspaceFuzzyCandidates(input: {
  query: string
  workspacePath: string
  ignoreRules: WorkspaceIgnoreRule[]
  includeIgnored?: boolean
  scopedPathQuery?: { relativeRootPath: string; rootPath: string; scopedQuery: string } | null
  limit: number
}): Promise<string[]> {
  const candidates: string[] = []
  const scopedRootPath = input.scopedPathQuery?.rootPath ?? input.workspacePath
  const scopedRootRelativePath = input.scopedPathQuery?.relativeRootPath
  const queryForScoring = input.scopedPathQuery?.scopedQuery || input.query
  const queue: Array<{ path: string; score: number }> = [{ path: scopedRootPath, score: 0 }]
  const maxDirectories = DEFAULT_FUZZY_SCAN_MAX_DIRECTORIES
  const maxCandidates = Math.max(input.limit * 4, DEFAULT_FUZZY_SCAN_MAX_CANDIDATES)
  let visitedDirectories = 0

  while (
    queue.length > 0 &&
    visitedDirectories < maxDirectories &&
    candidates.length < maxCandidates
  ) {
    queue.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    const current = queue.shift()
    if (!current) {
      break
    }

    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => [])
    visitedDirectories += 1

    for (const entry of entries) {
      if (entry.name === '.git') {
        continue
      }

      const entryPath = join(current.path, entry.name)
      const relativePath = toWorkspaceRelativePath(input.workspacePath, entryPath)
      if (!relativePath) {
        continue
      }

      if (isIgnoredWorkspacePath(relativePath, input.ignoreRules, input.includeIgnored)) {
        continue
      }

      const scopedRelativePath = scopedRootRelativePath
        ? relativePath.startsWith(`${scopedRootRelativePath}/`)
          ? relativePath.slice(scopedRootRelativePath.length + 1)
          : relativePath === scopedRootRelativePath
            ? ''
            : relativePath
        : relativePath
      const score = scoreWorkspaceFileMentionCandidate(queryForScoring, scopedRelativePath)
      if (score !== null && !candidates.includes(relativePath)) {
        candidates.push(relativePath)
        if (candidates.length >= maxCandidates) {
          break
        }
      }

      if (entry.isDirectory()) {
        queue.push({
          path: entryPath,
          score: score ?? scoreFuzzySubstring(basename(queryForScoring), entry.name) ?? 0
        })
      }
    }
  }

  return candidates
}

function scoreFuzzySubstring(query: string, target: string): number | null {
  const exactIndex = target.indexOf(query)
  if (exactIndex >= 0) {
    return 9_000 - exactIndex * 40 - (target.length - query.length)
  }

  const positions: number[] = []
  let searchIndex = 0
  for (const char of query) {
    const foundIndex = target.indexOf(char, searchIndex)
    if (foundIndex < 0) {
      return null
    }
    positions.push(foundIndex)
    searchIndex = foundIndex + 1
  }

  const start = positions[0] ?? 0
  const end = positions[positions.length - 1] ?? start
  const span = end - start + 1
  let consecutiveMatches = 0
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] === positions[index - 1] + 1) {
      consecutiveMatches += 1
    }
  }

  return (
    6_000 -
    start * 30 -
    (span - query.length) * 20 -
    (target.length - query.length) * 3 +
    consecutiveMatches * 35
  )
}

function scoreFuzzySegments(query: string, candidatePath: string): number | null {
  const querySegments = query.split('/').filter(Boolean)
  if (querySegments.length < 2) {
    return null
  }

  const candidateSegments = candidatePath.split('/')
  let nextCandidateIndex = 0
  let totalScore = 0
  let firstMatchIndex = -1
  let lastMatchIndex = -1

  for (const querySegment of querySegments) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY
    for (let index = nextCandidateIndex; index < candidateSegments.length; index += 1) {
      const segmentScore = scoreFuzzySubstring(querySegment, candidateSegments[index])
      if (segmentScore === null || segmentScore <= bestScore) {
        continue
      }

      bestIndex = index
      bestScore = segmentScore
    }

    if (bestIndex < 0) {
      return null
    }

    if (firstMatchIndex < 0) {
      firstMatchIndex = bestIndex
    }
    lastMatchIndex = bestIndex
    totalScore += bestScore
    nextCandidateIndex = bestIndex + 1
  }

  const skippedSegments =
    firstMatchIndex >= 0 && lastMatchIndex >= 0
      ? lastMatchIndex - firstMatchIndex + 1 - querySegments.length
      : 0

  return totalScore + 2_500 - firstMatchIndex * 80 - skippedSegments * 120
}

function scoreTightFuzzySegment(query: string, target: string): number | null {
  if (!query) {
    return null
  }

  if (target === query) {
    return 24_000 - target.length
  }

  if (target.startsWith(query)) {
    return 20_000 - (target.length - query.length) * 40
  }

  const substringIndex = target.indexOf(query)
  if (substringIndex >= 0) {
    return 16_000 - substringIndex * 140 - (target.length - query.length) * 20
  }

  const positions: number[] = []
  let searchIndex = 0
  for (const char of query) {
    const foundIndex = target.indexOf(char, searchIndex)
    if (foundIndex < 0) {
      return null
    }

    positions.push(foundIndex)
    searchIndex = foundIndex + 1
  }

  const start = positions[0] ?? 0
  const end = positions[positions.length - 1] ?? start
  const extraSpan = end - start + 1 - query.length
  const allowedExtraSpan = Math.max(1, Math.floor(query.length / 3))
  if (start > 0 || extraSpan > allowedExtraSpan) {
    return null
  }

  let consecutiveMatches = 0
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index] === positions[index - 1] + 1) {
      consecutiveMatches += 1
    }
  }

  return 12_000 - extraSpan * 80 - (target.length - query.length) * 6 + consecutiveMatches * 30
}

function scoreStructuredPathQuery(query: string, candidatePath: string): number | null {
  const querySegments = query.split('/').filter(Boolean)
  if (querySegments.length < 2) {
    return null
  }

  const candidateSegments = candidatePath.split('/').filter(Boolean)
  if (candidateSegments.length < querySegments.length) {
    return null
  }

  let bestScore: number | null = null
  const lastStartIndex = candidateSegments.length - querySegments.length
  for (let startIndex = 0; startIndex <= lastStartIndex; startIndex += 1) {
    let totalScore = 0
    let matched = true

    for (let index = 0; index < querySegments.length; index += 1) {
      const segmentScore = scoreTightFuzzySegment(
        querySegments[index],
        candidateSegments[startIndex + index]
      )
      if (segmentScore === null) {
        matched = false
        break
      }

      totalScore += segmentScore
    }

    if (!matched) {
      continue
    }

    const score =
      totalScore +
      30_000 -
      startIndex * 200 -
      (candidateSegments.length - querySegments.length - startIndex) * 120

    if (bestScore === null || score > bestScore) {
      bestScore = score
    }
  }

  return bestScore
}

function scoreWorkspaceFileMentionCandidate(query: string, candidatePath: string): number | null {
  const normalizedQuery = normalizeRelativePath(query.trim()).toLowerCase()
  const normalizedCandidate = normalizeRelativePath(candidatePath).toLowerCase()

  if (!normalizedQuery) {
    return 0
  }

  if (normalizedCandidate === normalizedQuery) {
    return 100_000 - normalizedCandidate.length
  }

  if (normalizedQuery.includes('/')) {
    const pathScores = [
      scoreStructuredPathQuery(normalizedQuery, normalizedCandidate),
      scoreFuzzySegments(normalizedQuery, normalizedCandidate)
    ].filter((value): value is number => value !== null)

    if (pathScores.length === 0) {
      return null
    }

    return Math.max(...pathScores)
  }

  const basenameScore = scoreFuzzySubstring(
    basename(normalizedQuery),
    basename(normalizedCandidate)
  )
  const pathScore = scoreFuzzySubstring(normalizedQuery, normalizedCandidate)
  const segmentScore = scoreFuzzySegments(normalizedQuery, normalizedCandidate)
  const scores = [
    basenameScore === null ? null : basenameScore + 2_000,
    pathScore,
    segmentScore
  ].filter((value): value is number => value !== null)

  if (scores.length === 0) {
    return null
  }

  return Math.max(...scores)
}

function rankWorkspaceFileMentionCandidates(
  query: string,
  candidatePaths: string[],
  limit: number
): string[] {
  if (!query.trim()) {
    return candidatePaths.slice(0, limit)
  }

  const normalizedQuery = normalizeRelativePath(query.trim()).toLowerCase()
  const matcherQuery = normalizedQuery.includes('/')
    ? normalizeFileMentionMatcherValue(normalizedQuery)
    : normalizedQuery

  return matchSorter(toUnique(candidatePaths), matcherQuery, {
    keys: normalizedQuery.includes('/')
      ? [
          (candidatePath) => normalizeFileMentionMatcherValue(candidatePath),
          (candidatePath) => candidatePath
        ]
      : [
          (candidatePath) => basename(candidatePath),
          (candidatePath) => normalizeFileMentionMatcherValue(basename(candidatePath)),
          (candidatePath) => candidatePath,
          (candidatePath) => normalizeFileMentionMatcherValue(candidatePath)
        ],
    baseSort: (left, right) =>
      left.item.length - right.item.length || left.item.localeCompare(right.item)
  }).slice(0, limit)
}

function normalizeFileMentionMatcherValue(value: string): string {
  return normalizeRelativePath(value)
    .toLowerCase()
    .replace(/[./_-]+/g, ' ')
}

export async function searchWorkspaceFileMentionCandidates(input: {
  query: string
  workspacePath: string
  searchService: SearchService
  includeIgnored?: boolean
  limit?: number
}): Promise<string[]> {
  const ignoreRules = input.includeIgnored
    ? []
    : await loadWorkspaceIgnoreRules(input.workspacePath)
  const normalizedQuery = normalizeRelativePath(input.query.trim())
  const tentativeScopedPathQuery = resolveScopedPathQuery(input.workspacePath, normalizedQuery)
  const scopedPathQuery =
    tentativeScopedPathQuery &&
    (await resolveWorkspacePathKind(
      input.workspacePath,
      tentativeScopedPathQuery.relativeRootPath
    )) === 'directory'
      ? tentativeScopedPathQuery
      : null
  const exactMatch = await resolveExactWorkspacePath(
    input.workspacePath,
    normalizedQuery,
    ignoreRules,
    input.includeIgnored
  )
  const candidates = exactMatch ? [exactMatch.path] : []
  const candidateLimit = input.limit ?? DEFAULT_CANDIDATE_LIMIT

  if (!normalizedQuery) {
    if (input.includeIgnored) {
      const matcherList = buildGlobPatterns(normalizedQuery).map(createGlobMatcher)
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

    for (const pattern of buildGlobPatterns(normalizedQuery)) {
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

  const matchedPaths = await searchWorkspacePathsByGlob({
    query: normalizedQuery,
    workspacePath: input.workspacePath,
    searchService: input.searchService,
    includeIgnored: input.includeIgnored,
    scopedPathQuery,
    limit: candidateLimit
  })
  for (const candidatePath of matchedPaths) {
    if (isIgnoredWorkspacePath(candidatePath, ignoreRules, input.includeIgnored)) {
      continue
    }
    if (!candidates.includes(candidatePath)) {
      candidates.push(candidatePath)
    }
  }

  if (candidates.length >= candidateLimit) {
    return candidates.slice(0, candidateLimit)
  }

  const fuzzyCandidates = await searchWorkspaceFuzzyCandidates({
    query: normalizedQuery,
    workspacePath: input.workspacePath,
    ignoreRules,
    includeIgnored: input.includeIgnored,
    scopedPathQuery,
    limit: candidateLimit
  })

  return rankWorkspaceFileMentionCandidates(
    normalizedQuery,
    [...candidates, ...fuzzyCandidates],
    candidateLimit
  )
}

async function findWorkspaceFilesByGlob(
  workspacePath: string,
  matchers: Array<(value: string) => boolean>,
  limit: number,
  relativeBasePath?: string
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
        const matcherPath =
          relativePath && relativeBasePath
            ? toWorkspaceRelativePath(relativeBasePath, entryPath)
            : relativePath
        if (relativePath && matcherPath && matchers.some((matcher) => matcher(matcherPath))) {
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
  if (
    input.mention.kind !== 'resolved' ||
    input.mention.resolvedKind !== 'file' ||
    !input.mention.resolvedPath
  ) {
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

async function maybeInlineResolvedDirectory(input: {
  mention: ResolvedFileMention
  workspacePath: string
  ignoreRules: WorkspaceIgnoreRule[]
  maxBytes?: number
  maxEntries?: number
}): Promise<{ path: string; content: string } | null> {
  if (
    input.mention.kind !== 'resolved' ||
    input.mention.resolvedKind !== 'directory' ||
    !input.mention.resolvedPath
  ) {
    return null
  }

  const absolutePath = resolve(input.workspacePath, input.mention.resolvedPath)
  const directoryEntries = await readdir(absolutePath, { withFileTypes: true }).catch(() => null)
  if (!directoryEntries) {
    return null
  }

  const maxBytes = input.maxBytes ?? DEFAULT_INLINE_MAX_DIRECTORY_BYTES
  const maxEntries = input.maxEntries ?? DEFAULT_INLINE_MAX_DIRECTORY_ENTRIES

  const lines = directoryEntries
    .filter((entry) => entry.name !== '.git')
    .filter((entry) => input.mention.includeIgnored || !entry.name.startsWith('.'))
    .map((entry) => {
      const childRelativePath = toWorkspaceRelativePath(
        input.workspacePath,
        join(absolutePath, entry.name)
      )
      if (!childRelativePath) {
        return null
      }

      if (
        isIgnoredWorkspacePath(childRelativePath, input.ignoreRules, input.mention.includeIgnored)
      ) {
        return null
      }

      if (entry.isDirectory()) {
        return `${entry.name}/`
      }

      if (entry.isFile()) {
        return entry.name
      }

      return null
    })
    .filter((line): line is string => line !== null)
    .sort((left, right) => left.localeCompare(right))

  if (lines.length === 0) {
    return {
      path: input.mention.resolvedPath,
      content: '(empty)'
    }
  }

  const visibleLines: string[] = []
  let bytes = 0
  let remainingCount = 0

  for (const line of lines) {
    if (visibleLines.length >= maxEntries) {
      remainingCount += 1
      continue
    }

    const addition = visibleLines.length === 0 ? line : `\n${line}`
    const nextBytes = bytes + Buffer.byteLength(addition, 'utf8')
    if (nextBytes > maxBytes) {
      remainingCount += 1
      continue
    }

    visibleLines.push(line)
    bytes = nextBytes
  }

  if (remainingCount > 0) {
    const summary = `... (${remainingCount} more entr${remainingCount === 1 ? 'y' : 'ies'})`
    const summaryBytes = Buffer.byteLength(
      visibleLines.length === 0 ? summary : `\n${summary}`,
      'utf8'
    )

    if (bytes + summaryBytes <= maxBytes) {
      visibleLines.push(summary)
    }
  }

  return {
    path: input.mention.resolvedPath,
    content: visibleLines.join('\n')
  }
}

export function buildHiddenReferenceBlock(input: {
  mentions: ResolvedFileMention[]
  inlinedReference?: {
    kind?: 'file' | 'directory'
    tagName?: string
    path: string
    content: string
  } | null
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

  if (!input.inlinedReference) {
    return lines.join('\n')
  }

  const tagName =
    input.inlinedReference.tagName ??
    (input.inlinedReference.kind === 'directory' ? 'referenced_directory' : 'referenced_file')

  return [
    lines.join('\n'),
    '',
    `<${tagName} path="${input.inlinedReference.path}">`,
    input.inlinedReference.content,
    `</${tagName}>`
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
    const exactMatch = await resolveExactWorkspacePath(
      input.workspacePath,
      mention.query,
      ignoreRules,
      mention.includeIgnored
    )
    if (exactMatch) {
      mentions.push({
        ...mention,
        kind: 'resolved',
        resolvedPath: exactMatch.path,
        resolvedKind: exactMatch.kind,
        candidatePaths: [exactMatch.path]
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
      const resolvedKind = await resolveWorkspacePathKind(input.workspacePath, candidates[0])
      mentions.push({
        ...mention,
        kind: 'resolved',
        resolvedPath: candidates[0],
        ...(resolvedKind ? { resolvedKind } : {}),
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
  const inlinedReference =
    resolvedMentions.length === 1 && mentions.length === 1
      ? ((await maybeInlineResolvedFile({
          mention: resolvedMentions[0],
          workspacePath: input.workspacePath
        }).then((reference) => (reference ? { kind: 'file' as const, ...reference } : null))) ??
        (await maybeInlineResolvedDirectory({
          mention: resolvedMentions[0],
          workspacePath: input.workspacePath,
          ignoreRules
        }).then((reference) => (reference ? { kind: 'directory' as const, ...reference } : null))))
      : null

  return {
    mentions,
    inlinedPath: inlinedReference?.path,
    augmentedUserQuery: [
      buildHiddenReferenceBlock({
        mentions,
        ...(inlinedReference ? { inlinedReference } : {})
      }),
      '',
      input.content
    ].join('\n')
  }
}
