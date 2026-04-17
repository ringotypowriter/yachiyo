import type { SkillCatalogEntry } from '../../../shared/yachiyo/protocol.ts'

export function filterSkills(
  skills: readonly SkillCatalogEntry[],
  query: string
): SkillCatalogEntry[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return [...skills]
  }

  return skills.filter((skill) => {
    if (skill.name.toLowerCase().includes(normalizedQuery)) {
      return true
    }

    return skill.description?.toLowerCase().includes(normalizedQuery) ?? false
  })
}

export function sortSkills(
  skills: readonly SkillCatalogEntry[],
  isEnabled: (skill: SkillCatalogEntry) => boolean
): SkillCatalogEntry[] {
  return [...skills].sort((a, b) => {
    const aEnabled = isEnabled(a) ? 0 : 1
    const bEnabled = isEnabled(b) ? 0 : 1
    if (aEnabled !== bEnabled) return aEnabled - bEnabled

    const aYachiyo = a.name.startsWith('yachiyo-') ? 0 : 1
    const bYachiyo = b.name.startsWith('yachiyo-') ? 0 : 1
    if (aYachiyo !== bYachiyo) return aYachiyo - bYachiyo

    return a.name.localeCompare(b.name)
  })
}
