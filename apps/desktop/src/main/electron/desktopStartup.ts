import { createRequire } from 'node:module'
import { resolveRuntimeNodeModule } from '@yachiyo/runtime/config/runtimeNodeModules'

const require = createRequire(import.meta.url)

function openNativeSqliteDatabase(): { close: () => void } {
  const Database = require(
    resolveRuntimeNodeModule('better-sqlite3', require)
  ) as typeof import('better-sqlite3')
  return new Database(':memory:')
}

export class DesktopNativeDependencyError extends Error {
  constructor(cause: unknown) {
    super(
      'The SQLite native module could not be loaded by Electron. Reinstall the matching package, or use the pinned toolchain and run pnpm run native:prepare in a source checkout.',
      { cause }
    )
    this.name = 'DesktopNativeDependencyError'
  }
}

/** Catch a missing/wrong-ABI binding before the utility runtime enters a crash loop. */
export function verifyNativeSqliteDependency(
  openDatabase: () => { close: () => void } = openNativeSqliteDatabase
): void {
  try {
    openDatabase().close()
  } catch (error) {
    throw new DesktopNativeDependencyError(error)
  }
}

/** Keep startup failure handling independent of the renderer or any added dialogs. */
export function reportDesktopStartupFailure(
  error: unknown,
  dependencies: {
    logError: (error: unknown) => void
    quit: () => void
  }
): void {
  try {
    dependencies.logError(error)
  } finally {
    dependencies.quit()
  }
}

/** Shell-derived YACHIYO_HOME must be final before selecting a credential store. */
export function prepareDesktopCredentialStorage(dependencies: {
  hydrateEnvironment: () => void
  resolveSettingsPath: () => string
  prepareCredentials: (settingsPath: string) => void
}): void {
  dependencies.hydrateEnvironment()
  dependencies.prepareCredentials(dependencies.resolveSettingsPath())
}
