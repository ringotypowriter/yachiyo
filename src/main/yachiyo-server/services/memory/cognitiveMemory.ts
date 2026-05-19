import type { MessageRecord, ThreadRecord } from '../../../../shared/yachiyo/protocol.ts'

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

export function createEmptyCognitiveMemoryState(): CognitiveMemoryState {
  return { events: [], relations: [], rows: [] }
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

export function applyCognitivePatchToState(
  state: CognitiveMemoryState,
  patch: CognitivePatch,
  options: ApplyCognitivePatchOptions
): CognitiveMemoryState {
  const next: CognitiveMemoryState = {
    events: [...state.events],
    relations: state.relations.map((relation) => ({
      ...relation,
      columns: relation.columns.map((column) => ({ ...column }))
    })),
    rows: state.rows.map((row) => ({
      ...row,
      aliases: [...row.aliases],
      evidence: row.evidence.map((entry) => ({ ...entry })),
      scope: { ...row.scope },
      subjects: [...row.subjects],
      triggers: [...row.triggers],
      values: { ...row.values }
    }))
  }

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

  return next
}

function tokenize(value: string): string[] {
  return (
    normalizeLooseText(value)
      .match(/[a-z0-9]+|[\u3400-\u9fff]{2,}/gu)
      ?.filter((token) => token.length > 1) ?? []
  )
}

function buildQueryTerms(input: ActivateCognitiveRowsInput): string[] {
  const base = [
    input.userQuery,
    input.thread.title,
    input.thread.workspacePath ?? '',
    ...input.history.slice(-2).map((message) => message.content)
  ].join(' ')
  const tokens = tokenize(base)
  const terms = new Set(tokens)

  for (let index = 0; index < tokens.length - 1; index += 1) {
    terms.add(`${tokens[index]} ${tokens[index + 1]}`)
  }

  return [...terms]
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

function scoreScope(row: CognitiveRow, thread: ThreadRecord): number {
  if (row.scope.workspacepath && thread.workspacePath === row.scope.workspacepath) return 0.6
  if (row.scope.threadid && thread.id === row.scope.threadid) return 0.8
  return 0
}

export function activateCognitiveRows(
  state: CognitiveMemoryState,
  input: ActivateCognitiveRowsInput
): CognitiveRow[] {
  const terms = buildQueryTerms(input)
  const queryText = normalizeLooseText(
    [
      input.userQuery,
      input.thread.title,
      ...input.history.slice(-2).map((message) => message.content)
    ].join(' ')
  )

  return state.rows
    .filter((row) => row.status === 'active')
    .map((row) => {
      const activationText = row.activationText || buildActivationText(row)
      const overlapScore = terms.reduce(
        (score, term) => score + (activationText.includes(term) ? 0.45 : 0),
        0
      )
      return {
        row,
        score:
          overlapScore +
          scorePhraseMatches(row, queryText) +
          scoreScope(row, input.thread) +
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

export function searchCognitiveRows(
  state: CognitiveMemoryState,
  input: SearchCognitiveRowsInput
): CognitiveRow[] {
  const relation = input.relation ? normalizeCognitiveName(input.relation) : undefined
  const candidates = activateCognitiveRows(state, {
    history: [],
    limit: state.rows.length,
    now: new Date(0).toISOString(),
    thread: {
      id: 'cognitive-search',
      title: relation ?? '',
      updatedAt: new Date(0).toISOString()
    },
    userQuery: input.query
  })
  const filtered = relation ? candidates.filter((row) => row.relation === relation) : candidates
  return filtered.slice(0, input.limit)
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
  const fields = Object.entries(row.values)
    .slice(0, MAX_RENDERED_FIELDS)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')

  return `[${row.relation}] ${row.key}: ${fields}`
}
