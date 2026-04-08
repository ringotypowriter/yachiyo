import { homedir } from 'node:os'
import { join } from 'node:path'

export const YACHIYO_DATA_DIR_NAME = '.yachiyo'
export const YACHIYO_DB_FILE_NAME = 'yachiyo.sqlite'
export const YACHIYO_SETTINGS_FILE_NAME = 'config.toml'
export const YACHIYO_SOUL_FILE_NAME = 'SOUL.md'
export const YACHIYO_USER_FILE_NAME = 'USER.md'
export const YACHIYO_CHANNELS_FILE_NAME = 'channels.toml'
export const YACHIYO_SOCKET_FILE_NAME = 'yachiyo.sock'
export const YACHIYO_TEMP_WORKSPACE_DIR_NAME = 'temp-workspace'
export const YACHIYO_WEB_SEARCH_DIR_NAME = 'web-search'
export const YACHIYO_WEB_SEARCH_BROWSER_SESSION_DIR_NAME = 'browser-session'

export function resolveYachiyoDataDir(): string {
  const override = process.env['YACHIYO_HOME']?.trim()
  return override && override.length > 0 ? override : join(homedir(), YACHIYO_DATA_DIR_NAME)
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

export function resolveYachiyoSocketPath(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_SOCKET_FILE_NAME)
}

export function resolveYachiyoTempWorkspaceRoot(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_TEMP_WORKSPACE_DIR_NAME)
}

export function resolveThreadWorkspacePath(threadId: string): string {
  return join(resolveYachiyoTempWorkspaceRoot(), threadId)
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

export const YACHIYO_WORKSPACE_INDEX_DIR_NAME = 'workspace-indexes'

export function resolveYachiyoWorkspaceIndexDir(): string {
  return join(resolveYachiyoDataDir(), YACHIYO_WORKSPACE_INDEX_DIR_NAME)
}
