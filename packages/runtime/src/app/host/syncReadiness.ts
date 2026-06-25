import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SettingsConfig } from '@yachiyo/shared/protocol'

export interface SyncReadiness {
  syncDir: string
  recommendedSyncDir: string
  available: boolean
  initialized: boolean
}

export function resolveRecommendedICloudSyncDir(): string {
  const home = process.env['HOME']?.trim()
  if (!home) return ''
  return join(home, 'Library/Mobile Documents/com~apple~CloudDocs/Documents/Yachiyo/Sync')
}

export function resolveConfiguredSyncDir(
  config: SettingsConfig,
  recommendedSyncDir: string
): string {
  return config.sync?.syncDir?.trim() || recommendedSyncDir
}

function isRecommendedSyncDir(syncDir: string, recommendedSyncDir: string): boolean {
  return Boolean(syncDir && recommendedSyncDir) && resolve(syncDir) === resolve(recommendedSyncDir)
}

export function resolveSyncReadiness(
  config: SettingsConfig,
  pathExists: (path: string) => boolean = existsSync
): SyncReadiness {
  const recommendedSyncDir = resolveRecommendedICloudSyncDir()
  const syncDir = resolveConfiguredSyncDir(config, recommendedSyncDir)
  const configuredSyncDir = config.sync?.syncDir?.trim() ?? ''
  const customSyncDir = isRecommendedSyncDir(configuredSyncDir, recommendedSyncDir)
    ? ''
    : configuredSyncDir
  const iCloudRoot = recommendedSyncDir ? resolve(recommendedSyncDir, '../../..') : ''
  const available = customSyncDir ? pathExists(syncDir) : Boolean(syncDir) && pathExists(iCloudRoot)
  const initialized = available && pathExists(join(syncDir, 'universe.json'))
  return { syncDir, recommendedSyncDir, available, initialized }
}
