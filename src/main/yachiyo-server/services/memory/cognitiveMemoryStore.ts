import { randomUUID } from 'node:crypto'

import { asc } from 'drizzle-orm'

import type { MemoryTermDocument, MemoryTermEntry } from '../../../../shared/yachiyo/protocol.ts'
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

export interface CognitiveMemoryStore {
  applyPatch(patch: CognitivePatch, input?: { now?: string }): Promise<{ savedCount: number }>
  activateRows(input: ActivateCognitiveRowsInput): Promise<CognitiveRow[]>
  readState(): Promise<CognitiveMemoryState>
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
      return activateCognitiveRows(state, input)
    },
    async readState() {
      return state
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
      return withDatabase(options.dbPath, (db) => activateCognitiveRows(readStateFromDb(db), input))
    },
    async readState() {
      return withDatabase(options.dbPath, readStateFromDb)
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
    updatedAt: row.updatedAt
  }
}

export function readCognitiveMemoryTermDocument(options: {
  store: CognitiveMemoryStore
}): Promise<MemoryTermDocument> {
  return options.store.readState().then((state) => {
    const topics = state.relations.map((relation) => {
      const entries = state.rows
        .filter((row) => row.relation === relation.name && row.status === 'active')
        .map(toMemoryTermEntry)
      return {
        topic: relation.name,
        entryCount: entries.length,
        entries
      }
    })

    return {
      provider: 'builtin-memory',
      topicCount: topics.length,
      memoryCount: topics.reduce((total, topic) => total + topic.entryCount, 0),
      topics
    }
  })
}
