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
import type { AuxiliaryGenerationService } from '../../runtime/models/auxiliaryGeneration.ts'
import type { ModelRuntime } from '../../runtime/models/types.ts'
import {
  buildNextRecallState,
  filterRecalledMemories,
  shouldRecallBeforeRun,
  type RecallFilterCandidate
} from './recallPolicy.ts'
import { renderCognitiveRowMemoryEntry, type CognitiveEvidenceRef } from './cognitiveMemory.ts'
import type { CognitiveMemoryStore } from './cognitiveMemoryStore.ts'
import {
  clampMemorySearchLimit,
  filterByImportance,
  normalizeDedupKey,
  normalizeTopicKey,
  normalizeWhitespace,
  parseMemoryCandidates,
  sanitizeMemoryQueryText
} from './memoryService/parsing.ts'
export { sanitizeMemoryQueryText } from './memoryService/parsing.ts'
import { buildTopicLabel } from './memoryService/parsing.ts'
import { buildRunDistillationMessages, buildSaveThreadMessages } from './memoryService/prompts.ts'
import {
  compactMemoryEntry,
  collectStreamText,
  deriveMemoryCandidates,
  deriveQueryPlan,
  isProviderSettingsConfigured,
  reconcileMemoryCandidates,
  scoreTopicMatch,
  toMemoryConnectionFailureMessage
} from './memoryService/reconciliation.ts'
import {
  buildCandidatePatch,
  buildRunCognitivePatchMessages,
  buildSaveThreadCognitivePatchMessages,
  parsePatchOrCandidateFallback,
  toCognitiveSearchResult
} from './memoryService/cognitive.ts'

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

export type MemoryScopeLevel = 'global' | 'workspace' | 'thread'

export interface StructuredMemoryCandidate {
  key: string
  facts: Record<string, string>
  subjects: string[]
  unitType: MemoryUnitType
  importance?: number
  scope?: MemoryScopeLevel
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
  createMemory(
    item: StructuredMemoryCandidate,
    signal?: AbortSignal,
    scopeContext?: { threadId?: string; workspacePath?: string }
  ): Promise<{ savedCount: number }>
  validateAndCreateMemory(
    raw: {
      key?: string
      facts?: Record<string, string>
      subjects?: string[]
      unitType?: string
      importance?: number
      scope?: MemoryScopeLevel
    },
    signal?: AbortSignal,
    scopeContext?: { threadId?: string; workspacePath?: string }
  ): Promise<{ savedCount: number; rejected?: string }>
  distillCompletedRun(input: DistillRunMemoryInput): Promise<{ savedCount: number }>
  saveThread(input: SaveThreadMemoryInput): Promise<{ savedCount: number }>
}

export interface MemoryServiceDeps {
  auxiliaryGeneration: AuxiliaryGenerationService
  cognitiveStore?: CognitiveMemoryStore
  createModelRuntime: () => ModelRuntime
  createProvider: (config: SettingsConfig) => MemoryProvider
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
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
      const query = normalizeWhitespace(input.query)
      if (!query) {
        return []
      }

      if (deps.cognitiveStore) {
        const rows = await deps.cognitiveStore.searchRows({
          limit: clampMemorySearchLimit(input.limit),
          query,
          ...(input.topic ? { relation: normalizeTopicKey(input.topic) } : {})
        })
        return rows.map(toCognitiveSearchResult)
      }

      const provider = resolveProvider()
      if (!provider) {
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
      item: StructuredMemoryCandidate,
      signal?: AbortSignal,
      scopeContext?: { threadId?: string; workspacePath?: string }
    ): Promise<{ savedCount: number }> {
      if (deps.cognitiveStore) {
        return deps.cognitiveStore.applyPatch(
          buildCandidatePatch(
            item,
            [{ kind: 'manual', note: 'Explicit memory creation.' }],
            scopeContext
          )
        )
      }

      const provider = resolveProvider()
      if (!provider) {
        return { savedCount: 0 }
      }
      return provider.createMemories({
        items: [
          {
            topic: item.key,
            title: item.key,
            content: Object.entries(item.facts)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n'),
            unitType: item.unitType,
            importance: item.importance
          }
        ],
        signal
      })
    },

    async validateAndCreateMemory(
      raw: {
        key?: string
        facts?: Record<string, string>
        subjects?: string[]
        unitType?: string
        importance?: number
        scope?: MemoryScopeLevel
      },
      signal?: AbortSignal,
      scopeContext?: { threadId?: string; workspacePath?: string }
    ): Promise<{ savedCount: number; rejected?: string }> {
      const key = typeof raw.key === 'string' && raw.key.trim() ? normalizeWhitespace(raw.key) : ''
      const facts =
        raw.facts && typeof raw.facts === 'object' && !Array.isArray(raw.facts)
          ? Object.fromEntries(Object.entries(raw.facts).filter(([, v]) => typeof v === 'string'))
          : {}
      const subjects = Array.isArray(raw.subjects)
        ? raw.subjects.filter((s) => typeof s === 'string')
        : []

      if (!key || Object.keys(facts).length === 0 || subjects.length === 0) {
        return {
          savedCount: 0,
          rejected: 'Memory requires a stable key, structured facts, and at least one subject.'
        }
      }

      const candidate: StructuredMemoryCandidate = {
        key,
        facts,
        subjects,
        unitType: (typeof raw.unitType === 'string' &&
        [
          'fact',
          'preference',
          'decision',
          'plan',
          'procedure',
          'learning',
          'context',
          'event'
        ].includes(raw.unitType)
          ? raw.unitType
          : 'fact') as MemoryUnitType,
        importance:
          typeof raw.importance === 'number' && !Number.isNaN(raw.importance)
            ? Math.max(0, Math.min(1, raw.importance))
            : undefined,
        scope:
          typeof raw.scope === 'string' && ['global', 'workspace', 'thread'].includes(raw.scope)
            ? raw.scope
            : undefined
      }

      if (deps.cognitiveStore) {
        const result = await deps.cognitiveStore.applyPatch(
          buildCandidatePatch(
            candidate,
            [{ kind: 'manual', note: 'Explicit remember tool write.' }],
            scopeContext
          )
        )
        return { savedCount: result.savedCount }
      }

      const provider = resolveProvider()
      if (!provider) {
        return { savedCount: 0, rejected: 'Memory is not configured.' }
      }

      const result = await provider.createMemories({
        items: [
          {
            topic: candidate.key,
            title: candidate.key,
            content: Object.entries(candidate.facts)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n'),
            unitType: candidate.unitType,
            importance: candidate.importance
          }
        ],
        signal
      })
      return { savedCount: result.savedCount }
    },

    async testConnection(configOverride?: SettingsConfig): Promise<TestMemoryConnectionResult> {
      const config = configOverride ?? deps.readConfig()

      if (deps.cognitiveStore) {
        if (!isMemoryConfigured(config)) {
          return { ok: false, message: 'Built-in cognitive memory is disabled.' }
        }
        try {
          await deps.cognitiveStore.readState()
          return { ok: true, message: 'Built-in cognitive memory is ready.' }
        } catch (error) {
          return {
            ok: false,
            message: error instanceof Error ? error.message : 'Built-in cognitive memory failed.'
          }
        }
      }

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

      if (deps.cognitiveStore) {
        try {
          const rows = await deps.cognitiveStore.activateRows({
            history: input.history,
            limit: DEFAULT_CONTEXT_MEMORY_LIMIT,
            now: input.now,
            thread: input.thread,
            userQuery: input.userQuery
          })
          const candidates: RecallFilterCandidate[] = rows.map((row) => ({
            entry: renderCognitiveRowMemoryEntry(row),
            id: row.id,
            score: row.confidence
          }))
          const filtered = filterRecalledMemories({
            candidates,
            history: input.history,
            now: input.now,
            thread: input.thread,
            userQuery: input.userQuery
          })
          if (filtered.entries.length > 0) {
            const activatedDecision: RecallDecisionSnapshot = {
              shouldRecall: true,
              score: 1,
              reasons: ['cognitive-activation'],
              messagesSinceLastRecall: 0,
              charsSinceLastRecall: 0,
              idleMs: 0,
              noveltyScore: 0,
              novelTerms: []
            }
            return {
              decision: activatedDecision,
              entries: filtered.entries,
              thread: {
                ...input.thread,
                memoryRecall: buildNextRecallState({
                  didRecall: true,
                  decision: activatedDecision,
                  history: input.history,
                  now: input.now,
                  recentInjections: filtered.recentInjections,
                  thread: input.thread
                })
              }
            }
          }
        } catch (error) {
          if (input.signal?.aborted) throw error
          console.warn('[yachiyo][memory] cognitive activation failed; continuing without memory', {
            error: error instanceof Error ? error.message : String(error),
            threadId: input.thread.id
          })
        }
      }

      const decision = shouldRecallBeforeRun({
        history: input.history,
        now: input.now,
        thread: input.thread,
        userQuery: input.userQuery
      })
      if (!decision.shouldRecall) {
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

      const provider = resolveProvider()
      if (!provider) {
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
      if (deps.cognitiveStore) {
        const state = await deps.cognitiveStore.readState()
        const evidence: CognitiveEvidenceRef[] = input.thread
          ? [
              {
                kind: 'thread',
                threadId: input.thread.id,
                note: 'Completed run memory distillation.'
              }
            ]
          : [{ kind: 'manual', note: 'Completed run memory distillation.' }]
        const result = await deps.auxiliaryGeneration.generateText({
          messages: buildRunCognitivePatchMessages({
            assistantResponse: input.assistantResponse,
            state,
            userQuery: input.userQuery
          }),
          signal: input.signal,
          purpose: 'memory-distill'
        })
        if (result.status !== 'success') return { savedCount: 0 }
        return deps.cognitiveStore.applyPatch(parsePatchOrCandidateFallback(result.text, evidence))
      }

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
      if (input.messages.length === 0) {
        return { savedCount: 0 }
      }

      if (deps.cognitiveStore) {
        const settings = deps.readSettings()
        if (!isProviderSettingsConfigured(settings)) {
          throw new Error('The main chat model is not configured.')
        }

        const state = await deps.cognitiveStore.readState()
        const evidence: CognitiveEvidenceRef[] = input.messages.map((message) => ({
          kind: 'message' as const,
          messageId: message.id,
          threadId: message.threadId
        }))
        const text = await collectStreamText(deps.createModelRuntime(), {
          messages: buildSaveThreadCognitivePatchMessages({
            messages: input.messages,
            state
          }),
          settings,
          signal: input.signal
        })
        return deps.cognitiveStore.applyPatch(parsePatchOrCandidateFallback(text, evidence))
      }

      const provider = resolveProvider()
      if (!provider) {
        throw new Error('Memory is not enabled.')
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
