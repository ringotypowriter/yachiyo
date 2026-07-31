import { createSettingsStore } from '@yachiyo/runtime/settings/settingsStore'
import { YachiyoServerConfigDomain } from '@yachiyo/runtime/app/domain/config/configDomain'
import type { ProviderCredentialVault } from '@yachiyo/runtime/settings/providerCredentialVault'
import type { CliConfigService } from '../core/types.ts'

export function createDefaultConfigService(
  settingsPath: string,
  options?: { providerCredentialVault?: ProviderCredentialVault }
): CliConfigService {
  const settingsStore = createSettingsStore(settingsPath, {
    providerCredentialVault: options?.providerCredentialVault
  })
  return new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })
}
