import type { SettingsConfig } from '../../../../shared/yachiyo/protocol.ts'
import type { MemoryProvider } from './memoryService.ts'
import { createBuiltinMemoryProvider } from './builtinMemoryProvider.ts'

export interface CreateMemoryProviderFactoryOptions {
  builtinDbPath?: string
}

export function createMemoryProviderFactory(
  options: CreateMemoryProviderFactoryOptions = {}
): (_config: SettingsConfig) => MemoryProvider {
  return (): MemoryProvider => {
    if (!options.builtinDbPath) {
      throw new Error('Built-in memory requires a sqlite database path.')
    }

    return createBuiltinMemoryProvider({
      dbPath: options.builtinDbPath
    })
  }
}
