import type { RecallDecisionSnapshot } from '@renderer/app/types'
import type { RunRecord } from '@renderer/app/types'

export interface RunMemorySummary {
  entries: string[]
  recallDecision?: RecallDecisionSnapshot
  runId: string
}

function normalizeNovelTerm(value: string): string {
  return value.trim().replace(/\s+/gu, ' ')
}

type NovelTermScript = 'latin' | 'cjk' | 'mixed' | 'other'

function tokenizeNovelTerm(value: string): string[] {
  return value
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
}

function detectNovelTermScript(token: string): NovelTermScript {
  const hasLatinOrDigit = /[a-z0-9]/iu.test(token)
  const hasCjk = /[\u3400-\u9fff]/u.test(token)

  if (hasLatinOrDigit && hasCjk) {
    return 'mixed'
  }

  if (hasLatinOrDigit) {
    return 'latin'
  }

  if (hasCjk) {
    return 'cjk'
  }

  return 'other'
}

function isStrongNovelToken(token: string, script: NovelTermScript): boolean {
  switch (script) {
    case 'latin':
      return token.replace(/[^a-z0-9]/giu, '').length >= 4
    case 'cjk':
      return token.length >= 3
    case 'mixed':
      return token.length >= 4 && !/\s/u.test(token)
    default:
      return false
  }
}

function shouldDisplayNovelTerm(term: string): boolean {
  const normalized = normalizeNovelTerm(term)
  const tokens = tokenizeNovelTerm(normalized)
  if (tokens.length === 0) {
    return false
  }

  if (tokens.length > 2) {
    return false
  }

  const scripts = new Set(tokens.map(detectNovelTermScript))
  if (scripts.has('other') || scripts.size !== 1) {
    return false
  }

  const script = detectNovelTermScript(tokens[0]!)

  if (tokens.length === 1) {
    return isStrongNovelToken(tokens[0]!, script)
  }

  return tokens.every((token) => isStrongNovelToken(token, script))
}

export function compactNovelTermsForDisplay(terms: string[] | undefined): string[] {
  if (!terms || terms.length === 0) {
    return []
  }

  const seen = new Set<string>()
  const compacted: string[] = []

  for (const term of terms) {
    const normalized = normalizeNovelTerm(term)
    const dedupeKey = normalized.toLowerCase()
    if (!shouldDisplayNovelTerm(normalized) || seen.has(dedupeKey)) {
      continue
    }

    seen.add(dedupeKey)
    compacted.push(normalized.length > 24 ? `${normalized.slice(0, 24).trimEnd()}...` : normalized)

    if (compacted.length >= 3) {
      break
    }
  }

  return compacted
}

export function findRunMemorySummary(
  runs: RunRecord[],
  requestMessageId: string
): RunMemorySummary | null {
  for (const run of [...runs].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt)
  )) {
    if (run.requestMessageId !== requestMessageId) {
      continue
    }

    const entries = run.recalledMemoryEntries?.filter((entry) => entry.trim().length > 0) ?? []
    if (entries.length === 0) {
      return null
    }

    return {
      entries,
      recallDecision: run.recallDecision,
      runId: run.id
    }
  }

  return null
}
