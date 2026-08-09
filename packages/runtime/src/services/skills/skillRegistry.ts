import type { SkillCatalogEntry, SkillPlatform } from '@yachiyo/shared/protocol'

import type { DiscoveredSkill } from './skillDiscovery.ts'

export function buildSkillRegistry(
  discoveredSkills: DiscoveredSkill[],
  options: { platform: NodeJS.Platform }
): SkillCatalogEntry[] {
  const registry: SkillCatalogEntry[] = []
  const seenNames = new Set<string>()

  for (const skill of discoveredSkills) {
    if (skill.platforms && !skill.platforms.includes(options.platform as SkillPlatform)) {
      continue
    }
    if (seenNames.has(skill.name)) {
      continue
    }

    seenNames.add(skill.name)
    registry.push({
      name: skill.name,
      description: skill.description,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      ...(skill.autoEnabled ? { autoEnabled: true } : {}),
      ...(skill.origin ? { origin: skill.origin } : {}),
      ...(skill.platforms ? { platforms: skill.platforms } : {})
    })
  }

  return registry
}
