import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import type { Database } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import * as schema from './schema.ts'
import { createSqliteWorkerTranscriptStorageMethods } from './workerTranscriptStorage.ts'
import type { WorkerTranscriptTurn } from '../workerTranscripts.ts'

test('generated migrations and the SQLite worker store preserve evidence and enforce parent ownership', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = new URL('./drizzle/', import.meta.url)
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', migrations), 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    for (const entry of journal.entries) {
      sqlite.exec(readFileSync(new URL(`${entry.tag}.sql`, migrations), 'utf8'))
    }
    sqlite.exec('PRAGMA foreign_keys = ON')
    // Exercise the production Drizzle queries using SQLite's in-memory Node
    // binding. The app's Electron native dependencies must not be rebuilt.
    const client = {
      prepare(sql: string) {
        const statement = sqlite.prepare(sql)
        return {
          run: statement.run.bind(statement),
          get: statement.get.bind(statement),
          all: statement.all.bind(statement),
          raw() {
            statement.setReturnArrays(true)
            return statement
          }
        }
      },
      transaction<T>(work: (...args: unknown[]) => T) {
        const invoke = (...args: unknown[]): T => {
          sqlite.exec('BEGIN')
          try {
            const result = work(...args)
            sqlite.exec('COMMIT')
            return result
          } catch (error) {
            sqlite.exec('ROLLBACK')
            throw error
          }
        }
        return { deferred: invoke }
      }
    }
    const db = drizzle(client as unknown as Database, { schema })
    const storage = createSqliteWorkerTranscriptStorageMethods(db)
    const at = '2026-10-26T00:00:00.000Z'
    for (const id of ['parent', 'other']) {
      db.insert(schema.threadsTable)
        .values({ id, title: id, source: 'local', createdAt: at, updatedAt: at })
        .run()
    }
    db.insert(schema.runsTable)
      .values({ id: 'run', threadId: 'parent', status: 'running', createdAt: at })
      .run()
    const turn: WorkerTranscriptTurn = {
      id: 'worker-turn',
      version: 1,
      agentId: 'agent',
      threadId: 'parent',
      launchRunId: 'run',
      turnId: 'turn',
      agentType: 'explore',
      workspacePath: '/project',
      modelId: 'test',
      messages: [
        {
          message: {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'call', toolName: 'bash', input: { command: 'pwd' } }
            ]
          },
          timestamp: at,
          isMeta: false
        }
      ],
      compaction: null,
      status: 'running',
      error: null,
      promptTokens: null,
      completionTokens: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null
    }
    assert.equal(storage.upsertWorkerTranscriptTurn(turn), true)
    assert.deepEqual(storage.listWorkerTranscriptTurns('parent'), [turn])
    const completed = { ...turn, status: 'completed' as const, completedAt: at, promptTokens: 10 }
    assert.equal(storage.upsertWorkerTranscriptTurn(completed), true)
    assert.deepEqual(storage.listWorkerTranscriptTurns('parent'), [completed])
    assert.equal(storage.upsertWorkerTranscriptTurn({ ...turn, threadId: 'other' }), false)
    db.update(schema.threadsTable)
      .set({ privacyMode: '1' })
      .where(eq(schema.threadsTable.id, 'parent'))
      .run()
    assert.equal(storage.upsertWorkerTranscriptTurn(turn), false)
    db.update(schema.threadsTable)
      .set({ privacyMode: null })
      .where(eq(schema.threadsTable.id, 'parent'))
      .run()
    db.delete(schema.runsTable).where(eq(schema.runsTable.id, 'run')).run()
    assert.deepEqual(storage.listWorkerTranscriptTurns('parent'), [])
    assert.equal(storage.upsertWorkerTranscriptTurn(turn), false)
    db.insert(schema.runsTable)
      .values({ id: 'run', threadId: 'parent', status: 'running', createdAt: at })
      .run()
    storage.upsertWorkerTranscriptTurn(turn)
    db.delete(schema.threadsTable).where(eq(schema.threadsTable.id, 'parent')).run()
    assert.deepEqual(storage.listWorkerTranscriptTurns('parent'), [])
    assert.equal(storage.upsertWorkerTranscriptTurn(turn), false)
  } finally {
    sqlite.close()
  }
})
