import type { SoulDocument } from '../../../shared/yachiyo/protocol.ts'

export async function loadSoulDocument(): Promise<SoulDocument> {
  return window.api.yachiyo.getSoulDocument()
}

export async function addSoulTrait(trait: string): Promise<SoulDocument> {
  return window.api.yachiyo.addSoulTrait({ trait })
}

export async function deleteSoulTrait(trait: string): Promise<SoulDocument> {
  return window.api.yachiyo.deleteSoulTrait({ trait })
}
