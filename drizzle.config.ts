import { defineConfig } from 'drizzle-kit'
import { resolveYachiyoDbPath } from './src/main/yachiyo-server/paths.ts'

export default defineConfig({
  dbCredentials: {
    url: resolveYachiyoDbPath()
  },
  dialect: 'sqlite',
  out: './src/main/yachiyo-server/drizzle',
  schema: './src/main/yachiyo-server/schema.ts'
})
