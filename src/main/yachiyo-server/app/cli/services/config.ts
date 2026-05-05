import { createSettingsStore } from '../../../settings/settingsStore.ts'
import { YachiyoServerConfigDomain } from '../../domain/config/configDomain.ts'
import type { CliConfigService } from '../core/types.ts'

export function createDefaultConfigService(settingsPath: string): CliConfigService {
  const settingsStore = createSettingsStore(settingsPath)
  return new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })
}
