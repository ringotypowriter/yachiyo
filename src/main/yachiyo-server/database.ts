import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import BetterSqlite3 from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import * as schema from './schema.ts'

export type YachiyoDatabase = BetterSQLite3Database<typeof schema>

const MIGRATIONS_DIR = fileURLToPath(new URL('./drizzle', import.meta.url))

export function createYachiyoDatabase(dbPath: string): {
  client: BetterSqlite3.Database
  db: YachiyoDatabase
} {
  mkdirSync(dirname(dbPath), { recursive: true })

  const client = new BetterSqlite3(dbPath)
  client.pragma('journal_mode = WAL')
  client.pragma('foreign_keys = ON')

  const db = drizzle(client, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })

  return { client, db }
}
