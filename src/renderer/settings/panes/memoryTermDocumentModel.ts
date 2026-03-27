import type { MemoryTermDocument, SettingsConfig } from '../../../shared/yachiyo/protocol.ts'

export async function loadMemoryTermDocument(config?: SettingsConfig): Promise<MemoryTermDocument> {
  return window.api.yachiyo.getMemoryTermDocument(config ? { config } : undefined)
}
