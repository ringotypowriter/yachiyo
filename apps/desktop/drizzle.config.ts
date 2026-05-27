import { defineConfig } from 'drizzle-kit'
import { resolveYachiyoDbPath } from '@yachiyo/runtime/config/paths'

export default defineConfig({
  dbCredentials: {
    url: resolveYachiyoDbPath()
  },
  dialect: 'sqlite',
  out: '../../packages/runtime/src/storage/sqlite/drizzle',
  schema: '../../packages/runtime/src/storage/sqlite/schema.ts'
})
