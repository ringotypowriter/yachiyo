import { readFile } from 'node:fs/promises'

import { tool, type Tool } from 'ai'

import type {
  SkillCatalogEntry,
  SkillsReadToolCallDetails
} from '../../../../shared/yachiyo/protocol.ts'
import {
  type AgentToolContext,
  type SkillsReadToolInput,
  type SkillsReadToolOutput,
  skillsReadToolInputSchema,
  textContent,
  toToolModelOutput
} from './shared.ts'

function buildModelContent(details: SkillsReadToolCallDetails): string {
  const lines: string[] = []

  if (details.skills.length === 0) {
    lines.push('No matching skills were found.')
  }

  for (const skill of details.skills) {
    lines.push(`Skill: ${skill.name}`)
    lines.push(`Directory: ${skill.directoryPath}`)
    lines.push(`File: ${skill.skillFilePath}`)
    if (skill.description) {
      lines.push(`Description: ${skill.description}`)
    }
    if (skill.content !== undefined) {
      lines.push('', skill.content)
    }
    lines.push('')
  }

  if (details.missingNames && details.missingNames.length > 0) {
    lines.push(`Missing: ${details.missingNames.join(', ')}`)
  }

  return lines.join('\n').trim()
}

function createSkillsReadResult(
  details: SkillsReadToolCallDetails,
  error?: string
): SkillsReadToolOutput {
  const message = error ?? buildModelContent(details)

  return {
    content: textContent(message),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

export function createTool(
  _context: AgentToolContext,
  dependencies: {
    availableSkills: SkillCatalogEntry[]
  }
): Tool<SkillsReadToolInput, SkillsReadToolOutput> {
  return tool({
    description:
      'Read discovered Skills by name. Returns the skill name, directory path, SKILL.md path, and any concise description by default. Set includeContent to true only when you need the full SKILL.md text.',
    inputSchema: skillsReadToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input) => runSkillsReadTool(input, dependencies)
  })
}

export async function runSkillsReadTool(
  input: SkillsReadToolInput,
  dependencies: {
    availableSkills: SkillCatalogEntry[]
  }
): Promise<SkillsReadToolOutput> {
  const availableSkillByName = new Map(
    dependencies.availableSkills.map((skill) => [skill.name, skill] as const)
  )
  const resolvedSkills: SkillsReadToolCallDetails['skills'] = []
  const missingNames: string[] = []

  for (const requestedName of input.names) {
    const skill = availableSkillByName.get(requestedName.trim())
    if (!skill) {
      missingNames.push(requestedName.trim())
      continue
    }

    let content: string | undefined
    if (input.includeContent) {
      content = await readFile(skill.skillFilePath, 'utf8')
    }

    resolvedSkills.push({
      name: skill.name,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      ...(skill.description ? { description: skill.description } : {}),
      ...(content !== undefined ? { content } : {})
    })
  }

  return createSkillsReadResult({
    requestedNames: input.names,
    resolvedCount: resolvedSkills.length,
    skills: resolvedSkills,
    ...(missingNames.length > 0 ? { missingNames } : {})
  })
}
