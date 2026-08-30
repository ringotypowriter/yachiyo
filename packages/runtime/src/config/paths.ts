import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

import { resolveCommandEndpoint, type CommandEndpoint } from './commandEndpoint.ts'

export const YACHIYO_DATA_DIR_NAME = '.yachiyo'
export const YACHIYO_DB_FILE_NAME = 'yachiyo.sqlite'
export const YACHIYO_SETTINGS_FILE_NAME = 'config.toml'
export const YACHIYO_SOUL_FILE_NAME = 'SOUL.md'
export const YACHIYO_USER_FILE_NAME = 'USER.md'
export const YACHIYO_CHANNELS_FILE_NAME = 'channels.toml'
export const YACHIYO_ACTIVITY_SOURCE_KEY_FILE_NAME = 'activity-source.key'
export const YACHIYO_PROVIDER_CREDENTIAL_KEY_FILE_NAME = 'provider-credentials.key'
export const YACHIYO_PROVIDER_CREDENTIAL_VAULT_FILE_NAME = 'provider-credentials.enc'
export const YACHIYO_SOCKET_FILE_NAME = 'yachiyo.sock'
export const YACHIYO_TEMP_WORKSPACE_DIR_NAME = 'temp-workspace'
export const YACHIYO_WEB_SEARCH_DIR_NAME = 'web-search'
export const YACHIYO_PYTHON_DIR_NAME = 'python'
export const YACHIYO_WEB_SEARCH_BROWSER_SESSION_DIR_NAME = 'browser-session'

export function resolveYachiyoDataDir(options?: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  homeDir?: string
}): string {
  const platform = options?.platform ?? process.platform
  const env = options?.env ?? process.env
  const override = env['YACHIYO_HOME']?.trim()
  if (override) return override

  const homeDir = options?.homeDir ?? homedir()
  return platform === 'win32'
    ? win32.join(homeDir, YACHIYO_DATA_DIR_NAME)
    : join(homeDir, YACHIYO_DATA_DIR_NAME)
}

export function resolveYachiyoDbPath(fileName = YACHIYO_DB_FILE_NAME): string {
  return join(resolveYachiyoDataDir(), fileName)
}

export function resolveYachiyoSettingsPath(fileName = YACHIYO_SETTINGS_FILE_NAME): string {
  return join(resolveYachiyoDataDir(), fileName)
}

export function resolveYachiyoSoulPath(baseDir = resolveYachiyoDataDir()): string {
  return join(baseDir, YACHIYO_SOUL_FILE_NAME)
}

export function resolveYachiyoUserPath(baseDir = resolveYachiyoDataDir()): string {
  return join(baseDir, YACHIYO_USER_FILE_NAME)
}

export function resolveYachiyoChannelsPath(baseDir = resolveYachiyoDataDir()): string {
  return join(baseDir, YACHIYO_CHANNELS_FILE_NAME)
}

export function resolveYachiyoActivitySourceKeyPath(baseDir = resolveYachiyoDataDir()): string {
  return join(baseDir, YACHIYO_ACTIVITY_SOURCE_KEY_FILE_NAME)
}

export function resolveYachiyoProviderCredentialKeyPath(baseDir = resolveYachiyoDataDir()): string {
  return join(baseDir, YACHIYO_PROVIDER_CREDENTIAL_KEY_FILE_NAME)
}

export function resolveYachiyoProviderCredentialVaultPath(
  baseDir = resolveYachiyoDataDir()
): string {
  return join(baseDir, YACHIYO_PROVIDER_CREDENTIAL_VAULT_FILE_NAME)
}

export function resolveYachiyoCommandEndpoint(): CommandEndpoint {
  return resolveCommandEndpoint({
    platform: process.platform,
    yachiyoHome: resolveYachiyoDataDir()
  })
}

export function resolveYachiyoSocketPath(): string {
  return resolveYachiyoCommandEndpoint().address
}

export function resolveYachiyoTempWorkspaceRoot(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_TEMP_WORKSPACE_DIR_NAME)
}

export function resolveThreadWorkspacePath(threadId: string): string {
  return join(resolveYachiyoTempWorkspaceRoot(), threadId)
}

export function resolveYachiyoPythonRoot(baseDir = resolveYachiyoDataDir()): string {
  return join(baseDir, YACHIYO_PYTHON_DIR_NAME)
}

export function resolveYachiyoWebSearchRoot(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_WEB_SEARCH_DIR_NAME)
}

export function resolveYachiyoWebSearchBrowserSessionPath(): string {
  return join(resolveYachiyoWebSearchRoot(), YACHIYO_WEB_SEARCH_BROWSER_SESSION_DIR_NAME)
}

export const YACHIYO_JOTDOWNS_DIR_NAME = 'jotdowns'

export function resolveYachiyoJotdownsDir(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_JOTDOWNS_DIR_NAME)
}

export const YACHIYO_FILE_HISTORY_DIR_NAME = 'file-history'

export function resolveYachiyoFileHistoryDir(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_FILE_HISTORY_DIR_NAME)
}

export const YACHIYO_WORKSPACE_INDEX_DIR_NAME = 'workspace-indexes'

export function resolveYachiyoWorkspaceIndexDir(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_WORKSPACE_INDEX_DIR_NAME)
}

export const YACHIYO_BROWSER_AUTOMATION_DIR_NAME = 'browser-automation'
export const YACHIYO_BROWSER_AUTOMATION_SESSIONS_DIR_NAME = 'sessions'
export const YACHIYO_BROWSER_AUTOMATION_PROFILE_DIR_NAME = 'profile'

export function resolveYachiyoBrowserAutomationRoot(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_BROWSER_AUTOMATION_DIR_NAME)
}

export function resolveYachiyoBrowserAutomationSessionsRoot(): string {
  return join(resolveYachiyoBrowserAutomationRoot(), YACHIYO_BROWSER_AUTOMATION_SESSIONS_DIR_NAME)
}

export function resolveYachiyoBrowserAutomationProfilePath(): string {
  return join(resolveYachiyoBrowserAutomationRoot(), YACHIYO_BROWSER_AUTOMATION_PROFILE_DIR_NAME)
}
