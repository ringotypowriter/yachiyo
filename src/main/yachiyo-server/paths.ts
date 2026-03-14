import { homedir } from 'node:os'
import { join } from 'node:path'

export const YACHIYO_DATA_DIR_NAME = '.yachiyo'
export const YACHIYO_DB_FILE_NAME = 'yachiyo.sqlite'
export const YACHIYO_SETTINGS_FILE_NAME = 'config.toml'

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
