import { defineConfig } from 'drizzle-kit'
import { resolveYachiyoDbPath } from './src/main/yachiyo-server/config/paths.ts'

export default defineConfig({
  dbCredentials: {
    url: resolveYachiyoDbPath()
  },
  dialect: 'sqlite',
  out: './src/main/yachiyo-server/storage/sqlite/drizzle',
  schema: './src/main/yachiyo-server/storage/sqlite/schema.ts'
})
