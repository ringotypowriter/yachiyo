import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import { resolveRuntimeNodeModule } from '../../config/runtimeNodeModules.ts'
import * as schema from './schema.ts'

const MIGRATIONS_DIR = fileURLToPath(new URL('./drizzle', import.meta.url))
const require = createRequire(import.meta.url)

export type SqliteDb = BetterSQLite3Database<typeof schema>

export interface BetterSqlite3Statement {
  get(...params: unknown[]): Record<string, unknown>
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): void
}

export interface BetterSqlite3Client {
  close(): void
  exec(sql: string): void
  pragma(sql: string): void
  prepare(sql: string): BetterSqlite3Statement
}

type BetterSqlite3Constructor = new (path: string) => BetterSqlite3Client

type BetterSqlite3Module = {
  default?: BetterSqlite3Constructor
}

interface SqliteRuntime {
  BetterSqlite3: BetterSqlite3Constructor
  drizzle: (client: BetterSqlite3Client, options: { schema: typeof schema }) => SqliteDb
  migrate: (db: SqliteDb, options: { migrationsFolder: string }) => void
}

function loadSqliteRuntime(): SqliteRuntime {
  const BetterSqlite3Module = require(resolveRuntimeNodeModule('better-sqlite3', require)) as
    | BetterSqlite3Constructor
    | BetterSqlite3Module
  const drizzleModule = require('drizzle-orm/better-sqlite3') as Pick<SqliteRuntime, 'drizzle'>
  const migratorModule = require('drizzle-orm/better-sqlite3/migrator') as Pick<
    SqliteRuntime,
    'migrate'
  >
  const BetterSqlite3 =
    typeof BetterSqlite3Module === 'function' ? BetterSqlite3Module : BetterSqlite3Module.default

  if (!BetterSqlite3) {
    throw new Error('Failed to load better-sqlite3 runtime')
  }

  return {
    BetterSqlite3,
    drizzle: drizzleModule.drizzle,
    migrate: migratorModule.migrate
  }
}

// Several components open their own connection to the same db file (main
// storage, cognitive memory store, per-call term-document readers). Migrations
// are idempotent but not free, and the schema cannot regress mid-process, so
// run them once per path per process.
const migratedDbPaths = new Set<string>()

export function openMigratedSqliteDatabase(dbPath: string): {
  client: BetterSqlite3Client
  db: SqliteDb
} {
  mkdirSync(dirname(dbPath), { recursive: true })

  const { BetterSqlite3, drizzle, migrate } = loadSqliteRuntime()
  const client = new BetterSqlite3(dbPath)
  client.pragma('journal_mode = WAL')
  // WAL is durable at checkpoint with NORMAL; avoids an fsync per commit on the
  // streaming hot path (checkpoint upserts, tool-call updates).
  client.pragma('synchronous = NORMAL')
  client.pragma('foreign_keys = ON')

  const db = drizzle(client, { schema })
  if (!migratedDbPaths.has(dbPath)) {
    migrate(db, { migrationsFolder: MIGRATIONS_DIR })
    migratedDbPaths.add(dbPath)
  }

  return { client, db }
}
