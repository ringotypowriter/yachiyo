import type { SoulDocument } from '../../../shared/yachiyo/protocol.ts'

export async function loadSoulDocument(): Promise<SoulDocument> {
  return window.api.yachiyo.getSoulDocument()
}

export function hasPendingSoulDocumentChanges(
  savedTraits: string[],
  draftTraits: string[]
): boolean {
  if (savedTraits.length !== draftTraits.length) {
    return true
  }

  return savedTraits.some((trait, index) => trait !== draftTraits[index])
}

function getRewrittenSoulTraits(savedTraits: string[], draftTraits: string[]): string[] {
  for (let rewriteStart = draftTraits.length - 1; rewriteStart >= 0; rewriteStart -= 1) {
    const rewrittenTraits = draftTraits.slice(rewriteStart)
    const rewrittenSet = new Set(rewrittenTraits)
    const preservedSavedTraits = savedTraits.filter((trait) => !rewrittenSet.has(trait))
    const preservedDraftTraits = draftTraits.slice(0, rewriteStart)

    if (
      preservedSavedTraits.length === preservedDraftTraits.length &&
      preservedSavedTraits.every((trait, index) => trait === preservedDraftTraits[index])
    ) {
      return rewrittenTraits
    }
  }

  return [...draftTraits]
}

export async function persistSoulDocument(
  savedTraits: string[],
  draftTraits: string[]
): Promise<SoulDocument> {
  const savedSet = new Set(savedTraits)
  const draftSet = new Set(draftTraits)
  const hasSameMembers =
    savedTraits.length === draftTraits.length &&
    savedTraits.every((trait) => draftSet.has(trait)) &&
    draftTraits.every((trait) => savedSet.has(trait))
  const hasOrderChange =
    hasSameMembers && savedTraits.some((trait, index) => trait !== draftTraits[index])

  if (hasOrderChange) {
    const rewrittenTraits = getRewrittenSoulTraits(savedTraits, draftTraits)

    for (const trait of rewrittenTraits) {
      await window.api.yachiyo.deleteSoulTrait({ trait })
    }

    for (const trait of rewrittenTraits) {
      await window.api.yachiyo.addSoulTrait({ trait })
    }

    return window.api.yachiyo.getSoulDocument()
  }

  for (const trait of savedTraits) {
    if (!draftSet.has(trait)) {
      await window.api.yachiyo.deleteSoulTrait({ trait })
    }
  }

  for (const trait of draftTraits) {
    if (!savedSet.has(trait)) {
      await window.api.yachiyo.addSoulTrait({ trait })
    }
  }

  return window.api.yachiyo.getSoulDocument()
}
