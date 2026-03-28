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
} from '../../runtime/auxiliaryGeneration.ts'
import type { ModelMessage, ModelRuntime } from '../../runtime/types.ts'
import {
  buildNextRecallState,
  filterRecalledMemories,
  shouldRecallBeforeRun,
  type RecallFilterCandidate
} from './recallPolicy.ts'

export const HIDDEN_MEMORY_SEARCH_TOOL_NAME = 'memory_search'
const DEFAULT_CONTEXT_MEMORY_LIMIT = 4
const DEFAULT_PROVIDER_SEARCH_LIMIT = 4
const DEFAULT_MEMORY_TOOL_LIMIT = 5

export interface MemoryQueryPlanItem {
  query: string
  topic?: string
  reason?: string
  weight?: number
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
    signal?: AbortSignal
  }): Promise<MemorySearchResult[]>
  testConnection(config?: SettingsConfig): Promise<TestMemoryConnectionResult>
  recallForContext(input: RecallMemoryInput): Promise<RecallForContextResult>
  createMemory(item: MemoryCandidate, signal?: AbortSignal): Promise<{ savedCount: number }>
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
    topic?: unknown
    reason?: unknown
    weight?: unknown
  }>
}

interface CandidateEnvelope {
  candidates?: Array<{
    topic?: unknown
    content?: unknown
    importance?: unknown
    title?: unknown
    unitType?: unknown
  }>
}

const MEMORY_UNIT_TYPES: readonly MemoryUnitType[] = [
  'fact',
  'preference',
  'decision',
  'plan',
  'procedure',
  'learning',
  'context',
  'event'
]
const FORBIDDEN_MEMORY_PHRASES = [
  /\bthis time\b/iu,
  /\bjust now\b/iu,
  /\bcurrently\b/iu,
  /\bwe discussed\b/iu,
  /\bwe talked about\b/iu,
  /\bin this (chat|conversation|thread|run)\b/iu,
  /\bearlier (today|in this chat|in this thread)\b/iu,
  /\bit seems\b/iu,
  /\bmaybe\b/iu,
  /\bseems like\b/iu,
  /\bthe user asked\b/iu,
  /\bthe assistant said\b/iu,
  /这次/u,
  /刚才/u,
  /目前/u,
  /我们讨论/u,
  /这段对话/u,
  /这个线程/u,
  /似乎/u,
  /也许/u
]
const FORBIDDEN_MEMORY_TITLE_PATTERNS = [
  /^(i|we|you)\b/iu,
  /^(this|that|these|those)\b/iu,
  /^(discussion|conversation)\b/iu
]
const FORBIDDEN_MEMORY_CONTENT_PATTERNS = [
  /\b(asked|said|mentioned|talked about|discussed)\b/iu,
  /\bconversation\b/iu,
  /用户/u,
  /助手/u,
  /对话/u
]
const MAX_MEMORY_TITLE_LENGTH = 80
const MAX_MEMORY_CONTENT_LENGTH = 320
const MAX_MEMORY_TOPIC_LENGTH = 64
const MIN_MEMORY_CONTENT_LENGTH = 20
const MIN_MEMORY_TITLE_LENGTH = 3
const MIN_MEMORY_TOPIC_LENGTH = 3

function clampWeight(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined
  }

  return Math.max(0, Math.min(1, value))
}

function normalizeTopicKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-+/gu, '-')
    .slice(0, MAX_MEMORY_TOPIC_LENGTH)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function clampMemorySearchLimit(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_MEMORY_TOOL_LIMIT
  }

  return Math.max(1, Math.min(10, Math.trunc(value)))
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

function hasForbiddenMemoryPhrase(value: string): boolean {
  return FORBIDDEN_MEMORY_PHRASES.some((pattern) => pattern.test(value))
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value))
}

function normalizeUnitType(value: unknown): MemoryUnitType {
  return MEMORY_UNIT_TYPES.includes(value as MemoryUnitType) ? (value as MemoryUnitType) : 'fact'
}

function buildTopicLabel(topic: string): string {
  return `topic:${topic}`
}

function humanizeTopic(topic: string): string {
  return topic
    .split('-')
    .filter(Boolean)
    .map((segment) =>
      segment.length <= 3
        ? segment.toUpperCase()
        : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`
    )
    .join(' ')
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
          topic:
            typeof item.topic === 'string'
              ? normalizeTopicKey(normalizeWhitespace(item.topic))
              : undefined,
          reason: typeof item.reason === 'string' ? normalizeWhitespace(item.reason) : undefined,
          weight: clampWeight(item.weight)
        }
      ]
    })
    .slice(0, 3)
}

function normalizeMemoryCandidate(raw: {
  content?: unknown
  importance?: unknown
  title?: unknown
  topic?: unknown
  unitType?: unknown
}): MemoryCandidate | null {
  const rawTopic = typeof raw.topic === 'string' ? normalizeWhitespace(raw.topic) : ''
  const rawTitle = typeof raw.title === 'string' ? normalizeWhitespace(raw.title) : ''
  const rawContent = typeof raw.content === 'string' ? normalizeWhitespace(raw.content) : ''

  const topic = normalizeTopicKey(rawTopic || rawTitle)
  const title = truncate(
    rawTitle.replace(/[.!?。！？:：]+$/u, '').trim() || humanizeTopic(topic),
    MAX_MEMORY_TITLE_LENGTH
  )
  const content = truncate(rawContent.replace(/^[-*]\s*/u, '').trim(), MAX_MEMORY_CONTENT_LENGTH)

  if (!topic || !title || !content) {
    return null
  }

  if (
    topic.length < MIN_MEMORY_TOPIC_LENGTH ||
    title.length < MIN_MEMORY_TITLE_LENGTH ||
    content.length < MIN_MEMORY_CONTENT_LENGTH
  ) {
    return null
  }

  if (title.includes('\n') || content.includes('\n')) {
    return null
  }

  if (
    hasForbiddenMemoryPhrase(title) ||
    hasForbiddenMemoryPhrase(content) ||
    matchesAnyPattern(title, FORBIDDEN_MEMORY_TITLE_PATTERNS) ||
    matchesAnyPattern(content, FORBIDDEN_MEMORY_CONTENT_PATTERNS)
  ) {
    return null
  }

  return {
    topic,
    title,
    content,
    importance: clampWeight(raw.importance),
    unitType: normalizeUnitType(raw.unitType)
  }
}

function chooseBetterContent(left: string, right: string): string {
  if (left === right) {
    return left
  }

  return right.length > left.length ? right : left
}

function mergeCandidatePair(left: MemoryCandidate, right: MemoryCandidate): MemoryCandidate {
  return {
    topic: left.topic,
    title: left.title.length <= right.title.length ? left.title : right.title,
    content: chooseBetterContent(left.content, right.content),
    importance: Math.max(left.importance ?? 0, right.importance ?? 0) || undefined,
    unitType: left.unitType === right.unitType ? left.unitType : right.unitType
  }
}

function mergeCandidatesByTopic(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const merged = new Map<string, MemoryCandidate>()

  for (const candidate of candidates) {
    const existing = merged.get(candidate.topic)
    merged.set(candidate.topic, existing ? mergeCandidatePair(existing, candidate) : candidate)
  }

  return [...merged.values()]
}

function parseMemoryCandidates(text: string): MemoryCandidate[] {
  const parsed = parseJsonEnvelope<CandidateEnvelope>(text)
  if (!parsed?.candidates || !Array.isArray(parsed.candidates)) {
    return []
  }

  return mergeCandidatesByTopic(
    parsed.candidates
      .map((item) => normalizeMemoryCandidate(item))
      .filter((item): item is MemoryCandidate => item !== null)
      .slice(0, 8)
  )
}

function normalizeDedupKey(input: { title: string; content: string }): string {
  return `${input.title}\n${input.content}`
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim()
}

function tokenizeForSimilarity(value: string): string[] {
  return normalizeDedupKey({ title: value, content: '' })
    .split(/\s+/u)
    .filter((token) => token.length > 1)
}

function computeTokenOverlap(left: string, right: string): number {
  const leftTokens = new Set(tokenizeForSimilarity(left))
  const rightTokens = new Set(tokenizeForSimilarity(right))

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0
  }

  let shared = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1
    }
  }

  return shared / Math.max(leftTokens.size, rightTokens.size)
}

function buildHistoryExcerpt(history: MessageRecord[]): string {
  return history
    .slice(-4)
    .map((message) => `[${message.role}] ${normalizeWhitespace(message.content)}`)
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
        'Schema: {"queries":[{"topic":"string","query":"string","reason":"string","weight":0.0}]}',
        'Produce 0-2 focused semantic queries.',
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
        'Schema: {"queries":[{"topic":"string","query":"string","reason":"string","weight":0.0}]}',
        'Produce 0-3 focused semantic queries.',
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
  input: {
    history: MessageRecord[]
    isExternalChannel?: boolean
    signal?: AbortSignal
    userQuery: string
  }
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

      return provider.searchMemories({
        limit: clampMemorySearchLimit(input.limit),
        query,
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

    async recallForContext(input: RecallMemoryInput): Promise<RecallForContextResult> {
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
        signal: input.signal
      })
      const candidates = await deriveMemoryCandidates(result)
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
