import type { RunRecord, ToolCall } from '@renderer/app/types'

export interface RunMemorySummary {
  entries: string[]
  runId: string
}

export function calculateTokensPerSecond(
  totalCompletionTokens: number | undefined,
  modelGenerationDurationMs: number | undefined
): number | null {
  if (!totalCompletionTokens || !modelGenerationDurationMs || modelGenerationDurationMs <= 0) {
    return null
  }

  return totalCompletionTokens / (modelGenerationDurationMs / 1_000)
}

export function formatTokensPerSecond(
  totalCompletionTokens: number | undefined,
  modelGenerationDurationMs: number | undefined
): string | null {
  const tokensPerSecond = calculateTokensPerSecond(totalCompletionTokens, modelGenerationDurationMs)
  return tokensPerSecond === null ? null : `${Math.round(tokensPerSecond * 10) / 10} tok/s`
}
export function formatTimeToFirstToken(timeToFirstTokenMs: number | undefined): string | null {
  if (
    timeToFirstTokenMs === undefined ||
    !Number.isFinite(timeToFirstTokenMs) ||
    timeToFirstTokenMs < 0
  ) {
    return null
  }

  return `TTFT ${(timeToFirstTokenMs / 1_000).toFixed(1)}s`
}

export function formatWorkSummaryPerformance(
  totalCompletionTokens: number | undefined,
  modelGenerationDurationMs: number | undefined,
  timeToFirstTokenMs: number | undefined
): string | null {
  const labels = [
    formatTokensPerSecond(totalCompletionTokens, modelGenerationDurationMs),
    formatTimeToFirstToken(timeToFirstTokenMs)
  ].filter((label): label is string => label !== null)

  return labels.length > 0 ? labels.join(' · ') : null
}

export function normalizeRunModelLabel(modelId: string | undefined): string | null {
  return modelId?.trim().split('/').pop()?.trim() || null
}

function compareRunsNewestFirst(left: RunRecord, right: RunRecord): number {
  const leftFinishedAt = left.completedAt ?? left.createdAt
  const rightFinishedAt = right.completedAt ?? right.createdAt
  const finishedAtComparison = rightFinishedAt.localeCompare(leftFinishedAt)
  if (finishedAtComparison !== 0) {
    return finishedAtComparison
  }

  const createdAtComparison = right.createdAt.localeCompare(left.createdAt)
  if (createdAtComparison !== 0) {
    return createdAtComparison
  }

  return right.id.localeCompare(left.id)
}

export type RecalledMemory =
  | { kind: 'note'; text: string }
  | { kind: 'fact'; title: string; fields: Array<[string, string]> }

const NOTE_LINE = /^\[note [^\]]+\]\s?(.*)$/
const FACT_LINE = /^\[[^\]]+\]\s+([^:]+):\s+(.+)$/
const SOURCE_FIELD_KEYS = new Set(['source_threads', 'source_messages'])

/**
 * Recalled entries are rendered for the model (`[note <id>] text` followed by a
 * `Sources:` line, or legacy `[relation] key: field=value; ...`), and one entry
 * may group several memories that share sources. Strip ids and source refs so
 * only the remembered content is shown.
 */
export function parseRecalledMemories(entries: readonly string[]): RecalledMemory[] {
  const memories: RecalledMemory[] = []
  let openNote: { kind: 'note'; text: string } | null = null

  for (const entry of entries) {
    openNote = null
    for (const line of entry.split('\n')) {
      const noteMatch = NOTE_LINE.exec(line)
      if (noteMatch) {
        openNote = { kind: 'note', text: noteMatch[1]! }
        memories.push(openNote)
        continue
      }
      if (line.startsWith('Sources: ')) {
        openNote = null
        continue
      }
      const factMatch = FACT_LINE.exec(line)
      if (factMatch) {
        openNote = null
        const fields = factMatch[2]!
          .split(';')
          .map((part): [string, string] | null => {
            const eqIndex = part.indexOf('=')
            if (eqIndex <= 0) return null
            const key = part.slice(0, eqIndex).trim()
            const value = part.slice(eqIndex + 1).trim()
            return key && value && !SOURCE_FIELD_KEYS.has(key) ? [key, value] : null
          })
          .filter((field): field is [string, string] => field !== null)
        memories.push({ kind: 'fact', title: factMatch[1]!.trim(), fields })
        continue
      }
      if (openNote) {
        openNote.text += `\n${line}`
      } else if (line.trim()) {
        openNote = { kind: 'note', text: line }
        memories.push(openNote)
      }
    }
  }

  for (const memory of memories) {
    if (memory.kind === 'note') memory.text = memory.text.trim()
  }
  return memories.filter((memory) => memory.kind === 'fact' || memory.text.length > 0)
}

/**
 * Count tool calls that belong to a run. A safe steer re-anchors later tool
 * calls to the steer's new requestMessageId, so per-group counts undershoot
 * the real run total. The runId on each tool call is the stable key.
 */
export function countToolCallsForRun(toolCalls: ToolCall[], runId: string): number {
  let count = 0
  for (const toolCall of toolCalls) {
    if (toolCall.runId === runId) count += 1
  }
  return count
}

export function findLatestRunForRequest(
  runs: RunRecord[],
  requestMessageId: string,
  predicate: (run: RunRecord) => boolean = () => true
): RunRecord | null {
  return findLatestRunForRequests(runs, [requestMessageId], predicate)
}

export function findLatestRunForRequests(
  runs: RunRecord[],
  requestMessageIds: readonly string[],
  predicate: (run: RunRecord) => boolean = () => true
): RunRecord | null {
  const requestMessageIdSet = new Set(requestMessageIds)
  for (const run of [...runs].sort(compareRunsNewestFirst)) {
    if (
      !run.requestMessageId ||
      !requestMessageIdSet.has(run.requestMessageId) ||
      !predicate(run)
    ) {
      continue
    }

    return run
  }

  return null
}

export function findRunMemorySummary(
  runs: RunRecord[],
  requestMessageId: string
): RunMemorySummary | null {
  return findRunMemorySummaryForRequests(runs, [requestMessageId])
}

export function findRunMemorySummaryForRequests(
  runs: RunRecord[],
  requestMessageIds: readonly string[]
): RunMemorySummary | null {
  const run = findLatestRunForRequests(runs, requestMessageIds)
  if (!run) {
    return null
  }

  const entries = run.recalledMemoryEntries?.filter((entry) => entry.trim().length > 0) ?? []
  if (entries.length === 0) {
    return null
  }

  return {
    entries,
    runId: run.id
  }
}
