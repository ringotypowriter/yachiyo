import type { SkillPlatform } from '@yachiyo/shared/protocol'

export interface CoreSkillPlatformMetadata {
  name: string
  platforms?: readonly SkillPlatform[]
}

export function selectNewCompatibleCoreSkillNames(
  skills: readonly CoreSkillPlatformMetadata[],
  previouslyRegisteredNames: readonly string[],
  platform: NodeJS.Platform
): string[] {
  const previouslyRegistered = new Set(previouslyRegisteredNames)
  return skills
    .filter(
      (skill) =>
        !previouslyRegistered.has(skill.name) &&
        (!skill.platforms || skill.platforms.includes(platform as SkillPlatform))
    )
    .map((skill) => skill.name)
}
