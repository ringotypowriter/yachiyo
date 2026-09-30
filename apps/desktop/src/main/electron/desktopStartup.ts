import { createRequire } from 'node:module'
import { t } from '@yachiyo/i18n/index'
import { resolveRuntimeNodeModule } from '@yachiyo/runtime/config/runtimeNodeModules'
import { ProviderCredentialStoreUnavailableError } from '@yachiyo/runtime/settings/providerCredentialKey'

const require = createRequire(import.meta.url)

function openNativeSqliteDatabase(): { close: () => void } {
  const Database = require(
    resolveRuntimeNodeModule('better-sqlite3', require)
  ) as typeof import('better-sqlite3')
  return new Database(':memory:')
}

export class DesktopNativeDependencyError extends Error {
  constructor(cause: unknown) {
    super('The SQLite native module could not be loaded by Electron', { cause })
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

export function desktopStartupFailureOptions(
  error: unknown,
  platform: NodeJS.Platform,
  isPackaged: boolean
): Electron.MessageBoxOptions {
  let detail = t('main.startupFailure.genericDetail')
  if (error instanceof ProviderCredentialStoreUnavailableError) {
    detail = t(
      platform === 'linux'
        ? 'main.startupFailure.linuxCredentialDetail'
        : 'main.startupFailure.credentialDetail'
    )
  } else if (error instanceof DesktopNativeDependencyError) {
    detail = t(
      isPackaged
        ? 'main.startupFailure.nativePackagedDetail'
        : 'main.startupFailure.nativeDevelopmentDetail'
    )
  }

  return {
    type: 'error',
    title: t('main.startupFailure.title'),
    message: t('main.startupFailure.message'),
    detail,
    buttons: [t('main.startupFailure.quit')],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
}

export async function reportDesktopStartupFailure(
  error: unknown,
  dependencies: {
    platform: NodeJS.Platform
    isPackaged: boolean
    logError: (error: unknown) => void
    showMessageBox: (options: Electron.MessageBoxOptions) => Promise<unknown>
    quit: () => void
  }
): Promise<void> {
  dependencies.logError(error)
  try {
    await dependencies.showMessageBox(
      desktopStartupFailureOptions(error, dependencies.platform, dependencies.isPackaged)
    )
  } catch (dialogError) {
    dependencies.logError(dialogError)
  } finally {
    dependencies.quit()
  }
}
