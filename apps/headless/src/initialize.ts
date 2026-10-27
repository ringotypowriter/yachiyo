import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createSettingsStore } from '@yachiyo/runtime/settings/settingsStore'
import { DEFAULT_REMOTE_CONFIG } from '@yachiyo/shared/protocol'
import {
  createHeadlessProviderVault,
  assertHeadlessDataDirectory,
  initializeMasterKey,
  readMasterKey,
  resolveMasterKeyPath
} from './credentials.ts'

export function initializeHeadless(home: string): { home: string; keyPath: string } {
  assertHeadlessDataDirectory(home)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const keyPath = resolveMasterKeyPath(home)
  if (!existsSync(keyPath) && existsSync(join(home, 'provider-credentials.enc'))) {
    throw new Error(
      'An encrypted vault already exists. Restore its master key before initializing this data directory.'
    )
  }
  initializeMasterKey(keyPath)
  const vault = createHeadlessProviderVault(home, readMasterKey(keyPath))
  const settingsPath = join(home, 'config.toml')
  const fresh = !existsSync(settingsPath)
  const settings = createSettingsStore(settingsPath, {
    seedPresetProviders: true,
    providerCredentialVault: vault
  })
  const config = settings.read()
  if (fresh) settings.write({ ...config, remote: { ...DEFAULT_REMOTE_CONFIG, tunnel: 'none' } })
  return { home, keyPath }
}
