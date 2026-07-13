import { randomUUID } from 'node:crypto'

import { resolveYachiyoDbPath, resolveYachiyoSettingsPath } from '../../config/paths.ts'
import { createDemoYachiyoStorage, isDevelopmentDemoModeEnabled } from '../../demo/demoMode.ts'
import {
  createSqliteCognitiveMemoryStore,
  readCognitiveMemoryTermDocument
} from '../../services/memory/cognitiveMemoryStore.ts'
import { createSettingsStore } from '../../settings/settingsStore.ts'
import { createSqliteYachiyoStorage } from '../../storage/sqlite/database.ts'
import { createSqliteSourceQueryExecutor } from '../../tools/agentTools/querySourceSqliteExecutor.ts'
import type { SqliteYachiyoServerOptions, YachiyoServerOptions } from './options.ts'

export function createSqliteYachiyoServerOptions(
  options: SqliteYachiyoServerOptions
): YachiyoServerOptions {
  const settingsPath = options.settingsPath ?? resolveYachiyoSettingsPath()
  const shouldUseDemoStorage = isDevelopmentDemoModeEnabled(
    createSettingsStore(settingsPath).read(),
    options.developmentMode === true
  )
  const builtinMemoryDbPath = shouldUseDemoStorage
    ? resolveYachiyoDbPath(`demo-mode-memory-${randomUUID()}.sqlite`)
    : options.dbPath

  if (shouldUseDemoStorage) {
    const demoMemoryStorage = createSqliteYachiyoStorage(builtinMemoryDbPath)
    demoMemoryStorage.close()
  }

  return {
    ...options,
    settingsPath,
    cognitiveMemoryStore: createSqliteCognitiveMemoryStore({ dbPath: builtinMemoryDbPath }),
    sourceQueryExecutor:
      options.sourceQueryExecutor ??
      (shouldUseDemoStorage
        ? undefined
        : createSqliteSourceQueryExecutor({ dbPath: options.dbPath })),
    readMemoryTermDocument: async (input) => {
      const store = createSqliteCognitiveMemoryStore({ dbPath: builtinMemoryDbPath })
      try {
        return await readCognitiveMemoryTermDocument({
          store,
          limit: input?.limit,
          offset: input?.offset
        })
      } finally {
        store.close()
      }
    },
    storage: shouldUseDemoStorage
      ? createDemoYachiyoStorage()
      : createSqliteYachiyoStorage(options.dbPath, { deferSearchIndexRebuild: true })
  }
}
