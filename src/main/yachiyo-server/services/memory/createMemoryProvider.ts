import type { SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
import { normalizeMemoryProviderId } from '../../../../shared/yachiyo/protocol.ts'
import type { MemoryProvider } from './memoryService.ts'
import { createBuiltinMemoryProvider } from './builtinMemoryProvider.ts'
import { createNowledgeMemProvider } from './nowledgeMemProvider.ts'

export interface CreateMemoryProviderFactoryOptions {
  builtinDbPath?: string
}

export function createMemoryProviderFactory(
  options: CreateMemoryProviderFactoryOptions = {}
): (config: SettingsConfig) => MemoryProvider {
  return (config: SettingsConfig): MemoryProvider => {
    const provider = normalizeMemoryProviderId(config.memory?.provider)

    if (provider === 'builtin-memory') {
      if (!options.builtinDbPath) {
        throw new Error('Built-in memory requires a sqlite database path.')
      }

      return createBuiltinMemoryProvider({
        dbPath: options.builtinDbPath
      })
    }

    return createNowledgeMemProvider(config)
  }
}
