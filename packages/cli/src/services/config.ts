import { createSettingsStore } from '@yachiyo/runtime/settings/settingsStore'
import { YachiyoServerConfigDomain } from '@yachiyo/runtime/app/domain/config/configDomain'
import type { CliConfigService } from '../core/types.ts'

export function createDefaultConfigService(settingsPath: string): CliConfigService {
  const settingsStore = createSettingsStore(settingsPath)
  return new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })
}
