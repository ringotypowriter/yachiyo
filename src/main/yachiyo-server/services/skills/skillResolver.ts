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
  const hasComposerOverride = input.enabledSkillNames !== undefined

  const result = new Map<string, SkillSummary>()

  if (hasComposerOverride) {
    // Composer override is the complete truth — only include what it lists.
    for (const name of normalizeSkillNames(input.enabledSkillNames, [])) {
      const skill = skillByName.get(name)
      if (skill) {
        result.set(name, toSummary(skill))
      }
    }
  } else {
    // Settings defaults: auto-enabled skills + explicitly enabled, minus disabled.
    const disabledNames = new Set(normalizeSkillNames(input.config.skills?.disabled, []))

    for (const skill of input.availableSkills) {
      if (skill.autoEnabled && !disabledNames.has(skill.name)) {
        result.set(skill.name, toSummary(skill))
      }
    }

    for (const name of normalizeSkillNames(input.config.skills?.enabled, [])) {
      if (result.has(name)) continue
      const skill = skillByName.get(name)
      if (skill) {
        result.set(name, toSummary(skill))
      }
    }
  }

  return [...result.values()]
}
