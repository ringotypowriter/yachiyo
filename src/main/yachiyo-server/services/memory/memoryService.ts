import type {
  MessageRecord,
  TestMemoryConnectionResult,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import {
  isMemoryConfigured,
  normalizeMemoryProviderId
} from '../../../../shared/yachiyo/protocol.ts'
import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationResult
} from '../../runtime/auxiliaryGeneration.ts'
import type { ModelMessage, ModelRuntime } from '../../runtime/types.ts'

export const HIDDEN_MEMORY_SEARCH_TOOL_NAME = 'memory_search'
const DEFAULT_CONTEXT_MEMORY_LIMIT = 4
const DEFAULT_PROVIDER_SEARCH_LIMIT = 4

export interface MemoryQueryPlanItem {
  query: string
  reason?: string
  weight?: number
}

export interface MemorySearchResult {
  id: string
  title?: string
  content: string
  score?: number
  sourceThreadId?: string
}

export interface MemoryCandidate {
  title: string
  content: string
  importance?: number
}

export interface MemoryProvider {
  createMemories(input: {
    items: MemoryCandidate[]
    signal?: AbortSignal
  }): Promise<{ savedCount: number }>
  searchMemories(input: {
    limit: number
    query: string
    signal?: AbortSignal
  }): Promise<MemorySearchResult[]>
}

export interface RecallMemoryInput {
  history: MessageRecord[]
  thread: ThreadRecord
  userQuery: string
  signal?: AbortSignal
}

export interface SaveThreadMemoryInput {
  messages: MessageRecord[]
  signal?: AbortSignal
  thread: ThreadRecord
}

export interface DistillRunMemoryInput {
  assistantResponse: string
  signal?: AbortSignal
  thread: ThreadRecord
  userQuery: string
}

export interface MemoryService {
  hasHiddenSearchCapability(): boolean
  isConfigured(): boolean
  testConnection(config?: SettingsConfig): Promise<TestMemoryConnectionResult>
  recallForContext(input: RecallMemoryInput): Promise<string[]>
  distillCompletedRun(input: DistillRunMemoryInput): Promise<{ savedCount: number }>
  saveThread(input: SaveThreadMemoryInput): Promise<{ savedCount: number }>
}

export interface MemoryServiceDeps {
  auxiliaryGeneration: AuxiliaryGenerationService
  createModelRuntime: () => ModelRuntime
  createProvider: (config: SettingsConfig) => MemoryProvider
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
}

interface QueryPlanEnvelope {
  queries?: Array<{
    query?: unknown
    reason?: unknown
    weight?: unknown
  }>
}

interface CandidateEnvelope {
  candidates?: Array<{
    content?: unknown
    importance?: unknown
    title?: unknown
  }>
}

function clampWeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined
  }

  return Math.max(0, Math.min(1, value))
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function stripMarkdownFence(value: string): string {
  const fenced = value.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u)
  return fenced?.[1]?.trim() ?? value.trim()
}

function extractJsonBlock(value: string): string | null {
  const unfenced = stripMarkdownFence(value)
  const objectStart = unfenced.indexOf('{')
  const arrayStart = unfenced.indexOf('[')
  const start =
    objectStart === -1
      ? arrayStart
      : arrayStart === -1
        ? objectStart
        : Math.min(objectStart, arrayStart)

  if (start === -1) {
    return null
  }

  const objectEnd = unfenced.lastIndexOf('}')
  const arrayEnd = unfenced.lastIndexOf(']')
  const end = Math.max(objectEnd, arrayEnd)

  if (end < start) {
    return null
  }

  return unfenced.slice(start, end + 1)
}

function parseJsonEnvelope<T>(value: string): T | null {
  const jsonBlock = extractJsonBlock(value)
  if (!jsonBlock) {
    return null
  }

  try {
    return JSON.parse(jsonBlock) as T
  } catch {
    return null
  }
}

function parseQueryPlan(text: string): MemoryQueryPlanItem[] {
  const parsed = parseJsonEnvelope<QueryPlanEnvelope>(text)
  if (!parsed?.queries || !Array.isArray(parsed.queries)) {
    return []
  }

  return parsed.queries
    .flatMap((item) => {
      const query = typeof item.query === 'string' ? normalizeWhitespace(item.query) : ''
      if (!query) {
        return []
      }

      return [
        {
          query,
          reason: typeof item.reason === 'string' ? normalizeWhitespace(item.reason) : undefined,
          weight: clampWeight(item.weight)
        }
      ]
    })
    .slice(0, 3)
}

function parseMemoryCandidates(text: string): MemoryCandidate[] {
  const parsed = parseJsonEnvelope<CandidateEnvelope>(text)
  if (!parsed?.candidates || !Array.isArray(parsed.candidates)) {
    return []
  }

  return parsed.candidates
    .flatMap((item) => {
      const title = typeof item.title === 'string' ? normalizeWhitespace(item.title) : ''
      const content = typeof item.content === 'string' ? normalizeWhitespace(item.content) : ''

      if (!title || !content) {
        return []
      }

      return [
        {
          title: truncate(title, 120),
          content: truncate(content, 600),
          importance: clampWeight(item.importance)
        }
      ]
    })
    .slice(0, 8)
}

function normalizeDedupKey(input: { title: string; content: string }): string {
  return `${input.title}\n${input.content}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim()
}

function buildHistoryExcerpt(history: MessageRecord[]): string {
  return history
    .slice(-4)
    .map((message) => `[${message.role}] ${normalizeWhitespace(message.content)}`)
    .join('\n')
}

function buildQueryPlanningMessages(input: {
  history: MessageRecord[]
  userQuery: string
}): ModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You create semantic retrieval plans for long-term memory recall.',
        'Return JSON only.',
        'Schema: {"queries":[{"query":"string","reason":"string","weight":0.0}]}',
        'Produce 0-3 focused search queries.',
        'Avoid keyword splitting. Use intent-level recall queries that could match prior decisions, preferences, bugs, or workflows.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `Current user query:\n${input.userQuery}`,
        '',
        input.history.length > 0
          ? `Recent thread context:\n${buildHistoryExcerpt(input.history)}`
          : 'Recent thread context:\n(none)'
      ].join('\n')
    }
  ]
}

function buildRunDistillationMessages(input: {
  assistantResponse: string
  userQuery: string
}): ModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Extract durable long-term memory candidates from a completed exchange.',
        'Return JSON only.',
        'Schema: {"candidates":[{"title":"string","content":"string","importance":0.0}]}',
        'Only keep durable preferences, decisions, workflows, stable facts, or reusable lessons.',
        'Skip ephemeral task chatter and temporary run-specific details.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        `User query:\n${input.userQuery}`,
        '',
        `Assistant response:\n${input.assistantResponse}`
      ].join('\n')
    }
  ]
}

function buildSaveThreadMessages(messages: MessageRecord[]): ModelMessage[] {
  const transcript = messages
    .map((message) => `[${message.role}] ${normalizeWhitespace(message.content)}`)
    .join('\n')

  return [
    {
      role: 'system',
      content: [
        'Review the full conversation transcript and extract durable long-term memory updates.',
        'Return JSON only.',
        'Schema: {"candidates":[{"title":"string","content":"string","importance":0.0}]}',
        'Keep only knowledge that should survive beyond this single thread.'
      ].join('\n')
    },
    {
      role: 'user',
      content: `Thread transcript:\n${transcript}`
    }
  ]
}

function compactMemoryEntry(result: MemorySearchResult): string | null {
  const title = normalizeWhitespace(result.title ?? '')
  const content = normalizeWhitespace(result.content)
  if (!content) {
    return null
  }

  const compactContent = truncate(content, 220)
  if (!title) {
    return compactContent
  }

  if (compactContent.toLowerCase().startsWith(title.toLowerCase())) {
    return compactContent
  }

  return `${title}: ${compactContent}`
}

async function collectStreamText(
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
    signal
  })) {
    text += delta
  }

  return text
}

function isProviderSettingsConfigured(settings: ProviderSettings): boolean {
  return Boolean(settings.providerName.trim() && settings.model.trim() && settings.apiKey.trim())
}

function buildFallbackQueryPlan(userQuery: string): MemoryQueryPlanItem[] {
  const normalized = normalizeWhitespace(userQuery)
  return normalized ? [{ query: truncate(normalized, 160), weight: 0.5 }] : []
}

function toMemoryConnectionFailureMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
    return 'Nowledge Mem CLI not found. Install `nmem` on this Mac first.'
  }

  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.trim() || 'Memory connection test failed.'
}

async function deriveQueryPlan(
  auxiliaryGeneration: AuxiliaryGenerationService,
  input: { history: MessageRecord[]; signal?: AbortSignal; userQuery: string }
): Promise<MemoryQueryPlanItem[]> {
  const result = await auxiliaryGeneration.generateText({
    messages: buildQueryPlanningMessages(input),
    signal: input.signal
  })

  if (result.status !== 'success') {
    return buildFallbackQueryPlan(input.userQuery)
  }

  const plannedQueries = parseQueryPlan(result.text)
  return plannedQueries.length > 0 ? plannedQueries : buildFallbackQueryPlan(input.userQuery)
}

async function deriveMemoryCandidates(
  result: AuxiliaryTextGenerationResult
): Promise<MemoryCandidate[]> {
  if (result.status !== 'success') {
    return []
  }

  return parseMemoryCandidates(result.text)
}

async function filterNewCandidates(
  provider: MemoryProvider,
  candidates: MemoryCandidate[],
  signal?: AbortSignal
): Promise<MemoryCandidate[]> {
  const seen = new Set<string>()
  const filtered: MemoryCandidate[] = []

  for (const candidate of candidates) {
    const dedupKey = normalizeDedupKey(candidate)
    if (seen.has(dedupKey)) {
      continue
    }

    seen.add(dedupKey)
    const similar = await provider.searchMemories({
      limit: 3,
      query: candidate.title,
      signal
    })
    const isDuplicate = similar.some(
      (result) =>
        normalizeDedupKey({
          title: result.title ?? '',
          content: result.content
        }) === dedupKey
    )

    if (!isDuplicate) {
      filtered.push(candidate)
    }
  }

  return filtered
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const resolveProvider = (): MemoryProvider | null => {
    const config = deps.readConfig()
    return isMemoryConfigured(config) ? deps.createProvider(config) : null
  }

  return {
    hasHiddenSearchCapability(): boolean {
      return this.isConfigured()
    },

    isConfigured(): boolean {
      return isMemoryConfigured(deps.readConfig())
    },

    async testConnection(configOverride?: SettingsConfig): Promise<TestMemoryConnectionResult> {
      const config = configOverride ?? deps.readConfig()
      const baseUrl = config.memory?.baseUrl?.trim() ?? ''
      if (!baseUrl) {
        return {
          ok: false,
          message: 'Enter a Nowledge Mem backend URL first.'
        }
      }

      try {
        const provider = deps.createProvider({
          ...config,
          memory: {
            enabled: true,
            provider: normalizeMemoryProviderId(config.memory?.provider),
            baseUrl
          }
        })
        await provider.searchMemories({
          limit: 1,
          query: 'Yachiyo memory connection check'
        })

        return {
          ok: true,
          message: 'Nowledge Mem is reachable.'
        }
      } catch (error) {
        return {
          ok: false,
          message: toMemoryConnectionFailureMessage(error)
        }
      }
    },

    async recallForContext(input: RecallMemoryInput): Promise<string[]> {
      const provider = resolveProvider()
      if (!provider) {
        return []
      }

      try {
        const queryPlan = await deriveQueryPlan(deps.auxiliaryGeneration, {
          history: input.history,
          signal: input.signal,
          userQuery: input.userQuery
        })

        const aggregated = new Map<
          string,
          {
            matches: number
            result: MemorySearchResult
            score: number
          }
        >()

        for (const [queryIndex, query] of queryPlan.entries()) {
          const results = await provider.searchMemories({
            limit: DEFAULT_PROVIDER_SEARCH_LIMIT,
            query: query.query,
            signal: input.signal
          })

          for (const [resultIndex, result] of results.entries()) {
            const key =
              result.id || normalizeDedupKey({ title: result.title ?? '', content: result.content })
            const baseScore = result.score ?? Math.max(0.1, 1 - resultIndex * 0.1)
            const weightedScore = baseScore + (query.weight ?? 0.5) * 0.35 - queryIndex * 0.02
            const existing = aggregated.get(key)

            if (!existing || weightedScore > existing.score) {
              aggregated.set(key, {
                matches: (existing?.matches ?? 0) + 1,
                result,
                score: weightedScore
              })
              continue
            }

            existing.matches += 1
          }
        }

        return [...aggregated.values()]
          .map((entry) => ({
            entry: compactMemoryEntry(entry.result),
            score: entry.score + (entry.matches - 1) * 0.15
          }))
          .filter((entry): entry is { entry: string; score: number } => Boolean(entry.entry))
          .sort((left, right) => right.score - left.score)
          .slice(0, DEFAULT_CONTEXT_MEMORY_LIMIT)
          .map((entry) => entry.entry)
      } catch (error) {
        console.warn('[yachiyo][memory] recall failed; continuing without memory context', {
          error: error instanceof Error ? error.message : String(error),
          threadId: input.thread.id
        })
        return []
      }
    },

    async distillCompletedRun(input: DistillRunMemoryInput): Promise<{ savedCount: number }> {
      const provider = resolveProvider()
      if (!provider) {
        return { savedCount: 0 }
      }

      const result = await deps.auxiliaryGeneration.generateText({
        messages: buildRunDistillationMessages(input),
        signal: input.signal
      })
      const candidates = await deriveMemoryCandidates(result)
      const filtered = await filterNewCandidates(provider, candidates, input.signal)

      if (filtered.length === 0) {
        return { savedCount: 0 }
      }

      return provider.createMemories({
        items: filtered,
        signal: input.signal
      })
    },

    async saveThread(input: SaveThreadMemoryInput): Promise<{ savedCount: number }> {
      const provider = resolveProvider()
      if (!provider) {
        throw new Error('Memory is not enabled.')
      }

      if (input.messages.length === 0) {
        return { savedCount: 0 }
      }

      const settings = deps.readSettings()
      if (!isProviderSettingsConfigured(settings)) {
        throw new Error('The main chat model is not configured.')
      }

      const text = await collectStreamText(deps.createModelRuntime(), {
        messages: buildSaveThreadMessages(input.messages),
        settings,
        signal: input.signal
      })
      const candidates = parseMemoryCandidates(text)
      const filtered = await filterNewCandidates(provider, candidates, input.signal)

      if (filtered.length === 0) {
        return { savedCount: 0 }
      }

      return provider.createMemories({
        items: filtered,
        signal: input.signal
      })
    }
  }
}
