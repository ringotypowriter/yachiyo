import { randomUUID } from 'node:crypto'

import { asc, eq, sql } from 'drizzle-orm'

import type { MemoryTermDocument, MemoryTermEntry } from '@yachiyo/shared/protocol'
import { openMigratedSqliteDatabase, type SqliteDb } from '../../storage/sqlite/sqliteRuntime.ts'
import {
  cognitiveEventsTable,
  cognitiveRelationsTable,
  cognitiveRowsTable
} from '../../storage/sqlite/schema.ts'
import {
  activateCognitiveRows,
  applyCognitivePatchToState,
  createEmptyCognitiveMemoryState,
  diffuseCognitiveRows,
  markCognitiveRowsActivated,
  searchCognitiveRows,
  type ActivateCognitiveRowsInput,
  type CognitiveColumn,
  type CognitiveEvent,
  type CognitiveEvidenceRef,
  type CognitiveMemoryState,
  type CognitivePatch,
  type CognitivePatchOperation,
  type CognitiveRelation,
  type CognitiveRow,
  type CognitiveRowStatus,
  type SearchCognitiveRowsInput
} from './cognitiveMemory.ts'

export interface CognitiveMemoryTermTopicCount {
  topic: string
  entryCount: number
}

export interface CognitiveMemoryTermPageInput {
  limit?: number
  offset?: number
}

export interface CognitiveMemoryTermPage {
  rows: CognitiveRow[]
  topicCounts: CognitiveMemoryTermTopicCount[]
  memoryCount: number
}

export interface CognitiveMemoryStore {
  applyPatch(patch: CognitivePatch, input?: { now?: string }): Promise<{ savedCount: number }>
  activateRows(input: ActivateCognitiveRowsInput): Promise<CognitiveRow[]>
  deleteRow(input: { id: string }): Promise<{ deleted: boolean }>
  readState(): Promise<CognitiveMemoryState>
  listTermRows(input?: CognitiveMemoryTermPageInput): Promise<CognitiveMemoryTermPage>
  searchRows(input: SearchCognitiveRowsInput): Promise<CognitiveRow[]>
}

interface SqliteCognitiveMemoryStoreOptions {
  dbPath: string
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function stringify(value: unknown): string {
  return JSON.stringify(value)
}

function toRelation(row: typeof cognitiveRelationsTable.$inferSelect): CognitiveRelation {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    columns: parseJson<CognitiveColumn[]>(row.columns, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function isCognitiveRowStatus(value: string): value is CognitiveRowStatus {
  return value === 'active' || value === 'deprecated' || value === 'conflicted'
}

function toRow(row: typeof cognitiveRowsTable.$inferSelect): CognitiveRow {
  return {
    id: row.id,
    relation: row.relation,
    key: row.key,
    values: parseJson<Record<string, string>>(row.values, {}),
    subjects: parseJson<string[]>(row.subjects, []),
    aliases: parseJson<string[]>(row.aliases, []),
    triggers: parseJson<string[]>(row.triggers, []),
    scope: parseJson<Record<string, string>>(row.scope, {}),
    evidence: parseJson<CognitiveEvidenceRef[]>(row.evidence, []),
    confidence: row.confidence,
    status: isCognitiveRowStatus(row.status) ? row.status : 'active',
    activationText: row.activationText,
    activationCount: row.activationCount ?? 0,
    ...(row.lastActivatedAt ? { lastActivatedAt: row.lastActivatedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toEvent(row: typeof cognitiveEventsTable.$inferSelect): CognitiveEvent {
  return {
    id: row.id,
    operation: parseJson<CognitivePatchOperation>(row.operation, {
      type: 'upsertRelation',
      relation: 'invalid_event',
      evidence: [{ kind: 'manual', note: 'Invalid persisted cognitive event.' }]
    }),
    createdAt: row.createdAt
  }
}

function sortTermRows(rows: readonly CognitiveRow[]): CognitiveRow[] {
  return rows
    .filter((row) => row.status === 'active')
    .slice()
    .sort((left, right) => {
      const relationOrder = left.relation.localeCompare(right.relation)
      return relationOrder === 0 ? left.key.localeCompare(right.key) : relationOrder
    })
}

function countTermTopics(rows: readonly CognitiveRow[]): CognitiveMemoryTermTopicCount[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.status !== 'active') continue
    counts.set(row.relation, (counts.get(row.relation) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([topic, entryCount]) => ({ topic, entryCount }))
}

function paginateTermRows(
  rows: readonly CognitiveRow[],
  input?: CognitiveMemoryTermPageInput
): CognitiveRow[] {
  const offset = input?.offset ?? 0
  const limit = input?.limit
  return typeof limit === 'number' ? rows.slice(offset, offset + limit) : rows.slice(offset)
}

function readStateFromDb(db: SqliteDb): CognitiveMemoryState {
  return {
    events: db
      .select()
      .from(cognitiveEventsTable)
      .orderBy(asc(cognitiveEventsTable.createdAt))
      .all()
      .map(toEvent),
    relations: db
      .select()
      .from(cognitiveRelationsTable)
      .orderBy(asc(cognitiveRelationsTable.name))
      .all()
      .map(toRelation),
    rows: db
      .select()
      .from(cognitiveRowsTable)
      .orderBy(asc(cognitiveRowsTable.relation), asc(cognitiveRowsTable.key))
      .all()
      .map(toRow)
  }
}

function readTermPageFromDb(
  db: SqliteDb,
  input?: CognitiveMemoryTermPageInput
): CognitiveMemoryTermPage {
  const offset = input?.offset ?? 0
  const limit = input?.limit
  const topicCounts = db
    .select({ topic: cognitiveRowsTable.relation, entryCount: sql<number>`count(*)` })
    .from(cognitiveRowsTable)
    .where(eq(cognitiveRowsTable.status, 'active'))
    .groupBy(cognitiveRowsTable.relation)
    .orderBy(asc(cognitiveRowsTable.relation))
    .all()
  const memoryCount = topicCounts.reduce((total, topic) => total + topic.entryCount, 0)
  const query = db
    .select()
    .from(cognitiveRowsTable)
    .where(eq(cognitiveRowsTable.status, 'active'))
    .orderBy(asc(cognitiveRowsTable.relation), asc(cognitiveRowsTable.key))
  const rows =
    typeof limit === 'number'
      ? query.limit(limit).offset(offset).all()
      : offset > 0
        ? query.limit(-1).offset(offset).all()
        : query.all()

  return {
    rows: rows.map(toRow),
    topicCounts,
    memoryCount
  }
}

function writeStateDiff(input: {
  db: SqliteDb
  next: CognitiveMemoryState
  previousEventCount: number
}): number {
  for (const relation of input.next.relations) {
    input.db
      .insert(cognitiveRelationsTable)
      .values({
        id: relation.id,
        name: relation.name,
        purpose: relation.purpose,
        columns: stringify(relation.columns),
        createdAt: relation.createdAt,
        updatedAt: relation.updatedAt
      })
      .onConflictDoUpdate({
        target: cognitiveRelationsTable.name,
        set: {
          purpose: relation.purpose,
          columns: stringify(relation.columns),
          updatedAt: relation.updatedAt
        }
      })
      .run()
  }

  for (const row of input.next.rows) {
    input.db
      .insert(cognitiveRowsTable)
      .values({
        id: row.id,
        relation: row.relation,
        key: row.key,
        values: stringify(row.values),
        subjects: stringify(row.subjects),
        aliases: stringify(row.aliases),
        triggers: stringify(row.triggers),
        scope: stringify(row.scope),
        evidence: stringify(row.evidence),
        confidence: row.confidence,
        status: row.status,
        activationText: row.activationText,
        activationCount: row.activationCount ?? 0,
        lastActivatedAt: row.lastActivatedAt ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
      .onConflictDoUpdate({
        target: [cognitiveRowsTable.relation, cognitiveRowsTable.key],
        set: {
          values: stringify(row.values),
          subjects: stringify(row.subjects),
          aliases: stringify(row.aliases),
          triggers: stringify(row.triggers),
          scope: stringify(row.scope),
          evidence: stringify(row.evidence),
          confidence: row.confidence,
          status: row.status,
          activationText: row.activationText,
          activationCount: row.activationCount ?? 0,
          lastActivatedAt: row.lastActivatedAt ?? null,
          updatedAt: row.updatedAt
        }
      })
      .run()
  }

  const events = input.next.events.slice(input.previousEventCount)
  for (const event of events) {
    input.db
      .insert(cognitiveEventsTable)
      .values({
        id: event.id,
        operation: stringify(event.operation),
        createdAt: event.createdAt
      })
      .onConflictDoNothing()
      .run()
  }

  return events.length
}

function withDatabase<T>(dbPath: string, run: (db: SqliteDb) => T): T {
  const { client, db } = openMigratedSqliteDatabase(dbPath)
  try {
    return run(db)
  } finally {
    client.close()
  }
}

export function createInMemoryCognitiveMemoryStore(
  initialState: CognitiveMemoryState = createEmptyCognitiveMemoryState()
): CognitiveMemoryStore {
  let state = initialState

  return {
    async applyPatch(patch, input) {
      const next = applyCognitivePatchToState(state, patch, {
        createId: randomUUID,
        now: input?.now ?? new Date().toISOString()
      })
      const savedCount = next.events.length - state.events.length
      state = next
      return { savedCount }
    },
    async activateRows(input) {
      const seeds = activateCognitiveRows(state, input)
      const extraBudget = Math.max(0, input.limit - seeds.length)
      const diffused =
        extraBudget > 0 ? diffuseCognitiveRows(state, seeds, input.userQuery, extraBudget) : []

      const seen = new Set<string>()
      const allRows: CognitiveRow[] = []
      for (const row of [...seeds, ...diffused]) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        allRows.push(row)
      }

      state = markCognitiveRowsActivated(state, {
        now: input.now,
        rowIds: seeds.map((row) => row.id)
      })
      return allRows
    },
    async deleteRow(input) {
      const initialCount = state.rows.length
      state = { ...state, rows: state.rows.filter((row) => row.id !== input.id) }
      return { deleted: state.rows.length !== initialCount }
    },
    async readState() {
      return state
    },
    async listTermRows(input) {
      const rows = sortTermRows(state.rows)
      return {
        rows: paginateTermRows(rows, input),
        topicCounts: countTermTopics(state.rows),
        memoryCount: rows.length
      }
    },
    async searchRows(input) {
      return searchCognitiveRows(state, input)
    }
  }
}

export function createSqliteCognitiveMemoryStore(
  options: SqliteCognitiveMemoryStoreOptions
): CognitiveMemoryStore {
  return {
    async applyPatch(patch, input) {
      return withDatabase(options.dbPath, (db) => {
        const state = readStateFromDb(db)
        const next = applyCognitivePatchToState(state, patch, {
          createId: randomUUID,
          now: input?.now ?? new Date().toISOString()
        })
        return { savedCount: writeStateDiff({ db, next, previousEventCount: state.events.length }) }
      })
    },
    async activateRows(input) {
      return withDatabase(options.dbPath, (db) => {
        const state = readStateFromDb(db)
        const seeds = activateCognitiveRows(state, input)
        const extraBudget = Math.max(0, input.limit - seeds.length)
        const diffused =
          extraBudget > 0 ? diffuseCognitiveRows(state, seeds, input.userQuery, extraBudget) : []

        const seen = new Set<string>()
        const allRows: CognitiveRow[] = []
        for (const row of [...seeds, ...diffused]) {
          if (seen.has(row.id)) continue
          seen.add(row.id)
          allRows.push(row)
        }

        const next = markCognitiveRowsActivated(state, {
          now: input.now,
          rowIds: seeds.map((row) => row.id)
        })
        writeStateDiff({ db, next, previousEventCount: state.events.length })
        return allRows
      })
    },
    async deleteRow(input) {
      return withDatabase(options.dbPath, (db) => {
        const result = db
          .delete(cognitiveRowsTable)
          .where(eq(cognitiveRowsTable.id, input.id))
          .run()
        return { deleted: result.changes > 0 }
      })
    },
    async readState() {
      return withDatabase(options.dbPath, readStateFromDb)
    },
    async listTermRows(input) {
      return withDatabase(options.dbPath, (db) => readTermPageFromDb(db, input))
    },
    async searchRows(input) {
      return withDatabase(options.dbPath, (db) => searchCognitiveRows(readStateFromDb(db), input))
    }
  }
}

function toMemoryTermEntry(row: CognitiveRow): MemoryTermEntry {
  return {
    id: row.id,
    title: row.key,
    content: Object.entries(row.values)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
    importance: row.confidence,
    unitType: 'context',
    activationCount: row.activationCount ?? 0,
    ...(row.lastActivatedAt ? { lastActivatedAt: row.lastActivatedAt } : {}),
    updatedAt: row.updatedAt
  }
}

export function readCognitiveMemoryTermDocument(options: {
  store: CognitiveMemoryStore
  limit?: number
  offset?: number
}): Promise<MemoryTermDocument> {
  return options.store
    .listTermRows({ limit: options.limit, offset: options.offset })
    .then((page) => {
      const topicEntryCountByName = new Map(
        page.topicCounts.map((topic) => [topic.topic, topic.entryCount])
      )
      const pageTopics = new Map<string, MemoryTermEntry[]>()

      for (const row of page.rows) {
        const entries = pageTopics.get(row.relation) ?? []
        entries.push(toMemoryTermEntry(row))
        pageTopics.set(row.relation, entries)
      }

      return {
        topicCount: page.topicCounts.length,
        memoryCount: page.memoryCount,
        topics: [...pageTopics.entries()].map(([topic, entries]) => ({
          topic,
          entryCount: topicEntryCountByName.get(topic) ?? entries.length,
          entries
        }))
      }
    })
}
