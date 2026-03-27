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
