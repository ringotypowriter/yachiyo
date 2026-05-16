import type {
  MessageRecord,
  RecallDecisionSnapshot,
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
} from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelMessage, ModelRuntime } from '../../runtime/models/types.ts'
import {
  buildNextRecallState,
  filterRecalledMemories,
  shouldRecallBeforeRun,
  type RecallFilterCandidate
} from './recallPolicy.ts'
import {
  clampMemorySearchLimit,
  computeTokenOverlap,
  describeMemoryRejection,
  filterByImportance,
  buildTopicLabel,
  chooseBetterContent,
  humanizeTopic,
  mergeCandidatesByTopic,
  normalizeDedupKey,
  normalizeMemoryCandidate,
  normalizeTopicKey,
  normalizeWhitespace,
  parseMemoryCandidates,
  parseQueryPlan,
  sanitizeMemoryQueryText,
  truncate
} from './memoryService/parsing.ts'

export { sanitizeMemoryQueryText } from './memoryService/parsing.ts'

const DEFAULT_CONTEXT_MEMORY_LIMIT = 4
const DEFAULT_PROVIDER_SEARCH_LIMIT = 4

export interface MemoryQueryPlanItem {
  query: string
  topic?: string
  reason?: string
  weight?: number
}

export interface MemoryQueryPlanResult {
  skip: boolean
  skipReason?: string
  queries: MemoryQueryPlanItem[]
}

export type MemoryUnitType =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'plan'
  | 'procedure'
  | 'learning'
  | 'context'
  | 'event'

export interface MemorySearchResult {
  id: string
  title?: string
  content: string
  score?: number
  sourceThreadId?: string
  labels?: string[]
  importance?: number
  unitType?: MemoryUnitType
}

export interface MemoryCandidate {
  topic: string
  title: string
  content: string
  importance?: number
  unitType: MemoryUnitType
}

export interface CreateThreadInput {
  threadId: string
  title: string
  messages: Array<{ role: string; content: string }>
  signal?: AbortSignal
}

export interface DistillThreadInput {
  threadId: string
  triage?: boolean
  signal?: AbortSignal
}

export interface MemoryProvider {
  createMemories(input: {
    items: MemoryCandidate[]
    signal?: AbortSignal
  }): Promise<{ savedCount: number }>
  searchMemories(input: {
    limit: number
    query: string
    label?: string
    signal?: AbortSignal
  }): Promise<MemorySearchResult[]>
  updateMemory(input: { id: string; item: MemoryCandidate; signal?: AbortSignal }): Promise<void>
}

export interface ThreadAwareMemoryProvider extends MemoryProvider {
  createThread(input: CreateThreadInput): Promise<void>
  distillThread(input: DistillThreadInput): Promise<{ savedCount: number }>
}

export function isThreadAwareProvider(
  provider: MemoryProvider
): provider is ThreadAwareMemoryProvider {
  return 'createThread' in provider && 'distillThread' in provider
}

export interface RecallMemoryInput {
  history: MessageRecord[]
  now: string
  thread: ThreadRecord
  userQuery: string
  signal?: AbortSignal
}

export interface RecallForContextResult {
  decision: RecallDecisionSnapshot
  entries: string[]
  thread: ThreadRecord
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
  searchMemories(input: {
    limit?: number
    query: string
    topic?: string
    signal?: AbortSignal
  }): Promise<MemorySearchResult[]>
  testConnection(config?: SettingsConfig): Promise<TestMemoryConnectionResult>
  recallForContext(input: RecallMemoryInput): Promise<RecallForContextResult>
  createMemory(item: MemoryCandidate, signal?: AbortSignal): Promise<{ savedCount: number }>
  validateAndCreateMemory(
    raw: {
      title?: string
      content?: string
      topic?: string
      unitType?: string
      importance?: number
    },
    signal?: AbortSignal
  ): Promise<{ savedCount: number; rejected?: string }>
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

const HISTORY_EXCERPT_PER_MESSAGE_CHARS = 400

function buildHistoryExcerpt(history: MessageRecord[]): string {
  return history
    .slice(-4)
    .map((message) => {
      const clean = sanitizeMemoryQueryText(message.content, HISTORY_EXCERPT_PER_MESSAGE_CHARS)
      return `[${message.role}] ${clean}`
    })
    .join('\n')
}

function buildQueryPlanningMessages(input: {
  history: MessageRecord[]
  isExternalChannel?: boolean
  userQuery: string
}): ModelMessage[] {
  const systemLines = input.isExternalChannel
    ? [
        'You create retrieval plans for long-term memory recall in a casual conversation context.',
        'Return JSON only.',
        'Schema: {"skip":true,"skipReason":"string"} or {"queries":[{"topic":"string","query":"string","reason":"string","weight":0.0}]}',
        'Set skip=true when the user is asking a general question, making small talk, or discussing something that clearly does not relate to any personal memory (interests, preferences, communication style, relationship context, or things they have shared about themselves).',
        'When skip=true, provide a concise skipReason.',
        'When skip=false, produce 0-2 focused semantic queries.',
        'Each topic must be a short stable canonical topic key, not a sentence.',
        'Target personal memories: who the user is, their interests, preferences, communication style, relationship context, and things they have shared about themselves.',
        'Do NOT search for project tasks, code decisions, technical workflows, bugs, or workspace-specific facts.',
        'Do NOT search for anything related to software development work unless the user is explicitly discussing it.',
        'Favor queries about the person, not about their work output.',
        'Avoid time words, temporary status, and conversational framing like "this time", "currently", "we discussed", or "maybe".',
        'Do not do naive keyword splitting.'
      ]
    : [
        'You create retrieval plans for long-term memory recall.',
        'Return JSON only.',
        'Schema: {"skip":true,"skipReason":"string"} or {"queries":[{"topic":"string","query":"string","reason":"string","weight":0.0}]}',
        'Set skip=true when the user is asking a general question, making small talk, or discussing something that clearly does not relate to any durable memory (preferences, decisions, workflows, constraints, bugs, or project facts).',
        'When skip=true, provide a concise skipReason.',
        'When skip=false, produce 0-3 focused semantic queries.',
        'Each topic must be a short stable canonical topic key, not a sentence.',
        'Each query must target durable memories such as preferences, decisions, workflows, constraints, bugs, project facts, and reusable troubleshooting knowledge.',
        'Write retrieval-oriented semantic queries, not naive keyword splitting and not paraphrases of the full user turn.',
        'Favor stable project wording that could match long-term memory written on earlier days.',
        'Prefer queries that can surface durable preferences, decisions, workflows, constraints, bugs, and project facts.',
        'Avoid time words, temporary status, and conversational framing like "this time", "currently", "we discussed", or "maybe".',
        'Do not do naive keyword splitting.',
        'Do not include run-specific chatter, filler, or temporary status language.'
      ]

  return [
    { role: 'system', content: systemLines.join('\n') },
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
        'Schema: {"candidates":[{"topic":"string","title":"string","content":"string","unitType":"fact|preference|decision|plan|procedure|learning|context|event","importance":0.0}]}',
        'If no durable long-term knowledge is present, return {"candidates":[]}. Do not invent weak observations to fill the array.',
        'Only keep durable preferences, decisions, workflows, stable facts, or reusable lessons.',
        'Emit at most one candidate per durable topic.',
        'Topic must be a stable canonical topic identifier for dedupe, reconciliation, and later updates.',
        'Title must be short, stable, canonical, topic-like, and noun-style when possible.',
        'Reuse the same topic key and title for repeated long-term topics instead of inventing variants.',
        'Content must be normalized durable wording, compact, factual, and easy to compare during future updates.',
        'When the memory is about the user, prefer "<username> + objective description" if the username is explicitly known from context.',
        'If the username is not explicitly known, omit the subject instead of writing "the user" or other chat-role labels.',
        'Content must not describe the chat itself, the thread itself, or the current run.',
        'Exclude temporary run chatter, conversational filler, and weak observations.',
        'Do not use phrases like "this time", "just now", "currently", "we discussed", "it seems", or "maybe".',
        'Do not write vague conversational summaries like "the user asked", "we talked about", or "the assistant said".',
        'Do not emit multiple near-duplicate candidates for the same long-term topic.',
        'Examples:',
        'Bad: "the user prefers concise status updates."',
        'Good: "<username> prefers concise status updates."',
        'Bad: "we discussed using the repo root for commands."',
        'Good: "<username> uses the Yachiyo repo root for commands."',
        'Bad: "this time the user mentioned disliking bureaucratic language."',
        'Good: "<username> dislikes bureaucratic or overly formal language."'
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
        'Schema: {"candidates":[{"topic":"string","title":"string","content":"string","unitType":"fact|preference|decision|plan|procedure|learning|context|event","importance":0.0}]}',
        'If no durable long-term knowledge is present, return {"candidates":[]}. Do not invent weak observations to fill the array.',
        'Keep only durable knowledge that should survive beyond this single thread.',
        'Emit at most one candidate per durable topic.',
        'Prefer stable canonical topics, stable canonical titles, and normalized factual wording.',
        'Reuse the same topic key and title for repeated long-term topics instead of inventing variants.',
        'When the memory is about the user, prefer "<username> + objective description" if the username is explicitly known from context.',
        'If the username is not explicitly known, omit the subject instead of writing "the user" or other chat-role labels.',
        'Content must be compact durable wording, not a story about this thread.',
        'Exclude temporary status, filler, speculation, and thread-specific narration.',
        'Do not use phrases like "this time", "just now", "currently", "we discussed", "it seems", or "maybe".',
        'Do not write conversational summaries like "the user asked", "we talked about", or "the assistant said".',
        'Examples:',
        'Bad: "the user prefers concise status updates."',
        'Good: "<username> prefers concise status updates."',
        'Bad: "we discussed using the repo root for commands."',
        'Good: "<username> uses the Yachiyo repo root for commands."',
        'Bad: "this time the user mentioned disliking bureaucratic language."',
        'Good: "<username> dislikes bureaucratic or overly formal language."',
        'Do not emit multiple near-duplicate candidates for the same long-term topic.'
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
    signal,
    purpose: 'memory-generation'
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

async function deriveMemoryCandidates(
  result: AuxiliaryTextGenerationResult
): Promise<MemoryCandidate[]> {
  if (result.status !== 'success') {
    return []
  }

  return parseMemoryCandidates(result.text)
}

function scoreTopicMatch(topic: string, result: MemorySearchResult): number {
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

function findTopicLabel(labels?: string[]): string | null {
  return labels?.find((label) => label.startsWith('topic:')) ?? null
}

function selectReconciliationTarget(
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

function shouldSkipExistingMemory(
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

function mergeWithExistingMemory(
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

async function reconcileMemoryCandidates(
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

    async searchMemories(input: {
      limit?: number
      query: string
      topic?: string
      signal?: AbortSignal
    }): Promise<MemorySearchResult[]> {
      const provider = resolveProvider()
      if (!provider) {
        return []
      }

      const query = normalizeWhitespace(input.query)
      if (!query) {
        return []
      }

      const label = input.topic ? buildTopicLabel(normalizeTopicKey(input.topic)) : undefined

      return provider.searchMemories({
        limit: clampMemorySearchLimit(input.limit),
        query,
        label,
        signal: input.signal
      })
    },

    async createMemory(
      item: MemoryCandidate,
      signal?: AbortSignal
    ): Promise<{ savedCount: number }> {
      const provider = resolveProvider()
      if (!provider) {
        return { savedCount: 0 }
      }
      return provider.createMemories({ items: [item], signal })
    },

    async validateAndCreateMemory(
      raw: {
        title?: string
        content?: string
        topic?: string
        unitType?: string
        importance?: number
      },
      signal?: AbortSignal
    ): Promise<{ savedCount: number; rejected?: string }> {
      const provider = resolveProvider()
      if (!provider) {
        return { savedCount: 0, rejected: 'Memory is not configured.' }
      }

      const candidate = normalizeMemoryCandidate(raw)
      if (!candidate) {
        return { savedCount: 0, rejected: describeMemoryRejection(raw) }
      }

      const result = await provider.createMemories({ items: [candidate], signal })
      return { savedCount: result.savedCount }
    },

    async testConnection(configOverride?: SettingsConfig): Promise<TestMemoryConnectionResult> {
      const config = configOverride ?? deps.readConfig()
      const providerId = normalizeMemoryProviderId(config.memory?.provider)
      if (providerId === 'builtin-memory') {
        try {
          const provider = deps.createProvider({
            ...config,
            memory: {
              enabled: true,
              provider: 'builtin-memory'
            }
          })
          await provider.searchMemories({
            limit: 1,
            query: 'Yachiyo memory connection check'
          })

          return {
            ok: true,
            message: 'Built-in memory is ready.'
          }
        } catch (error) {
          return {
            ok: false,
            message: toMemoryConnectionFailureMessage(error)
          }
        }
      }

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

    async recallForContext(rawInput: RecallMemoryInput): Promise<RecallForContextResult> {
      // Strip embedded-document blocks and truncate BEFORE anything else so
      // the recall planner never sees a huge @-mentioned file body that would
      // stall the auxiliary LLM upload.
      const input: RecallMemoryInput = {
        ...rawInput,
        userQuery: sanitizeMemoryQueryText(rawInput.userQuery)
      }
      const decision = shouldRecallBeforeRun({
        history: input.history,
        now: input.now,
        thread: input.thread,
        userQuery: input.userQuery
      })
      const provider = resolveProvider()
      if (!provider || !decision.shouldRecall) {
        return {
          decision,
          entries: [],
          thread: {
            ...input.thread,
            memoryRecall: buildNextRecallState({
              didRecall: false,
              decision,
              history: input.history,
              now: input.now,
              thread: input.thread
            })
          }
        }
      }

      try {
        const isExternalChannel = input.thread.source != null && input.thread.source !== 'local'
        const queryPlan = await deriveQueryPlan(deps.auxiliaryGeneration, {
          history: input.history,
          isExternalChannel,
          signal: input.signal,
          userQuery: input.userQuery
        })

        if (queryPlan.skip) {
          const skippedDecision: RecallDecisionSnapshot = {
            ...decision,
            modelSkipped: true,
            modelSkipReason: queryPlan.skipReason
          }
          return {
            decision: skippedDecision,
            entries: [],
            thread: {
              ...input.thread,
              memoryRecall: buildNextRecallState({
                didRecall: false,
                decision: skippedDecision,
                history: input.history,
                now: input.now,
                thread: input.thread
              })
            }
          }
        }

        const aggregated = new Map<
          string,
          {
            matches: number
            result: MemorySearchResult
            score: number
          }
        >()

        // Run all planner-generated searches in parallel. Each one spawns a
        // fresh `nmem` subprocess, so sequential awaits stack hundreds of ms
        // onto first-token latency for every extra query the planner emits.
        const perQueryResults = await Promise.all(
          queryPlan.queries.map((query) =>
            provider.searchMemories({
              limit: DEFAULT_PROVIDER_SEARCH_LIMIT,
              query: query.query,
              signal: input.signal
            })
          )
        )

        for (const [queryIndex, query] of queryPlan.queries.entries()) {
          const results = perQueryResults[queryIndex] ?? []
          for (const [resultIndex, result] of results.entries()) {
            const key =
              result.id || normalizeDedupKey({ title: result.title ?? '', content: result.content })
            const baseScore = result.score ?? Math.max(0.1, 1 - resultIndex * 0.1)
            const weightedScore =
              baseScore +
              (query.weight ?? 0.5) * 0.35 +
              scoreTopicMatch(query.topic ?? '', result) * 0.2 -
              queryIndex * 0.02
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

        const candidates = [...aggregated.values()]
          .map((entry) => ({
            entry: compactMemoryEntry(entry.result),
            id:
              entry.result.id ||
              normalizeDedupKey({
                title: entry.result.title ?? '',
                content: entry.result.content
              }),
            score: entry.score + (entry.matches - 1) * 0.15
          }))
          .filter(
            (entry): entry is RecallFilterCandidate =>
              typeof entry.entry === 'string' && entry.entry.length > 0
          )
          .sort((left, right) => right.score - left.score)
          .slice(0, DEFAULT_CONTEXT_MEMORY_LIMIT)
        const filtered = filterRecalledMemories({
          candidates,
          history: input.history,
          now: input.now,
          thread: input.thread,
          userQuery: input.userQuery
        })

        return {
          decision,
          entries: filtered.entries,
          thread: {
            ...input.thread,
            memoryRecall: buildNextRecallState({
              didRecall: true,
              decision,
              history: input.history,
              now: input.now,
              recentInjections: filtered.recentInjections,
              thread: input.thread
            })
          }
        }
      } catch (error) {
        // Never swallow user-initiated aborts — let them propagate so the run
        // actually stops instead of silently continuing past the stop button.
        if (input.signal?.aborted) {
          throw error
        }
        console.warn('[yachiyo][memory] recall failed; continuing without memory context', {
          error: error instanceof Error ? error.message : String(error),
          threadId: input.thread.id
        })
        return {
          decision,
          entries: [],
          thread: {
            ...input.thread,
            memoryRecall: buildNextRecallState({
              didRecall: false,
              decision: {
                ...decision,
                shouldRecall: false,
                reasons: [...decision.reasons, 'recall-failed']
              },
              history: input.history,
              now: input.now,
              thread: input.thread
            })
          }
        }
      }
    },

    async distillCompletedRun(input: DistillRunMemoryInput): Promise<{ savedCount: number }> {
      const provider = resolveProvider()
      if (!provider) {
        return { savedCount: 0 }
      }

      const result = await deps.auxiliaryGeneration.generateText({
        messages: buildRunDistillationMessages(input),
        signal: input.signal,
        purpose: 'memory-distill'
      })
      const candidates = filterByImportance(await deriveMemoryCandidates(result))
      if (candidates.length === 0) {
        return { savedCount: 0 }
      }
      const reconciled = await reconcileMemoryCandidates(provider, candidates, input.signal)

      for (const update of reconciled.updates) {
        await provider.updateMemory({
          id: update.id,
          item: update.item,
          signal: input.signal
        })
      }

      const created =
        reconciled.creates.length === 0
          ? { savedCount: 0 }
          : await provider.createMemories({
              items: reconciled.creates,
              signal: input.signal
            })

      return {
        savedCount: created.savedCount + reconciled.updates.length
      }
    },

    async saveThread(input: SaveThreadMemoryInput): Promise<{ savedCount: number }> {
      const provider = resolveProvider()
      if (!provider) {
        throw new Error('Memory is not enabled.')
      }

      if (input.messages.length === 0) {
        return { savedCount: 0 }
      }

      if (isThreadAwareProvider(provider)) {
        const messages = input.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content }))

        await provider.createThread({
          threadId: input.thread.id,
          title: input.thread.title || 'Untitled',
          messages,
          signal: input.signal
        })

        return provider.distillThread({
          threadId: input.thread.id,
          triage: true,
          signal: input.signal
        })
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
      const candidates = filterByImportance(parseMemoryCandidates(text))
      if (candidates.length === 0) {
        return { savedCount: 0 }
      }
      const reconciled = await reconcileMemoryCandidates(provider, candidates, input.signal)

      for (const update of reconciled.updates) {
        await provider.updateMemory({
          id: update.id,
          item: update.item,
          signal: input.signal
        })
      }

      const created =
        reconciled.creates.length === 0
          ? { savedCount: 0 }
          : await provider.createMemories({
              items: reconciled.creates,
              signal: input.signal
            })

      return {
        savedCount: created.savedCount + reconciled.updates.length
      }
    }
  }
}

/**
 * Wrap a MemoryService so that search results containing any of the given
 * keywords are stripped. The filtered tool output tells the model how many
 * results were hidden for privacy.
 */
export function createFilteredMemoryService(
  inner: MemoryService,
  filterKeywords: string[]
): MemoryService {
  if (filterKeywords.length === 0) return inner

  const lowerKeywords = filterKeywords.map((k) => k.toLowerCase())

  function containsFilteredKeyword(result: MemorySearchResult): boolean {
    const haystack = [result.title ?? '', result.content, ...(result.labels ?? [])]
      .join(' ')
      .toLowerCase()
    return lowerKeywords.some((kw) => haystack.includes(kw))
  }

  return {
    ...inner,
    async searchMemories(input) {
      const results = await inner.searchMemories(input)
      const filtered = results.filter((r) => !containsFilteredKeyword(r))
      const hiddenCount = results.length - filtered.length

      if (hiddenCount > 0 && filtered.length === 0) {
        return [
          {
            id: '_privacy_filter',
            content: `All ${hiddenCount} result(s) were hidden by the owner's privacy filter.`,
            title: 'Privacy filter'
          }
        ]
      }

      if (hiddenCount > 0) {
        filtered.push({
          id: '_privacy_filter_notice',
          content: `${hiddenCount} additional result(s) were hidden by the owner's privacy filter.`,
          title: 'Privacy filter notice'
        })
      }

      return filtered
    }
  }
}
