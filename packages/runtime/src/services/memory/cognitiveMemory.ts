import type { MessageRecord, ThreadRecord } from '@yachiyo/shared/protocol'
import { messageRowId, threadRowId } from '@yachiyo/shared/sourceRowIds'

export type CognitiveRowStatus = 'active' | 'deprecated' | 'conflicted'

export interface CognitiveEvidenceRef {
  kind: 'message' | 'run' | 'thread' | 'tool' | 'manual'
  threadId?: string
  messageId?: string
  runId?: string
  toolCallId?: string
  note?: string
}

export interface CognitiveColumn {
  name: string
  description?: string
}

export interface CognitiveRelation {
  id: string
  name: string
  purpose: string
  columns: CognitiveColumn[]
  createdAt: string
  updatedAt: string
}

export interface CognitiveRow {
  id: string
  relation: string
  key: string
  values: Record<string, string>
  subjects: string[]
  aliases: string[]
  triggers: string[]
  scope: Record<string, string>
  evidence: CognitiveEvidenceRef[]
  confidence: number
  status: CognitiveRowStatus
  activationText: string
  activationCount: number
  lastActivatedAt?: string
  createdAt: string
  updatedAt: string
}

export interface CognitiveEvent {
  id: string
  operation: CognitivePatchOperation
  createdAt: string
}

export interface CognitiveMemoryState {
  events: CognitiveEvent[]
  relations: CognitiveRelation[]
  rows: CognitiveRow[]
}

interface CognitivePatchOperationBase {
  evidence: CognitiveEvidenceRef[]
}

export interface UpsertCognitiveRelationOperation extends CognitivePatchOperationBase {
  type: 'upsertRelation'
  relation: string
  purpose?: string
  columns?: Array<string | CognitiveColumn>
}

export interface UpsertCognitiveRowOperation extends CognitivePatchOperationBase {
  type: 'upsertRow'
  relation: string
  key: string
  values: Record<string, unknown>
  subjects?: string[]
  aliases?: string[]
  triggers?: string[]
  scope?: Record<string, unknown>
  confidence?: number
  status?: CognitiveRowStatus
}

export interface DeprecateCognitiveRowOperation extends CognitivePatchOperationBase {
  type: 'deprecateRow'
  relation: string
  key: string
  reason?: string
}

export type CognitivePatchOperation =
  | UpsertCognitiveRelationOperation
  | UpsertCognitiveRowOperation
  | DeprecateCognitiveRowOperation

export interface CognitivePatch {
  operations: CognitivePatchOperation[]
}

export interface ApplyCognitivePatchOptions {
  createId: () => string
  now: string
}

export interface ActivateCognitiveRowsInput {
  history: MessageRecord[]
  limit: number
  now: string
  thread: ThreadRecord
  userQuery: string
}

export interface SearchCognitiveRowsInput {
  limit: number
  query: string
  relation?: string
}

const DEFAULT_CONFIDENCE = 0.6
const MAX_RENDERED_FIELDS = 4
const MAX_RENDERED_SOURCE_REFS = 3
const MIN_ACTIVATION_CUE_SCORE = 0.75
const AUTO_FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const AUTO_FORGET_PROTECTED_RELATIONS = new Set([
  'user_preferences',
  'key_decisions',
  'workflow_procedures',
  'active_plans'
])

export interface CognitiveEvidenceSourceRefs {
  sourceThreadIds: string[]
  sourceThreadRowIds: string[]
  sourceMessageRowIds: string[]
}

export function createEmptyCognitiveMemoryState(): CognitiveMemoryState {
  return { events: [], relations: [], rows: [] }
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value)
}

export function collectCognitiveEvidenceSourceRefs(input: {
  evidence: CognitiveEvidenceRef[]
}): CognitiveEvidenceSourceRefs {
  const sourceThreadIds: string[] = []
  const sourceMessageRowIds: string[] = []

  for (const ref of input.evidence) {
    if (ref.threadId) {
      pushUnique(sourceThreadIds, ref.threadId)
    }
    if (ref.kind === 'message' && ref.threadId && ref.messageId) {
      pushUnique(sourceMessageRowIds, messageRowId(ref.threadId, ref.messageId))
    }
  }

  return {
    sourceThreadIds,
    sourceThreadRowIds: sourceThreadIds.map(threadRowId),
    sourceMessageRowIds
  }
}

function renderSourceRefs(row: CognitiveRow): string[] {
  const refs = collectCognitiveEvidenceSourceRefs(row)
  const fields: string[] = []
  const threadRows = refs.sourceThreadRowIds.slice(0, MAX_RENDERED_SOURCE_REFS)
  const messageRows = refs.sourceMessageRowIds.slice(0, MAX_RENDERED_SOURCE_REFS)

  if (threadRows.length > 0) {
    fields.push(`source_threads=${threadRows.join(', ')}`)
  }
  if (messageRows.length > 0) {
    fields.push(`source_messages=${messageRows.join(', ')}`)
  }
  return fields
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

export function normalizeCognitiveName(value: string): string {
  return normalizeWhitespace(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
}

function normalizeLooseText(value: string): string {
  return normalizeWhitespace(value).normalize('NFKC').toLowerCase()
}

function normalizeStringArray(value: string[] | undefined): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const item of value ?? []) {
    const normalized = normalizeWhitespace(item)
    const key = normalized.toLowerCase()
    if (!normalized || seen.has(key)) continue
    result.push(normalized)
    seen.add(key)
  }

  return result
}

function normalizeEvidence(value: CognitiveEvidenceRef[]): CognitiveEvidenceRef[] {
  return value.filter((entry) => entry.kind && Object.keys(entry).length > 1)
}

function normalizeColumns(columns: Array<string | CognitiveColumn> | undefined): CognitiveColumn[] {
  const result: CognitiveColumn[] = []
  const seen = new Set<string>()

  for (const column of columns ?? []) {
    const name = normalizeCognitiveName(typeof column === 'string' ? column : column.name)
    if (!name || seen.has(name)) continue
    result.push({
      name,
      ...(typeof column !== 'string' && column.description?.trim()
        ? { description: normalizeWhitespace(column.description) }
        : {})
    })
    seen.add(name)
  }

  return result
}

function mergeColumns(left: CognitiveColumn[], right: CognitiveColumn[]): CognitiveColumn[] {
  const merged = new Map<string, CognitiveColumn>()
  for (const column of left) merged.set(column.name, column)
  for (const column of right) {
    const existing = merged.get(column.name)
    merged.set(column.name, {
      ...existing,
      ...column,
      ...(existing?.description && !column.description ? { description: existing.description } : {})
    })
  }
  return [...merged.values()]
}

function normalizeValues(values: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = normalizeCognitiveName(rawKey)
    if (!key) continue
    const value = normalizeWhitespace(String(rawValue ?? ''))
    if (value) result[key] = value
  }
  return result
}

function normalizeScope(scope: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(scope ?? {})) {
    const key = normalizeCognitiveName(rawKey)
    const value = normalizeWhitespace(String(rawValue ?? ''))
    if (key && value) result[key] = value
  }
  return result
}

function clampConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONFIDENCE
  return Math.max(0, Math.min(1, value))
}

function buildActivationText(row: {
  aliases: string[]
  key: string
  relation: string
  scope: Record<string, string>
  subjects: string[]
  triggers: string[]
  values: Record<string, string>
}): string {
  return normalizeLooseText(
    [
      row.relation,
      row.key,
      ...Object.keys(row.values),
      ...Object.values(row.values),
      ...row.subjects,
      ...row.aliases,
      ...row.triggers,
      ...Object.values(row.scope)
    ].join(' ')
  )
}

function upsertRelation(
  state: CognitiveMemoryState,
  operation: UpsertCognitiveRelationOperation,
  options: ApplyCognitivePatchOptions
): void {
  const name = normalizeCognitiveName(operation.relation)
  if (!name) return

  const columns = normalizeColumns(operation.columns)
  const existing = state.relations.find((relation) => relation.name === name)
  if (existing) {
    existing.purpose = operation.purpose?.trim()
      ? normalizeWhitespace(operation.purpose)
      : existing.purpose
    existing.columns = mergeColumns(existing.columns, columns)
    existing.updatedAt = options.now
    return
  }

  state.relations.push({
    id: options.createId(),
    name,
    purpose: operation.purpose?.trim() ? normalizeWhitespace(operation.purpose) : '',
    columns,
    createdAt: options.now,
    updatedAt: options.now
  })
}

function upsertRow(
  state: CognitiveMemoryState,
  operation: UpsertCognitiveRowOperation,
  options: ApplyCognitivePatchOptions
): void {
  const relation = normalizeCognitiveName(operation.relation)
  const key = normalizeCognitiveName(operation.key)
  if (!relation || !key) return

  const values = normalizeValues(operation.values)
  if (Object.keys(values).length === 0) return

  const subjects = normalizeStringArray(operation.subjects)
  const aliases = normalizeStringArray(operation.aliases)
  const triggers = normalizeStringArray(operation.triggers)
  const scope = normalizeScope(operation.scope)
  const evidence = normalizeEvidence(operation.evidence)
  const confidence = clampConfidence(operation.confidence)
  const status = operation.status ?? 'active'
  const existing = state.rows.find((row) => row.relation === relation && row.key === key)

  const next = {
    relation,
    key,
    values,
    subjects,
    aliases,
    triggers,
    scope,
    evidence,
    confidence,
    status,
    activationText: ''
  }
  next.activationText = buildActivationText(next)

  if (existing) {
    existing.values = { ...existing.values, ...values }
    existing.subjects = normalizeStringArray([...existing.subjects, ...subjects])
    existing.aliases = normalizeStringArray([...existing.aliases, ...aliases])
    existing.triggers = normalizeStringArray([...existing.triggers, ...triggers])
    existing.scope = { ...existing.scope, ...scope }
    existing.evidence = [...existing.evidence, ...evidence]
    existing.confidence = Math.max(existing.confidence, confidence)
    existing.status = status
    existing.activationText = buildActivationText(existing)
    existing.updatedAt = options.now
    return
  }

  state.rows.push({
    id: options.createId(),
    ...next,
    activationCount: 0,
    createdAt: options.now,
    updatedAt: options.now
  })
}

function deprecateRow(
  state: CognitiveMemoryState,
  operation: DeprecateCognitiveRowOperation,
  options: ApplyCognitivePatchOptions
): void {
  const relation = normalizeCognitiveName(operation.relation)
  const key = normalizeCognitiveName(operation.key)
  const row = state.rows.find(
    (candidate) => candidate.relation === relation && candidate.key === key
  )
  if (!row) return

  row.status = 'deprecated'
  row.updatedAt = options.now
  row.evidence = [...row.evidence, ...normalizeEvidence(operation.evidence)]
  if (operation.reason?.trim()) {
    row.triggers = normalizeStringArray([...row.triggers, operation.reason])
    row.activationText = buildActivationText(row)
  }
}

function cloneCognitiveMemoryState(state: CognitiveMemoryState): CognitiveMemoryState {
  return {
    events: state.events.map((event) => ({
      ...event,
      operation: {
        ...event.operation,
        evidence: event.operation.evidence.map((entry) => ({ ...entry }))
      }
    })),
    relations: state.relations.map((relation) => ({
      ...relation,
      columns: relation.columns.map((column) => ({ ...column }))
    })),
    rows: state.rows.map((row) => ({
      ...row,
      activationCount: row.activationCount ?? 0,
      aliases: [...row.aliases],
      evidence: row.evidence.map((entry) => ({ ...entry })),
      scope: { ...row.scope },
      subjects: [...row.subjects],
      triggers: [...row.triggers],
      values: { ...row.values }
    }))
  }
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function hasManualEvidence(row: CognitiveRow): boolean {
  return row.evidence.some((entry) => entry.kind === 'manual')
}

function hasWeakEvidence(row: CognitiveRow): boolean {
  const nonManualEvidence = row.evidence.filter((entry) => entry.kind !== 'manual')
  if (nonManualEvidence.length <= 2) return true

  const threadIds = new Set(
    nonManualEvidence
      .map((entry) => entry.threadId)
      .filter((threadId): threadId is string => typeof threadId === 'string' && threadId.length > 0)
  )
  return threadIds.size === 1
}

function shouldAutoForgetRow(row: CognitiveRow, now: string): boolean {
  if (row.status !== 'active') return false
  if (AUTO_FORGET_PROTECTED_RELATIONS.has(row.relation)) return false
  if (hasManualEvidence(row)) return false
  if ((row.activationCount ?? 0) > 1) return false
  if (!hasWeakEvidence(row)) return false

  const updatedAt = parseTimestamp(row.updatedAt)
  const lastActivatedAt = parseTimestamp(row.lastActivatedAt)
  const lastTouchedAt = Math.max(
    updatedAt ?? Number.NEGATIVE_INFINITY,
    lastActivatedAt ?? Number.NEGATIVE_INFINITY
  )
  const nowTimestamp = parseTimestamp(now)
  if (!Number.isFinite(lastTouchedAt) || nowTimestamp === null) return false

  return nowTimestamp - lastTouchedAt >= AUTO_FORGET_AFTER_MS
}

function autoForgetRows(state: CognitiveMemoryState, options: ApplyCognitivePatchOptions): void {
  for (const row of state.rows) {
    if (!shouldAutoForgetRow(row, options.now)) continue

    const operation: DeprecateCognitiveRowOperation = {
      type: 'deprecateRow',
      relation: row.relation,
      key: row.key,
      reason: 'Automatic forgetting: inactive low-frequency memory older than 30 days.',
      evidence: [{ kind: 'manual', note: 'Automatic forgetting.' }]
    }
    deprecateRow(state, operation, options)
    state.events.push({
      id: options.createId(),
      operation,
      createdAt: options.now
    })
  }
}

export function applyCognitivePatchToState(
  state: CognitiveMemoryState,
  patch: CognitivePatch,
  options: ApplyCognitivePatchOptions
): CognitiveMemoryState {
  const next = cloneCognitiveMemoryState(state)

  for (const operation of patch.operations) {
    if (operation.evidence.length === 0) continue

    if (operation.type === 'upsertRelation') upsertRelation(next, operation, options)
    if (operation.type === 'upsertRow') upsertRow(next, operation, options)
    if (operation.type === 'deprecateRow') deprecateRow(next, operation, options)

    next.events.push({
      id: options.createId(),
      operation,
      createdAt: options.now
    })
  }

  autoForgetRows(next, options)
  return next
}

export function markCognitiveRowsActivated(
  state: CognitiveMemoryState,
  input: { now: string; rowIds: string[] }
): CognitiveMemoryState {
  if (input.rowIds.length === 0) return state

  const rowIds = new Set(input.rowIds)
  const next = cloneCognitiveMemoryState(state)
  for (const row of next.rows) {
    if (!rowIds.has(row.id)) continue
    row.activationCount = (row.activationCount ?? 0) + 1
    row.lastActivatedAt = input.now
  }
  return next
}

function tokenize(value: string): string[] {
  return (
    normalizeLooseText(value)
      .match(/[a-z0-9]+|[\u3400-\u9fff]{2,}/gu)
      ?.filter((token) => token.length > 1) ?? []
  )
}

function buildTextTerms(value: string): string[] {
  const tokens = tokenize(value)
  const terms = new Set(tokens)

  for (let index = 0; index < tokens.length - 1; index += 1) {
    terms.add(`${tokens[index]} ${tokens[index + 1]}`)
  }

  return [...terms]
}

function scoreTermMatches(activationText: string, terms: string[]): number {
  return terms.reduce((score, term) => score + (activationText.includes(term) ? 0.45 : 0), 0)
}

function scorePhraseMatches(row: CognitiveRow, queryText: string): number {
  let score = 0
  for (const subject of row.subjects) {
    if (queryText.includes(normalizeLooseText(subject))) score += 3
  }
  for (const alias of row.aliases) {
    if (queryText.includes(normalizeLooseText(alias))) score += 2.5
  }
  for (const trigger of row.triggers) {
    if (queryText.includes(normalizeLooseText(trigger))) score += 2
  }
  return score
}

function normalizeCue(value: string): string {
  return normalizeLooseText(value)
    .replace(/[^a-z0-9\u3400-\u9fff]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function buildActivationCues(row: CognitiveRow): string[] {
  const cues = [row.relation, row.key, ...row.subjects, ...row.aliases, ...row.triggers]
  const seen = new Set<string>()

  for (const cue of cues) {
    const normalized = normalizeCue(cue)
    if (normalized) seen.add(normalized)
  }

  return [...seen]
}

function buildCueDocumentFrequencies(rows: CognitiveRow[]): Map<string, number> {
  const frequencies = new Map<string, number>()

  for (const row of rows) {
    for (const cue of buildActivationCues(row)) {
      frequencies.set(cue, (frequencies.get(cue) ?? 0) + 1)
    }
  }

  return frequencies
}

function scoreActivationCue(input: {
  activeRowCount: number
  cue: string
  frequencies: Map<string, number>
  queryText: string
}): number {
  if (!input.queryText.includes(input.cue)) return 0

  const documentFrequency = input.frequencies.get(input.cue) ?? input.activeRowCount
  const maxIdf = Math.log1p(input.activeRowCount)
  if (maxIdf <= 0) return 0

  return Math.log1p(input.activeRowCount / documentFrequency) / maxIdf
}

export function activateCognitiveRows(
  state: CognitiveMemoryState,
  input: ActivateCognitiveRowsInput
): CognitiveRow[] {
  const activeRows = state.rows.filter((row) => row.status === 'active')
  const frequencies = buildCueDocumentFrequencies(activeRows)
  const queryText = normalizeCue(input.userQuery)

  return activeRows
    .map((row) => {
      const cueScore = buildActivationCues(row).reduce(
        (score, cue) =>
          score +
          scoreActivationCue({
            activeRowCount: activeRows.length,
            cue,
            frequencies,
            queryText
          }),
        0
      )
      return {
        cueScore,
        row,
        score: cueScore + row.confidence * 0.05
      }
    })
    .filter((entry) => entry.cueScore >= MIN_ACTIVATION_CUE_SCORE)
    .sort(
      (left, right) =>
        right.score - left.score || left.row.updatedAt.localeCompare(right.row.updatedAt)
    )
    .slice(0, input.limit)
    .map((entry) => entry.row)
}

export function searchCognitiveRows(
  state: CognitiveMemoryState,
  input: SearchCognitiveRowsInput
): CognitiveRow[] {
  const relation = input.relation ? normalizeCognitiveName(input.relation) : undefined
  const queryTerms = buildTextTerms(input.query)
  const queryText = normalizeLooseText(input.query)

  return state.rows
    .filter((row) => row.status === 'active' && (!relation || row.relation === relation))
    .map((row) => {
      const activationText = row.activationText || buildActivationText(row)
      return {
        row,
        score:
          scoreTermMatches(activationText, queryTerms) +
          scorePhraseMatches(row, queryText) +
          row.confidence * 0.25
      }
    })
    .filter((entry) => entry.score > 0.65)
    .sort(
      (left, right) =>
        right.score - left.score || left.row.updatedAt.localeCompare(right.row.updatedAt)
    )
    .slice(0, input.limit)
    .map((entry) => entry.row)
}

const DIFFUSE_DECAY = 0.5
const DIFFUSE_MAX_DEPTH = 2
const DIFFUSE_MIN_AFFINITY = 0.15
const DIFFUSE_MIN_CONFIDENCE = 0.4
const DIFFUSE_MAX_NEIGHBORS_PER_SEED = 3

function normalizeStringSet(values: string[]): Set<string> {
  const normalized = values
    .map((value) => normalizeLooseText(value))
    .filter((value) => value.length > 0)
  return new Set(normalized)
}

function computeRowAffinity(a: CognitiveRow, b: CognitiveRow): number {
  const subjectsA = normalizeStringSet(a.subjects)
  const subjectsB = normalizeStringSet(b.subjects)
  let sharedSubjects = 0
  for (const s of subjectsA) {
    if (subjectsB.has(s)) sharedSubjects += 1
  }

  const aliasesA = normalizeStringSet(a.aliases)
  const aliasesB = normalizeStringSet(b.aliases)
  let sharedAliases = 0
  for (const s of aliasesA) {
    if (aliasesB.has(s)) sharedAliases += 1
  }

  const triggersA = normalizeStringSet(a.triggers)
  const triggersB = normalizeStringSet(b.triggers)
  let sharedTriggers = 0
  for (const s of triggersA) {
    if (triggersB.has(s)) sharedTriggers += 1
  }

  const sharedScore = sharedSubjects * 0.3 + sharedAliases * 0.25 + sharedTriggers * 0.2
  if (sharedScore <= 0) return 0

  const sameWorkspace =
    a.scope.workspacePath && a.scope.workspacePath === b.scope.workspacePath ? 0.15 : 0
  const sameThread = a.scope.threadId && a.scope.threadId === b.scope.threadId ? 0.1 : 0
  const sameRelation = a.relation === b.relation ? 0.05 : 0

  return sharedScore + sameWorkspace + sameThread + sameRelation
}

export function diffuseCognitiveRows(
  state: CognitiveMemoryState,
  seedRows: CognitiveRow[],
  userQuery: string,
  maxExtra: number = Math.min(2, seedRows.length)
): CognitiveRow[] {
  if (seedRows.length === 0 || maxExtra <= 0) return []

  const normalizedQuery = normalizeLooseText(userQuery)
  const seedIds = new Set(seedRows.map((r) => r.id))
  const activeRows = state.rows.filter((r) => r.status === 'active')

  const rowById = new Map<string, CognitiveRow>()
  for (const row of activeRows) rowById.set(row.id, row)

  const featureToRowIds = new Map<string, Set<string>>()
  const rowFeatures = new Map<string, string[]>()

  for (const row of activeRows) {
    const features = new Set<string>()
    for (const value of [...row.subjects, ...row.aliases, ...row.triggers]) {
      const normalized = normalizeLooseText(value)
      if (normalized) features.add(normalized)
    }
    const featureList = [...features]
    rowFeatures.set(row.id, featureList)
    for (const feature of featureList) {
      const ids = featureToRowIds.get(feature) ?? new Set<string>()
      ids.add(row.id)
      featureToRowIds.set(feature, ids)
    }
  }

  function getNeighbors(rowId: string): Array<[string, number]> {
    const row = rowById.get(rowId)
    if (!row) return []

    const candidates = new Set<string>()
    for (const feature of rowFeatures.get(rowId) ?? []) {
      for (const candidateId of featureToRowIds.get(feature) ?? []) {
        if (candidateId !== rowId) candidates.add(candidateId)
      }
    }

    const neighbors: Array<[string, number]> = []
    for (const candidateId of candidates) {
      const candidate = rowById.get(candidateId)
      if (!candidate) continue
      const affinity = computeRowAffinity(row, candidate)
      if (affinity >= DIFFUSE_MIN_AFFINITY) neighbors.push([candidateId, affinity])
    }

    neighbors.sort((a, b) => b[1] - a[1])
    return neighbors
  }

  const scores = new Map<string, number>()
  const frontier: Array<{ rowId: string; accumulatedScore: number; depth: number }> = []

  for (const seed of seedRows) {
    const sorted = getNeighbors(seed.id)
      .filter(([id]) => !seedIds.has(id))
      .slice(0, DIFFUSE_MAX_NEIGHBORS_PER_SEED)

    for (const [neighborId, affinity] of sorted) {
      frontier.push({
        rowId: neighborId,
        accumulatedScore: affinity * DIFFUSE_DECAY,
        depth: 1
      })
    }
  }

  while (frontier.length > 0) {
    const current = frontier.shift()!
    if (current.depth > DIFFUSE_MAX_DEPTH) continue

    const row = rowById.get(current.rowId)
    if (!row || seedIds.has(row.id)) continue
    if (row.confidence < DIFFUSE_MIN_CONFIDENCE) continue
    if (scorePhraseMatches(row, normalizedQuery) <= 0) continue

    const existingScore = scores.get(current.rowId) ?? 0
    if (current.accumulatedScore > existingScore) {
      scores.set(current.rowId, current.accumulatedScore)
    }

    if (current.depth < DIFFUSE_MAX_DEPTH) {
      for (const [neighborId, affinity] of getNeighbors(current.rowId)) {
        if (seedIds.has(neighborId)) continue
        const nextScore = current.accumulatedScore * affinity * DIFFUSE_DECAY
        if (nextScore < 0.001) continue
        frontier.push({
          rowId: neighborId,
          accumulatedScore: nextScore,
          depth: current.depth + 1
        })
      }
    }
  }

  const candidates = [...scores.entries()]
    .map(([rowId, score]) => ({ row: rowById.get(rowId), score }))
    .filter(
      (entry): entry is { row: CognitiveRow; score: number } =>
        !!entry.row && !seedIds.has(entry.row.id)
    )
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.row.confidence !== a.row.confidence) return b.row.confidence - a.row.confidence
      return b.row.updatedAt.localeCompare(a.row.updatedAt)
    })

  const result: CognitiveRow[] = []
  const relationCounts = new Map<string, number>()

  for (const candidate of candidates) {
    const relationCount = relationCounts.get(candidate.row.relation) ?? 0
    if (relationCount >= 1) continue
    result.push(candidate.row)
    relationCounts.set(candidate.row.relation, relationCount + 1)
    if (result.length >= maxExtra) break
  }

  return result
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = /\{[\s\S]*\}/u.exec(text)
    return match ? JSON.parse(match[0]) : null
  }
}

function parseEvidenceArray(
  value: unknown,
  fallbackEvidence: CognitiveEvidenceRef[]
): CognitiveEvidenceRef[] {
  if (!Array.isArray(value)) return fallbackEvidence
  const evidence = value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry): CognitiveEvidenceRef => {
      const kind: CognitiveEvidenceRef['kind'] =
        entry.kind === 'message' ||
        entry.kind === 'run' ||
        entry.kind === 'thread' ||
        entry.kind === 'tool' ||
        entry.kind === 'manual'
          ? entry.kind
          : 'manual'
      return {
        kind,
        ...(typeof entry.threadId === 'string' ? { threadId: entry.threadId } : {}),
        ...(typeof entry.messageId === 'string' ? { messageId: entry.messageId } : {}),
        ...(typeof entry.runId === 'string' ? { runId: entry.runId } : {}),
        ...(typeof entry.toolCallId === 'string' ? { toolCallId: entry.toolCallId } : {}),
        ...(typeof entry.note === 'string' ? { note: entry.note } : {})
      }
    })
  return evidence.length > 0 ? evidence : fallbackEvidence
}

function parseColumns(value: unknown): Array<string | CognitiveColumn> | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .map((column) => {
      if (typeof column === 'string') return column
      if (!column || typeof column !== 'object') return null
      const raw = column as Record<string, unknown>
      if (typeof raw.name !== 'string') return null
      return {
        name: raw.name,
        ...(typeof raw.description === 'string' ? { description: raw.description } : {})
      }
    })
    .filter((column): column is string | CognitiveColumn => column !== null)
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string')
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function parseCognitivePatch(
  text: string,
  fallbackEvidence: CognitiveEvidenceRef[]
): CognitivePatch {
  const parsed = parseJsonObject(text)
  if (!parsed || typeof parsed !== 'object') return { operations: [] }
  const operations = (parsed as { operations?: unknown }).operations
  if (!Array.isArray(operations)) return { operations: [] }

  const normalized: CognitivePatchOperation[] = []
  for (const rawOperation of operations) {
    if (!rawOperation || typeof rawOperation !== 'object') continue
    const operation = rawOperation as Record<string, unknown>
    const evidence = parseEvidenceArray(operation.evidence, fallbackEvidence)

    if (operation.type === 'upsertRelation' && typeof operation.relation === 'string') {
      normalized.push({
        type: 'upsertRelation',
        relation: operation.relation,
        ...(typeof operation.purpose === 'string' ? { purpose: operation.purpose } : {}),
        ...(parseColumns(operation.columns) ? { columns: parseColumns(operation.columns) } : {}),
        evidence
      })
      continue
    }

    if (
      operation.type === 'upsertRow' &&
      typeof operation.relation === 'string' &&
      typeof operation.key === 'string' &&
      parseRecord(operation.values)
    ) {
      normalized.push({
        type: 'upsertRow',
        relation: operation.relation,
        key: operation.key,
        values: parseRecord(operation.values)!,
        ...(parseStringArray(operation.subjects)
          ? { subjects: parseStringArray(operation.subjects) }
          : {}),
        ...(parseStringArray(operation.aliases)
          ? { aliases: parseStringArray(operation.aliases) }
          : {}),
        ...(parseStringArray(operation.triggers)
          ? { triggers: parseStringArray(operation.triggers) }
          : {}),
        ...(parseRecord(operation.scope) ? { scope: parseRecord(operation.scope) } : {}),
        ...(typeof operation.confidence === 'number' ? { confidence: operation.confidence } : {}),
        ...(operation.status === 'active' ||
        operation.status === 'deprecated' ||
        operation.status === 'conflicted'
          ? { status: operation.status }
          : {}),
        evidence
      })
      continue
    }

    if (
      operation.type === 'deprecateRow' &&
      typeof operation.relation === 'string' &&
      typeof operation.key === 'string'
    ) {
      normalized.push({
        type: 'deprecateRow',
        relation: operation.relation,
        key: operation.key,
        ...(typeof operation.reason === 'string' ? { reason: operation.reason } : {}),
        evidence
      })
    }
  }

  return { operations: normalized }
}

export function renderCognitiveRowMemoryEntry(row: CognitiveRow): string {
  const fields = [
    ...Object.entries(row.values)
      .slice(0, MAX_RENDERED_FIELDS)
      .map(([key, value]) => `${key}=${value}`),
    ...renderSourceRefs(row)
  ].join('; ')

  return `[${row.relation}] ${row.key}: ${fields}`
}
