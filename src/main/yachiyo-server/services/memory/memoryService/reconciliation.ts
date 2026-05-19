import type { MessageRecord, ProviderSettings } from '../../../../../shared/yachiyo/protocol.ts'
import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationResult
} from '../../../runtime/models/auxiliaryGeneration.ts'
import type { ModelMessage, ModelRuntime } from '../../../runtime/models/types.ts'
import {
  buildTopicLabel,
  chooseBetterContent,
  computeTokenOverlap,
  humanizeTopic,
  mergeCandidatesByTopic,
  normalizeDedupKey,
  normalizeTopicKey,
  normalizeWhitespace,
  parseMemoryCandidates,
  parseQueryPlan,
  truncate
} from './parsing.ts'
import type {
  MemoryCandidate,
  MemoryProvider,
  MemoryQueryPlanItem,
  MemoryQueryPlanResult,
  MemorySearchResult
} from '../memoryService.ts'
import { buildQueryPlanningMessages } from './prompts.ts'

export function compactMemoryEntry(result: MemorySearchResult): string | null {
  const title = normalizeWhitespace(result.title ?? '')
  const content = normalizeWhitespace(result.content)
  if (!content) {
    return null
  }

  const compactContent = truncate(content, 220)
  let body: string
  if (!title) {
    body = compactContent
  } else if (compactContent.toLowerCase().startsWith(title.toLowerCase())) {
    body = compactContent
  } else {
    body = `${title}: ${compactContent}`
  }

  if (result.unitType) {
    return `[${result.unitType}] ${body}`
  }
  return body
}

export async function collectStreamText(
  runtime: ModelRuntime,
  input: {
    messages: ModelMessage[]
    providerOptionsMode?: 'default' | 'auxiliary'
    settings: ProviderSettings
    signal?: AbortSignal
  }
): Promise<string> {
  const signal = input.signal ?? new AbortController().signal
  let text = ''

  for await (const delta of runtime.streamReply({
    messages: input.messages,
    providerOptionsMode: input.providerOptionsMode,
    settings: input.settings,
    signal,
    purpose: 'memory-generation'
  })) {
    text += delta
  }

  return text
}

export function isProviderSettingsConfigured(settings: ProviderSettings): boolean {
  return Boolean(settings.providerName.trim() && settings.model.trim() && settings.apiKey.trim())
}

export function buildFallbackQueryPlan(userQuery: string): MemoryQueryPlanItem[] {
  const normalized = normalizeWhitespace(userQuery)
  return normalized ? [{ query: truncate(normalized, 160), weight: 0.5 }] : []
}

export function toMemoryConnectionFailureMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return 'Nowledge Mem CLI not found. Install `nmem` on this Mac first.'
  }

  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.trim() || 'Memory connection test failed.'
}

export async function deriveQueryPlan(
  auxiliaryGeneration: AuxiliaryGenerationService,
  input: {
    history: MessageRecord[]
    isExternalChannel?: boolean
    signal?: AbortSignal
    userQuery: string
  }
): Promise<MemoryQueryPlanResult> {
  const result = await auxiliaryGeneration.generateText({
    messages: buildQueryPlanningMessages(input),
    signal: input.signal,
    purpose: 'memory-query-plan',
    // The plan is a tiny JSON object (skip flag or 0-3 short queries). Cap the
    // generation so a chatty tool model can never stall first-token latency.
    max_token: 256
  })

  if (result.status !== 'success') {
    return { skip: false, queries: buildFallbackQueryPlan(input.userQuery) }
  }

  const plan = parseQueryPlan(result.text)
  if (plan.skip) {
    return plan
  }

  return plan.queries.length > 0
    ? plan
    : { skip: false, queries: buildFallbackQueryPlan(input.userQuery) }
}

export async function deriveMemoryCandidates(
  result: AuxiliaryTextGenerationResult
): Promise<MemoryCandidate[]> {
  if (result.status !== 'success') {
    return []
  }

  return parseMemoryCandidates(result.text)
}

export function scoreTopicMatch(topic: string, result: MemorySearchResult): number {
  const resultTitleTopic = normalizeTopicKey(result.title ?? '')
  const labelTopic = normalizeTopicKey(findTopicLabel(result.labels)?.slice('topic:'.length) ?? '')
  const contentTopic = normalizeTopicKey(result.content)

  if (labelTopic && labelTopic === topic) {
    return 1.1
  }

  if (!resultTitleTopic) {
    return contentTopic === topic ? 0.9 : 0
  }

  if (resultTitleTopic === topic) {
    return 1
  }

  if (
    resultTitleTopic.includes(topic) ||
    topic.includes(resultTitleTopic) ||
    contentTopic === topic
  ) {
    return 0.8
  }

  return 0
}

export function findTopicLabel(labels?: string[]): string | null {
  return labels?.find((label) => label.startsWith('topic:')) ?? null
}

export function selectReconciliationTarget(
  candidate: MemoryCandidate,
  results: MemorySearchResult[]
): MemorySearchResult | null {
  const exactLabelMatch = results.find(
    (result) => findTopicLabel(result.labels) === buildTopicLabel(candidate.topic)
  )
  if (exactLabelMatch) {
    return exactLabelMatch
  }

  const scored = results
    .map((result) => ({
      result,
      score:
        scoreTopicMatch(candidate.topic, result) +
        computeTokenOverlap(candidate.title, result.title ?? '') * 0.75 +
        computeTokenOverlap(candidate.content, result.content) * 0.45 +
        (result.score ?? 0) * 0.2
    }))
    .sort((left, right) => right.score - left.score)

  if ((scored[0]?.score ?? 0) >= 0.9) {
    return scored[0]?.result ?? null
  }

  return null
}

export function shouldSkipExistingMemory(
  existing: MemorySearchResult,
  candidate: MemoryCandidate
): boolean {
  return (
    normalizeDedupKey({
      title: existing.title ?? '',
      content: existing.content
    }) === normalizeDedupKey(candidate)
  )
}

export function mergeWithExistingMemory(
  existing: MemorySearchResult,
  candidate: MemoryCandidate
): MemoryCandidate {
  return {
    topic: candidate.topic,
    title:
      candidate.title.length <= (existing.title?.length ?? Number.MAX_SAFE_INTEGER)
        ? candidate.title
        : (existing.title ?? candidate.title),
    content: chooseBetterContent(existing.content, candidate.content),
    importance: Math.max(existing.importance ?? 0, candidate.importance ?? 0) || undefined,
    unitType: candidate.unitType
  }
}

export async function reconcileMemoryCandidates(
  provider: MemoryProvider,
  candidates: MemoryCandidate[],
  signal?: AbortSignal
): Promise<{ creates: MemoryCandidate[]; updates: Array<{ id: string; item: MemoryCandidate }> }> {
  const creates: MemoryCandidate[] = []
  const updates: Array<{ id: string; item: MemoryCandidate }> = []

  for (const candidate of mergeCandidatesByTopic(candidates)) {
    const aggregatedMatches = new Map<string, MemorySearchResult>()
    const reconciliationQueries = [
      {
        label: buildTopicLabel(candidate.topic),
        query: candidate.title
      },
      {
        query: `${candidate.title} ${humanizeTopic(candidate.topic)}`
      },
      {
        query: `${humanizeTopic(candidate.topic)} ${candidate.content}`
      }
    ]

    for (const searchInput of reconciliationQueries) {
      const matches = await provider.searchMemories({
        limit: 4,
        query: truncate(searchInput.query, 180),
        ...(searchInput.label ? { label: searchInput.label } : {}),
        signal
      })

      for (const match of matches) {
        aggregatedMatches.set(match.id, match)
      }
    }

    const existing = selectReconciliationTarget(candidate, [...aggregatedMatches.values()])

    if (!existing) {
      creates.push(candidate)
      continue
    }

    if (shouldSkipExistingMemory(existing, candidate)) {
      continue
    }

    updates.push({
      id: existing.id,
      item: mergeWithExistingMemory(existing, candidate)
    })
  }

  return { creates, updates }
}
