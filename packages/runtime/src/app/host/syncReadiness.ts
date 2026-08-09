import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32, type PlatformPath } from 'node:path'
import type { SettingsConfig } from '@yachiyo/shared/protocol'

export interface SyncReadiness {
  syncDir: string
  recommendedSyncDir: string
  available: boolean
  initialized: boolean
}

export interface RecommendedSyncDirOptions {
  platform: NodeJS.Platform
  homeDir?: string
  env?: Readonly<Record<string, string | undefined>>
}

export interface SyncReadinessOptions extends RecommendedSyncDirOptions {
  pathExists?: (path: string) => boolean
}

function platformPath(platform: NodeJS.Platform): PlatformPath {
  return platform === 'win32' ? win32 : posix
}

export function resolveRecommendedSyncDir(options: RecommendedSyncDirOptions): string {
  const env = options.env ?? process.env
  const homeDir = options.homeDir?.trim() || env.HOME?.trim() || homedir()

  if (options.platform === 'darwin') {
    if (!homeDir) return ''
    return posix.join(
      homeDir,
      'Library/Mobile Documents/com~apple~CloudDocs/Documents/Yachiyo/Sync'
    )
  }

  if (options.platform === 'win32') {
    const oneDriveRoot = [env.OneDrive, env.OneDriveCommercial, env.OneDriveConsumer]
      .map((value) => value?.trim())
      .find(Boolean)
    return oneDriveRoot ? win32.join(oneDriveRoot, 'Yachiyo', 'Sync') : ''
  }

  return ''
}

export function resolveConfiguredSyncDir(
  config: SettingsConfig,
  recommendedSyncDir: string
): string {
  return config.sync?.syncDir?.trim() || recommendedSyncDir
}

function isRecommendedSyncDir(
  syncDir: string,
  recommendedSyncDir: string,
  path: PlatformPath
): boolean {
  return (
    Boolean(syncDir && recommendedSyncDir) &&
    path.resolve(syncDir) === path.resolve(recommendedSyncDir)
  )
}

export function resolveSyncReadiness(
  config: SettingsConfig,
  options: SyncReadinessOptions
): SyncReadiness {
  const platform = options.platform
  const path = platformPath(platform)
  const pathExists = options.pathExists ?? existsSync
  const recommendedSyncDir = resolveRecommendedSyncDir({
    platform,
    homeDir: options.homeDir,
    env: options.env
  })
  const syncDir = resolveConfiguredSyncDir(config, recommendedSyncDir)
  const configuredSyncDir = config.sync?.syncDir?.trim() ?? ''
  const customSyncDir = isRecommendedSyncDir(configuredSyncDir, recommendedSyncDir, path)
    ? ''
    : configuredSyncDir
  const recommendedRoot = recommendedSyncDir
    ? path.resolve(recommendedSyncDir, platform === 'win32' ? '../..' : '../../..')
    : ''
  const available = customSyncDir
    ? pathExists(syncDir)
    : Boolean(syncDir) && pathExists(recommendedRoot)
  const initialized = available && pathExists(path.join(syncDir, 'universe.json'))
  return { syncDir, recommendedSyncDir, available, initialized }
}
