import type { SkillCatalogEntry } from '../../../../shared/yachiyo/protocol.ts'

import type { DiscoveredSkill } from './skillDiscovery.ts'

export function buildSkillRegistry(discoveredSkills: DiscoveredSkill[]): SkillCatalogEntry[] {
  const registry: SkillCatalogEntry[] = []
  const seenNames = new Set<string>()

  for (const skill of discoveredSkills) {
    if (seenNames.has(skill.name)) {
      continue
    }

    seenNames.add(skill.name)
    registry.push({
      name: skill.name,
      description: skill.description,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath
    })
  }

  return registry
}
