import type {
  MessageRecord,
  RecallDecisionSnapshot,
  ProviderSettings,
  SettingsConfig,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import { isMemoryConfigured } from '../../../../shared/yachiyo/protocol.ts'
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
  normalizeTopicKey,
  normalizeWhitespace,
  sanitizeMemoryQueryText
} from './memoryService/parsing.ts'
export { sanitizeMemoryQueryText } from './memoryService/parsing.ts'
import { isProviderSettingsConfigured, collectStreamText } from './memoryService/generation.ts'
import {
  buildCandidatePatch,
  buildRunCognitivePatchMessages,
  buildSaveThreadCognitivePatchMessages,
  parsePatchOrCandidateFallback,
  toCognitiveSearchResult
} from './memoryService/cognitive.ts'

const DEFAULT_CONTEXT_MEMORY_LIMIT = 4

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
  sourceThreadIds?: string[]
  sourceThreadRowIds?: string[]
  sourceMessageRowIds?: string[]
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
  cognitiveStore: CognitiveMemoryStore
  createModelRuntime: () => ModelRuntime
  readConfig: () => SettingsConfig
  readSettings: () => ProviderSettings
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
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
      if (!query) return []

      const rows = await deps.cognitiveStore.searchRows({
        limit: clampMemorySearchLimit(input.limit),
        query,
        ...(input.topic ? { relation: normalizeTopicKey(input.topic) } : {})
      })
      return rows.map(toCognitiveSearchResult)
    },

    async createMemory(
      item: StructuredMemoryCandidate,
      _signal?: AbortSignal,
      scopeContext?: { threadId?: string; workspacePath?: string }
    ): Promise<{ savedCount: number }> {
      return deps.cognitiveStore.applyPatch(
        buildCandidatePatch(
          item,
          [{ kind: 'manual', note: 'Explicit memory creation.' }],
          scopeContext
        )
      )
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
      _signal?: AbortSignal,
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

      const result = await deps.cognitiveStore.applyPatch(
        buildCandidatePatch(
          candidate,
          [{ kind: 'manual', note: 'Explicit remember tool write.' }],
          scopeContext
        )
      )
      return { savedCount: result.savedCount }
    },

    async recallForContext(rawInput: RecallMemoryInput): Promise<RecallForContextResult> {
      const input: RecallMemoryInput = {
        ...rawInput,
        userQuery: sanitizeMemoryQueryText(rawInput.userQuery)
      }

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

      const decision = shouldRecallBeforeRun({
        history: input.history,
        now: input.now,
        thread: input.thread,
        userQuery: input.userQuery
      })
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
    },

    async distillCompletedRun(input: DistillRunMemoryInput): Promise<{ savedCount: number }> {
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
    },

    async saveThread(input: SaveThreadMemoryInput): Promise<{ savedCount: number }> {
      if (input.messages.length === 0) return { savedCount: 0 }

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
