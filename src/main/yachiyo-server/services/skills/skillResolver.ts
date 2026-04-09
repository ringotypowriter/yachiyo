import type {
  SkillCatalogEntry,
  SkillSummary,
  SettingsConfig
} from '../../../../shared/yachiyo/protocol.ts'
import { normalizeSkillNames } from '../../../../shared/yachiyo/protocol.ts'

function toSummary(skill: SkillCatalogEntry): SkillSummary {
  return {
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {})
  }
}

export function resolveActiveSkills(input: {
  availableSkills: SkillCatalogEntry[]
  config: SettingsConfig
  enabledSkillNames?: string[]
}): SkillSummary[] {
  const skillByName = new Map(input.availableSkills.map((skill) => [skill.name, skill] as const))
  const disabledNames = new Set(normalizeSkillNames(input.config.skills?.disabled, []))

  const requestedNames = normalizeSkillNames(
    input.enabledSkillNames ?? input.config.skills?.enabled,
    []
  )

  const result = new Map<string, SkillSummary>()

  for (const skill of input.availableSkills) {
    if (skill.autoEnabled && !disabledNames.has(skill.name)) {
      result.set(skill.name, toSummary(skill))
    }
  }

  for (const name of requestedNames) {
    if (result.has(name)) continue
    const skill = skillByName.get(name)
    if (skill) {
      result.set(name, toSummary(skill))
    }
  }

  return [...result.values()]
}
