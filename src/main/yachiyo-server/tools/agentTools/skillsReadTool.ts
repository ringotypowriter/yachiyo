import { readFile } from 'node:fs/promises'

import { tool, type Tool } from 'ai'

import type {
  SkillCatalogEntry,
  SkillsReadToolCallDetails
} from '../../../../shared/yachiyo/protocol.ts'
import { rewriteRelativeMarkdownLinks } from '../../services/skills/skillContent.ts'
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
    lines.push(`Skill folder: ${skill.directoryPath}`)
    lines.push(`SKILL.md: ${skill.skillFilePath}`)
    if (skill.origin) {
      lines.push(`Origin: ${skill.origin}`)
    }
    if (skill.description) {
      lines.push(`Description: ${skill.description}`)
    }
    if (skill.content !== undefined) {
      lines.push('', skill.content)
    } else {
      lines.push('Use the read tool on SKILL.md if you need the full instructions.')
    }
    lines.push(
      'Any referenced files are relative to the skill folder; use absolute paths under that folder when reading them.'
    )
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
    execute: (input, options) => runSkillsReadTool(input, dependencies, options)
  })
}

export async function runSkillsReadTool(
  input: SkillsReadToolInput,
  dependencies: {
    availableSkills: SkillCatalogEntry[]
  },
  options: { abortSignal?: AbortSignal } = {}
): Promise<SkillsReadToolOutput> {
  const abortSignal = options.abortSignal
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
      const rawContent = await readFile(skill.skillFilePath, {
        encoding: 'utf8',
        signal: abortSignal
      })
      content = rewriteRelativeMarkdownLinks(rawContent, skill.directoryPath)
    }

    resolvedSkills.push({
      name: skill.name,
      directoryPath: skill.directoryPath,
      skillFilePath: skill.skillFilePath,
      ...(skill.description ? { description: skill.description } : {}),
      ...(skill.origin ? { origin: skill.origin } : {}),
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
