import type {
  SkillCatalogEntry,
  SkillSummary,
  SettingsConfig
} from '../../../../shared/yachiyo/protocol.ts'
import { normalizeSkillNames } from '../../../../shared/yachiyo/protocol.ts'

export function resolveActiveSkills(input: {
  availableSkills: SkillCatalogEntry[]
  config: SettingsConfig
  enabledSkillNames?: string[]
}): SkillSummary[] {
  const requestedNames = normalizeSkillNames(
    input.enabledSkillNames ?? input.config.skills?.enabled,
    []
  )

  if (requestedNames.length === 0) {
    return []
  }

  const skillByName = new Map(input.availableSkills.map((skill) => [skill.name, skill] as const))

  return requestedNames.flatMap((name) => {
    const skill = skillByName.get(name)
    return skill
      ? [
          {
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {})
          }
        ]
      : []
  })
}
