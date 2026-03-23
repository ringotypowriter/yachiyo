import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

import type { SkillCatalogEntry } from '../../../../shared/yachiyo/protocol.ts'
import { resolveYachiyoDataDir } from '../../config/paths.ts'

export const SKILL_FILE_NAME = 'SKILL.md'

const SKILL_SOURCE_DIR_NAMES = ['.yachiyo', '.codex', '.agents', '.claude'] as const

export interface SkillDiscoveryRoot {
  scope: 'workspace' | 'home'
  rootPath: string
}

export interface DiscoveredSkill extends SkillCatalogEntry {
  scope: SkillDiscoveryRoot['scope']
  rootPath: string
}

interface ParsedFrontmatter {
  body: string
  data: Record<string, string>
}

function normalizeString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

function unquoteFrontmatterValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }

  return trimmed
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  if (!content.startsWith('---\n')) {
    return {
      body: content,
      data: {}
    }
  }

  const endIndex = content.indexOf('\n---\n', 4)
  if (endIndex < 0) {
    return {
      body: content,
      data: {}
    }
  }

  const data: Record<string, string> = {}
  const rawFrontmatter = content.slice(4, endIndex)

  for (const rawLine of rawFrontmatter.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const separatorIndex = line.indexOf(':')
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    const value = unquoteFrontmatterValue(line.slice(separatorIndex + 1))
    if (!key || !value) {
      continue
    }

    data[key] = value
  }

  return {
    body: content.slice(endIndex + '\n---\n'.length),
    data
  }
}

function extractHeadingName(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    const headingMatch = /^#\s+(.+)$/u.exec(line)
    if (headingMatch) {
      return normalizeString(headingMatch[1])
    }

    return undefined
  }

  return undefined
}

function extractBodySummary(body: string): string | undefined {
  const paragraphs = body
    .split(/\n\s*\n/u)
    .map((paragraph) =>
      paragraph
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .join(' ')
        .trim()
    )
    .filter(Boolean)

  return normalizeString(paragraphs[0])
}

async function collectSkillFiles(rootPath: string): Promise<string[]> {
  let entries

  try {
    entries = await readdir(rootPath, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }

  const discovered: string[] = []

  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)

    if (entry.isDirectory()) {
      discovered.push(...(await collectSkillFiles(entryPath)))
      continue
    }

    if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      discovered.push(entryPath)
    }
  }

  return discovered
}

async function readSkillRecord(input: {
  scope: SkillDiscoveryRoot['scope']
  rootPath: string
  skillFilePath: string
}): Promise<DiscoveredSkill | null> {
  let content: string

  try {
    content = await readFile(input.skillFilePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }

  const skillFilePath = resolve(input.skillFilePath)
  const directoryPath = resolve(dirname(skillFilePath))
  const { body, data } = parseFrontmatter(content)
  const name =
    normalizeString(data['name']) ??
    normalizeString(data['title']) ??
    extractHeadingName(body) ??
    normalizeString(basename(directoryPath))

  if (!name) {
    return null
  }

  return {
    name,
    description:
      normalizeString(data['description']) ??
      normalizeString(data['summary']) ??
      extractBodySummary(body),
    directoryPath,
    skillFilePath,
    scope: input.scope,
    rootPath: resolve(input.rootPath)
  }
}

export function buildSkillDiscoveryRoots(workspacePaths: string[] = []): SkillDiscoveryRoot[] {
  const roots: SkillDiscoveryRoot[] = []
  const seen = new Set<string>()
  const normalizedWorkspacePaths = [
    ...new Set(
      workspacePaths
        .map((path) => path.trim())
        .filter(Boolean)
        .map((path) => resolve(path))
    )
  ]

  for (const workspacePath of normalizedWorkspacePaths) {
    for (const dirName of SKILL_SOURCE_DIR_NAMES) {
      const rootPath = resolve(join(workspacePath, dirName, 'skills'))
      if (seen.has(rootPath)) {
        continue
      }
      seen.add(rootPath)
      roots.push({
        scope: 'workspace',
        rootPath
      })
    }
  }

  const homeRoots = [
    resolve(join(resolveYachiyoDataDir(), 'skills')),
    ...SKILL_SOURCE_DIR_NAMES.filter((dirName) => dirName !== '.yachiyo').map((dirName) =>
      resolve(join(homedir(), dirName, 'skills'))
    )
  ]

  for (const rootPath of homeRoots) {
    if (seen.has(rootPath)) {
      continue
    }
    seen.add(rootPath)
    roots.push({
      scope: 'home',
      rootPath
    })
  }

  return roots
}

export async function discoverSkills(workspacePaths: string[] = []): Promise<DiscoveredSkill[]> {
  const discovered: DiscoveredSkill[] = []

  for (const root of buildSkillDiscoveryRoots(workspacePaths)) {
    let skillFilePaths: string[]

    try {
      skillFilePaths = await collectSkillFiles(root.rootPath)
    } catch (error) {
      console.warn('[yachiyo][skills] failed to scan root', {
        error: error instanceof Error ? error.message : String(error),
        rootPath: root.rootPath
      })
      continue
    }

    for (const skillFilePath of skillFilePaths) {
      try {
        const skill = await readSkillRecord({
          scope: root.scope,
          rootPath: root.rootPath,
          skillFilePath
        })

        if (skill) {
          discovered.push(skill)
        }
      } catch (error) {
        console.warn('[yachiyo][skills] failed to read skill', {
          error: error instanceof Error ? error.message : String(error),
          skillFilePath
        })
      }
    }
  }

  return discovered
}
